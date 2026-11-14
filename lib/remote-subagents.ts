import "server-only";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import type { SubagentProfile, SubagentWritableScope } from "@/lib/subagents";
import {
  assertSubagentProfileName,
  builtInSubagentProfilesFor,
  composeSubagentProfileDocument,
  parseSubagentProfileDocument,
} from "@/lib/subagents";
import { parseFrontmatter } from "@/lib/frontmatter";
import { readRemoteFiles, writeRemoteFile } from "@/lib/remote-settings-file";
import { shellQuote } from "@/lib/shell-quote";

/**
 * Writing a device's subagent profiles over the gateway.
 *
 * The document is rendered by the same code this host's save runs
 * (`composeSubagentProfileDocument`), against the device file's own stored
 * frontmatter, so a remote save produces the bytes a local one would — managed
 * keys rewritten, keys another runtime owns carried through. The file lands at
 * the device's own profile path (`<agentDir>/agents`, `<cwd>/.pi/agents`),
 * which is what the device's `pi` loads.
 */

/** Where the device keeps a profile of one scope — the read path's layout. */
export function remoteSubagentProfilePath(
  agentDir: string,
  cwd: string,
  scope: SubagentWritableScope,
  name: string,
): string {
  return scope === "global"
    ? `${agentDir}/agents/${name}.md`
    : `${cwd}/.pi/agents/${name}.md`;
}

async function readStoredFrontmatterRemote(
  driver: IHostDriver,
  filePath: string,
): Promise<Record<string, unknown>> {
  const files = await readRemoteFiles(driver, [filePath]);
  const text = files.get(filePath);
  if (text === undefined) return {};
  const { data } = parseFrontmatter(text);
  if (data) return data;
  throw new Error("Cannot save agent profile: existing frontmatter is invalid");
}

/** Create or update one profile file on the device; answers the saved profile. */
export async function writeRemoteSubagentProfile(
  driver: IHostDriver,
  options: {
    agentDir: string;
    cwd: string;
    scope: SubagentWritableScope;
    profile: Omit<SubagentProfile, "scope" | "filePath">;
  },
): Promise<SubagentProfile> {
  const name = assertSubagentProfileName(options.profile.name);
  const filePath = remoteSubagentProfilePath(options.agentDir, options.cwd, options.scope, name);
  const stored = await readStoredFrontmatterRemote(driver, filePath);
  const composed = composeSubagentProfileDocument(stored, options.profile);
  await writeRemoteFile(driver, filePath, composed.document);
  return { ...composed.profile, scope: options.scope, filePath };
}

/** Flip `enabled` on one device profile, or on a built-in via the device's own settings file. */
export async function toggleRemoteSubagentProfile(
  driver: IHostDriver,
  options: {
    agentDir: string;
    cwd: string;
    scope: SubagentWritableScope | "builtin";
    name: string;
    enabled: boolean;
  },
): Promise<SubagentProfile> {
  if (options.scope === "builtin") {
    // A built-in has no file: its off state is its name in the device's own
    // `agents/settings.json`, the same file `writeDisabledBuiltInSubagent`
    // manages here. The writers take a path, so the edit runs on a local copy
    // of the device's file and the result goes back byte-for-byte.
    const settingsPath = `${options.agentDir}/agents/settings.json`;
    const stored = await withRemoteSettingsFile(driver, settingsPath, async (tempPath) => {
      const { writeDisabledBuiltInSubagent } = await import("@/lib/subagent-settings");
      writeDisabledBuiltInSubagent(options.name, !options.enabled, tempPath);
    });
    const disabledNames = Array.isArray(stored?.disabledBuiltIns)
      ? stored!.disabledBuiltIns.filter((entry): entry is string => typeof entry === "string")
      : [];
    const source = builtInSubagentProfilesFor(disabledNames)
      .find((profile) => profile.name.toLowerCase() === options.name.trim().toLowerCase());
    if (!source) throw new Error("Agent profile not found");
    return { ...source, enabled: options.enabled };
  }
  const name = assertSubagentProfileName(options.name);
  const filePath = remoteSubagentProfilePath(options.agentDir, options.cwd, options.scope, name);
  const files = await readRemoteFiles(driver, [filePath]);
  const text = files.get(filePath);
  if (text === undefined) throw new Error("Agent profile not found");
  const source = parseSubagentProfileDocument(text, filePath, options.scope);
  if (!source) throw new Error("Agent profile not found");
  const composed = composeSubagentProfileDocument(parseFrontmatter(text).data ?? {}, {
    ...source,
    enabled: options.enabled,
  });
  await writeRemoteFile(driver, filePath, composed.document);
  return { ...composed.profile, scope: options.scope, filePath };
}

/**
 * Flip the built-in subagents switch and/or the concurrency limit in the
 * device's own `agents/settings.json`.
 *
 * The local writers take a settings path, so the edit runs on a downloaded copy
 * of the device's file and the saved bytes go back — no reimplementation of the
 * file's rules on this side.
 */
export async function writeRemoteSubagentSettings(
  deviceId: string,
  changes: { enabled?: boolean; maxConcurrent?: number },
): Promise<{ enabled: boolean; maxConcurrent: number }> {
  const { getGateway } = await import("@/lib/gateway/singleton");
  const { getRemoteAgentDir } = await import("@/lib/remote-settings");
  const driver = getGateway().getOnlineDriver(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const settingsPath = `${agentDir}/agents/settings.json`;
  await withRemoteSettingsFile(driver, settingsPath, async (tempPath) => {
    const { writeBuiltInSubagentsEnabled, writeSubagentMaxConcurrent } = await import(
      "@/lib/subagent-settings"
    );
    if (changes.enabled !== undefined) writeBuiltInSubagentsEnabled(changes.enabled, tempPath);
    if (changes.maxConcurrent !== undefined) writeSubagentMaxConcurrent(changes.maxConcurrent, tempPath);
  });
  // Answer from the bytes that reached the device, through the same reader the
  // local route uses, so both paths report the same shapes.
  const { readSubagentSettings } = await import("@/lib/subagent-settings");
  const { mkdtempSync, rmSync, writeFileSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const tempDir = mkdtempSync(join(tmpdir(), "pi-web-remote-subagents-"));
  try {
    const files = await readRemoteFiles(driver, [settingsPath]);
    writeFileSync(join(tempDir, "settings.json"), files.get(settingsPath) ?? "", "utf8");
    const saved = readSubagentSettings(join(tempDir, "settings.json"));
    return { enabled: saved.builtInEnabled, maxConcurrent: saved.maxConcurrent };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Remove one profile file from the device. */
export async function deleteRemoteSubagentProfile(
  driver: IHostDriver,
  options: { agentDir: string; cwd: string; scope: SubagentWritableScope; name: string },
): Promise<void> {
  const name = assertSubagentProfileName(options.name);
  const filePath = remoteSubagentProfilePath(options.agentDir, options.cwd, options.scope, name);
  const result = await driver.exec(`rm -f ${shellQuote(filePath)}`);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Failed to remove ${filePath}`);
  }
}

/**
 * Run one edit against a local copy of a device file, then put the file back.
 *
 * The local copy starts from the device's bytes (or an empty file when the
 * device has none, which is what the local writers expect) and is removed
 * afterwards, so a failed upload never leaves a half-synced local artifact.
 */
export async function withRemoteSettingsFile(
  driver: IHostDriver,
  remotePath: string,
  edit: (localPath: string) => Promise<void>,
): Promise<Record<string, unknown> | undefined> {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const tempDir = mkdtempSync(join(tmpdir(), "pi-web-remote-subagents-"));
  const tempPath = join(tempDir, "settings.json");
  try {
    const files = await readRemoteFiles(driver, [remotePath]);
    const text = files.get(remotePath);
    if (text !== undefined) writeFileSync(tempPath, text, "utf8");
    await edit(tempPath);
    const updated = existsSync(tempPath) ? readFileSync(tempPath, "utf8") : null;
    if (updated !== null) {
      await writeRemoteFile(driver, remotePath, updated);
      try {
        return JSON.parse(updated) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
