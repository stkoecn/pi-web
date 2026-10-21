import "server-only";
import { getGateway } from "@/lib/gateway/singleton";
import { getRemoteAgentDir } from "@/lib/remote-settings";
import { shellQuote } from "@/lib/shell-quote";
import {
  mergeDefaultPreferences,
  parseSettingsObject,
  readDefaultsFromSettings,
  serializeSettings,
  shadowingRemoteProjectKeys,
  writtenKeys,
} from "@/lib/remote-settings-merge";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import type { DefaultPreferencesEdit } from "@/lib/default-preferences";

/**
 * The defaults a *remote* device's new sessions start with.
 *
 * pi's RPC mode has no settings command (its `set_model` deliberately does not
 * persist), so the only way to change a default is to edit the device's own
 * `~/.pi/agent/settings.json`. That is exactly what `SettingsManager` does when
 * the TUI's Ctrl+S fires: it merges the modified top-level keys into the file it
 * loaded and leaves everything else — unknown keys, key order, formatting — as it
 * found it. The write here follows the same contract, because this file also
 * holds hand-written settings a rewrite would silently drop.
 */

export interface RemoteDefaultPreferencesResult {
  settingsPath: string;
  written: string[];
}

export class RemoteSettingsUnreadableError extends Error {
  constructor(readonly settingsPath: string, readonly reason: string) {
    super(`${settingsPath} could not be read: ${reason}`);
    this.name = "RemoteSettingsUnreadableError";
  }
}

export class RemoteProjectScopeError extends Error {
  constructor(readonly settingsPath: string, readonly keys: string[]) {
    super(`${settingsPath} sets ${keys.join(", ")} for this project, so a global default would not apply here.`);
    this.name = "RemoteProjectScopeError";
  }
}

/**
 * Read several files in ONE round trip.
 *
 * A second round trip to `/api/models/default` costs 250-900 ms on a WAN device
 * (one RTT), and this route needs both the global settings file and the
 * project's, so they travel together. Each section is delimited by a marker line
 * holding the index; a missing file simply has no section.
 */
async function readFilesAtOnce(
  driver: IHostDriver,
  paths: readonly string[],
  timeoutMs = 20_000,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (paths.length === 0) return found;
  const marker = "@@piweb-file@@";
  const script = paths
    .map((path, index) => {
      const quoted = shellQuote(path);
      return [
        `if [ -f ${quoted} ]; then`,
        `  printf '%s%s\\n' '${marker}' '${index}'`,
        `  cat ${quoted}`,
        `  printf '\\n'`,
        `fi`,
      ].join("\n");
    })
    .join("\n");
  const result = await driver.exec(
    `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
    [],
    { timeoutMs },
  );
  if (result.exitCode !== 0) return found;
  const pattern = new RegExp(`^${marker}(\\d+)$`);
  let current: { path: string; lines: string[] } | null = null;
  for (const line of result.stdout.split("\n")) {
    const match = pattern.exec(line);
    if (match) {
      if (current) found.set(current.path, current.lines.join("\n"));
      const path = paths[Number(match[1])];
      current = path === undefined ? null : { path, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) found.set(current.path, current.lines.join("\n"));
  return found;
}

/**
 * Save the model and/or reasoning level a remote device's new sessions start
 * with.
 *
 * Refuses instead of guessing when the device's settings file cannot be parsed:
 * the merge would either drop what it could not read or overwrite it, and either
 * way the user's other settings would be the casualty.
 */
export async function writeRemoteDefaultPreferences(
  deviceId: string,
  edit: DefaultPreferencesEdit,
  options: { cwd?: string | null } = {},
): Promise<RemoteDefaultPreferencesResult> {
  const agentDir = await getRemoteAgentDir(deviceId);
  const settingsPath = `${agentDir}/settings.json`;
  const projectPath = options.cwd ? `${options.cwd.replace(/\/+$/, "")}/.pi/settings.json` : null;
  const driver = getGateway().getOnlineDriver(deviceId);

  const files = await readFilesAtOnce(driver, projectPath ? [settingsPath, projectPath] : [settingsPath]);
  const globalText = files.get(settingsPath);
  const globalRead = globalText === undefined ? { value: null } : parseSettingsObject(globalText);
  if (globalRead.error) throw new RemoteSettingsUnreadableError(settingsPath, globalRead.error);

  if (projectPath) {
    const projectText = files.get(projectPath);
    const projectValue = projectText === undefined ? null : parseSettingsObject(projectText).value;
    const shadowed = shadowingRemoteProjectKeys(projectValue, edit);
    if (shadowed.length > 0) throw new RemoteProjectScopeError(projectPath, shadowed);
  }

  const merged = mergeDefaultPreferences(globalRead.value, edit);
  // Keep the trailing-newline habit of the file we are replacing: JSON.stringify
  // never emits one, and dropping it turns a one-key edit into a diff that also
  // rewrites the last line.
  const contents = serializeSettings(merged);

  // Written through a temp file in the same directory and then copied over the
  // original: `mv` would replace the inode and lose the file's mode (pi's own
  // settings storage does a plain `writeFileSync`, but a half-written settings
  // file makes every later session on that device fail to load, so the extra
  // step is worth it here). `cat >` keeps the mode and stays a single write for
  // a file this small.
  const quotedPath = shellQuote(settingsPath);
  const quotedDir = shellQuote(agentDir);
  const tmpPath = `${agentDir}/settings.json.piweb-${Date.now()}.tmp`;
  const quotedTmp = shellQuote(tmpPath);
  const payload = Buffer.from(contents, "utf8").toString("base64");
  const script = [
    `mkdir -p ${quotedDir} || exit 4`,
    `printf %s ${shellQuote(payload)} | base64 -d > ${quotedTmp} || exit 5`,
    `cat ${quotedTmp} > ${quotedPath} || { rm -f ${quotedTmp}; exit 6; }`,
    `rm -f ${quotedTmp} || exit 7`,
  ].join("\n");
  const result = await driver.exec(
    `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
    [],
    { timeoutMs: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `Failed to write ${settingsPath} (exit ${result.exitCode})`,
    );
  }

  return { settingsPath, written: writtenKeys(edit) };
}

/**
 * The defaults the device's own settings file names, if any.
 *
 * Read straight from the file rather than from a live session's state: the file
 * is what a *new* session starts with, and the two can differ (a session started
 * with `--model`, or one still running after the default changed). A file that
 * cannot be parsed answers `null` so the caller can fall back instead of
 * reporting a default it cannot vouch for.
 */
export async function readRemoteDefaultPreferences(deviceId: string): Promise<{
  settingsPath: string;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
} | null> {
  const agentDir = await getRemoteAgentDir(deviceId);
  const settingsPath = `${agentDir}/settings.json`;
  const driver = getGateway().getOnlineDriver(deviceId);
  const files = await readFilesAtOnce(driver, [settingsPath], 15_000);
  const text = files.get(settingsPath);
  const read = text === undefined ? { value: null } : parseSettingsObject(text);
  if (read.error) return null;
  return { settingsPath, ...readDefaultsFromSettings(read.value) };
}
