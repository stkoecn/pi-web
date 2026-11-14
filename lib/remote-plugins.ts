import "server-only";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginScope,
  PluginsResponse,
  PluginToggleResult,
} from "@/lib/api-types";
import {
  applyPackagesDisabled,
  configuredVersionOf,
  FILTERED_PACKAGE_ERROR,
  isDisabledPackage,
} from "@/lib/plugin-entries";
import { isPluginSourceCheckable } from "@/lib/plugin-updates";
import { parseNpmSource } from "@/lib/npm-source";
import { readRemoteFiles, writeRemoteFile } from "@/lib/remote-settings-file";
import { getRemoteAgentDir, invalidateRemoteSettings } from "@/lib/remote-settings";

/**
 * Settings › Plugins for a device, and the writes behind its buttons.
 *
 * A device's packages live in its own two `settings.json` files, exactly as they
 * do here, and pi on the device reads nothing else. So the list is read from
 * those files and the switches rewrite them — one round trip for the read, one
 * for the write — instead of driving the device's CLI, which prints a package
 * list as prose and has no JSON mode.
 *
 * What an entry means is `lib/plugin-entries.ts`'s business, shared with the
 * local route, so a switch made here writes the same bytes the local one would.
 *
 * Installing, removing and updating are not settings edits: they run the
 * package manager, resolve a source, fetch it and write a lockfile. Those are
 * asked of the device's own `pi` CLI, which is the same code this host runs.
 */

const WRITE_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 5 * 60_000;

/** How the device names the scope pi stores a package under. */
type DeviceScope = "global" | "project";

function deviceSettingsPath(agentDir: string, cwd: string, scope: DeviceScope): string {
  return scope === "global" ? `${agentDir}/settings.json` : `${cwd}/.pi/settings.json`;
}

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

/** A settings body as a plain object, or undefined when it is absent or unusable. */
export function parseRemoteSettingsFile(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The `packages` list of a settings object, ignoring anything that is not one. */
export function remotePackageEntries(settings: Record<string, unknown> | undefined): unknown[] {
  const raw = settings?.packages;
  return Array.isArray(raw) ? raw : [];
}

/** One `packages` entry as the two things the panel needs from it. */
export function readRemotePackageEntry(entry: unknown): { source: string; disabled: boolean; filtered: boolean } | undefined {
  const source = typeof entry === "string"
    ? entry
    : entry && typeof entry === "object" && "source" in entry
      ? String((entry as { source?: unknown }).source ?? "")
      : "";
  if (!source) return undefined;
  // `isDisabledPackage` speaks pi's own `PackageSource` shape; an entry read out
  // of JSON is that shape already, only without the type.
  const typed = entry as Parameters<typeof isDisabledPackage>[0];
  return {
    source,
    disabled: isDisabledPackage(typed),
    filtered: typeof entry === "object" && !isDisabledPackage(typed),
  };
}

/**
 * Every package either settings file configures, global first.
 *
 * `settings.json` is where pi records a package, so this is the whole list; a
 * package whose files are missing is reported as such rather than hidden, which
 * is what the pane's "missing" state means.
 */
export function readRemotePackages(
  globalSettings: Record<string, unknown> | undefined,
  projectSettings: Record<string, unknown> | undefined,
): PluginPackageInfo[] {
  const packages: PluginPackageInfo[] = [];
  for (const [scope, settings] of [
    ["global", globalSettings],
    ["project", projectSettings],
  ] as const) {
    for (const entry of remotePackageEntries(settings)) {
      const read = readRemotePackageEntry(entry);
      if (!read) continue;
      packages.push({
        source: read.source,
        scope,
        canCheckForUpdates: isPluginSourceCheckable(read.source),
        filtered: read.filtered,
        disabled: read.disabled,
        // Whether the package is on disk, and what it holds, needs the device's
        // package manager; the pane shows the configured source and scope until
        // it asks for an update, which is the only thing that needs the path.
        installedPath: undefined,
        packageName: undefined,
        version: undefined,
        configuredVersion: configuredVersionOf(read.source),
        description: undefined,
        counts: emptyCounts(),
        resources: [],
        status: read.disabled ? "disabled" : "installed",
      });
    }
  }
  return packages;
}

/**
 * Read the device's plugin list; one round trip for both settings files.
 *
 * `projectResourcesLoaded` is the device's own trust decision, which the caller
 * reads because it also has the device id: pi on that machine loads the project
 * `settings.json` only while the folder is trusted, so the pane must not offer
 * project switches the device would ignore.
 */
export async function readRemotePluginList(
  driver: IHostDriver,
  agentDir: string,
  cwd: string,
  { projectResourcesLoaded = true }: { projectResourcesLoaded?: boolean } = {},
): Promise<PluginsResponse> {
  const globalPath = deviceSettingsPath(agentDir, cwd, "global");
  const projectPath = deviceSettingsPath(agentDir, cwd, "project");
  const files = await readRemoteFiles(driver, [globalPath, projectPath], WRITE_TIMEOUT_MS);
  const globalSettings = parseRemoteSettingsFile(files.get(globalPath));
  const projectSettings = parseRemoteSettingsFile(files.get(projectPath));
  const diagnostics: PluginDiagnostic[] = [];
  // A settings file that exists but does not parse hides its packages; saying so
  // is better than reporting an empty list the user cannot explain.
  for (const [scope, path] of [["global", globalPath], ["project", projectPath]] as const) {
    if (files.has(path) && parseRemoteSettingsFile(files.get(path)) === undefined) {
      diagnostics.push({ type: "error", source: path, message: `${path} could not be read as a settings file` });
    }
  }
  const packages = readRemotePackages(globalSettings, projectSettings);
  // The settings list alone reads as if nothing were installed: the detail view
  // showed "未找到" for every install path and zeros for every count. The probe
  // asks the device what pi's own loader would resolve, one round trip for all.
  const probed = await probeRemotePackages(driver, agentDir, packages);
  let totals = emptyCounts();
  for (const pkg of packages) {
    const probe = probed.get(pkg.source);
    if (!probe) continue;
    pkg.installedPath = probe.installedPath;
    pkg.packageName = probe.packageName;
    pkg.version = probe.version;
    pkg.description = probe.description;
    if (!pkg.disabled) {
      // A disabled package's resources never load, so they stay uncounted — the
      // same rule the local route applies to its loader's answers.
      pkg.counts = probe.counts;
      totals = {
        extensions: totals.extensions + probe.counts.extensions,
        skills: totals.skills + probe.counts.skills,
        prompts: totals.prompts + probe.counts.prompts,
        themes: totals.themes + probe.counts.themes,
      };
    }
    const resourceCount = pkg.counts.extensions + pkg.counts.skills + pkg.counts.prompts + pkg.counts.themes;
    if (!pkg.disabled && !probe.exists) {
      // The local route's wording: a configured source the device cannot resolve.
      diagnostics.push({ type: "warning", source: pkg.source, message: "Configured package path was not found." });
    }
    pkg.status = pkg.disabled ? "disabled" : resourceCount > 0 ? "loaded" : pkg.installedPath ? "installed" : "missing";
  }
  return {
    packages,
    standaloneExtensions: [],
    totals,
    diagnostics,
    projectResourcesLoaded,
    ...({ remote: { deviceId: driver.deviceId, source: "file" } } as object),
  } as PluginsResponse;
}

/** What the device answered for one npm package: pi's loader facts, as numbers. */
export interface RemotePackageProbe {
  exists: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  description?: string;
  counts: PluginResourceCounts;
}

/**
 * The probe the device runs for every configured npm package at once.
 *
 * Plain JS, delivered base64 in `PIWEB_PKGS` like the other device scripts. The
 * resource counts mirror pi's package-manager conventions: extensions come from
 * the manifest's `pi.extensions` list, else a root `index.ts` / `index.js`, else
 * a recursive scan of `extensions/`; skills are `skills/` directories holding a
 * `SKILL.md`; prompts and themes are their directories' `.md` / `.json` files.
 */
const REMOTE_PACKAGE_PROBE_SCRIPT = `
const fs = require('fs');
const path = require('path');
const input = JSON.parse(Buffer.from(process.env.PIWEB_PKGS || '', 'base64').toString('utf8'));
const walk = (dir, pattern) => {
  let n = 0, entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += walk(full, pattern);
    else if (pattern.test(entry.name)) n += 1;
  }
  return n;
};
const results = [];
for (const dir of input.dirs || []) {
  try {
    if (!fs.existsSync(dir)) { results.push({ dir, exists: false }); continue; }
    const probe = { dir, exists: true, counts: { extensions: 0, skills: 0, prompts: 0, themes: 0 } };
    const pkgJsonPath = path.join(dir, 'package.json');
    let manifest;
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      probe.packageName = typeof parsed.name === 'string' ? parsed.name : undefined;
      probe.version = typeof parsed.version === 'string' ? parsed.version : undefined;
      probe.description = typeof parsed.description === 'string' ? parsed.description : undefined;
      if (parsed.pi && Array.isArray(parsed.pi.extensions)) manifest = parsed.pi.extensions;
    } catch {}
    if (manifest) {
      for (const rel of manifest) if (fs.existsSync(path.resolve(dir, rel))) probe.counts.extensions += 1;
    } else if (fs.existsSync(path.join(dir, 'index.ts')) || fs.existsSync(path.join(dir, 'index.js'))) {
      probe.counts.extensions = 1;
    } else {
      probe.counts.extensions = walk(path.join(dir, 'extensions'), /\\.(ts|js)$/);
    }
    const skillsDir = path.join(dir, 'skills');
    try {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) probe.counts.skills += 1;
      }
    } catch {}
    probe.counts.prompts = walk(path.join(dir, 'prompts'), /\\.md$/);
    probe.counts.themes = walk(path.join(dir, 'themes'), /\\.json$/);
    results.push(probe);
  } catch (e) {
    results.push({ dir, exists: false, error: String((e && e.message) || e) });
  }
}
process.stdout.write(JSON.stringify({ results }));
`;

/** Candidate install dirs for the `npm:` sources, keyed by source. */
function npmPackageDirs(agentDir: string, packages: readonly PluginPackageInfo[]): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const pkg of packages) {
    const npm = parseNpmSource(pkg.source);
    if (!npm) continue;
    dirs.set(pkg.source, `${agentDir}/npm/node_modules/${npm.name}`);
  }
  return dirs;
}

/**
 * Ask the device what is on disk for the configured packages: install path,
 * package.json metadata and resource counts, one round trip for all of them.
 *
 * Anything the probe cannot answer (no node, a dead driver) leaves the package
 * as the settings read described it — the list degrades, it does not fail.
 */
export async function probeRemotePackages(
  driver: IHostDriver,
  agentDir: string,
  packages: readonly PluginPackageInfo[],
): Promise<Map<string, RemotePackageProbe>> {
  const probed = new Map<string, RemotePackageProbe>();
  const dirs = npmPackageDirs(agentDir, packages);
  if (dirs.size === 0) return probed;
  const ordered = [...dirs.values()];
  try {
    const configB64 = Buffer.from(JSON.stringify({ dirs: ordered }), "utf8").toString("base64");
    const scriptB64 = Buffer.from(REMOTE_PACKAGE_PROBE_SCRIPT, "utf8").toString("base64");
    const result = await driver.exec(
      `PIWEB_PKGS=${configB64} node -e "eval(Buffer.from('${scriptB64}','base64').toString('utf8'))"`,
      [],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0 || !result.stdout.trim().startsWith("{")) return probed;
    const parsed = JSON.parse(result.stdout.trim()) as {
      results?: Array<{ dir: string; exists: boolean; packageName?: string; version?: string; description?: string; counts?: PluginResourceCounts }>;
    };
    const byDir = new Map((parsed.results ?? []).map((r) => [r.dir, r]));
    for (const [source, dir] of dirs) {
      const answer = byDir.get(dir);
      if (!answer) continue;
      probed.set(source, {
        exists: answer.exists === true,
        ...(answer.exists ? {
          installedPath: dir,
          packageName: answer.packageName,
          version: answer.version,
          description: answer.description,
        } : {}),
        counts: answer.exists && answer.counts ? { ...emptyCounts(), ...answer.counts } : emptyCounts(),
      });
    }
  } catch {
    // The probe is best effort: the settings read still answers.
  }
  return probed;
}

/** The settings object a write starts from, with `packages` normalised to an array. */
export function settingsWithPackages(
  settings: Record<string, unknown> | undefined,
  entries: unknown[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(settings ?? {}) };
  next.packages = entries;
  return next;
}

/** Serialize a settings object the way `SettingsManager` does: two spaces, no trailing newline. */
export function serializeRemoteSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2);
}

export interface RemotePluginToggle {
  source: string;
  scope: PluginScope;
  error?: string;
}

/**
 * Switch packages on or off on the device, one settings write per scope.
 *
 * Same per-package answer the local route gives, for the same reasons: a source
 * the file does not configure is reported rather than silently ignored, and a
 * filtered entry stays on because switching it off would drop the filters.
 */
export async function setRemotePackagesDisabled(
  driver: IHostDriver,
  agentDir: string,
  cwd: string,
  packages: readonly { source: string; scope: PluginScope }[],
  disabled: boolean,
  { keepEntrySettings = false }: { keepEntrySettings?: boolean } = {},
): Promise<RemotePluginToggle[]> {
  const errors = new Map<string, string>();
  for (const scope of ["global", "project"] as const) {
    const sources = packages.filter((pkg) => pkg.scope === scope).map((pkg) => pkg.source);
    if (sources.length === 0) continue;
    const path = deviceSettingsPath(agentDir, cwd, scope);
    const files = await readRemoteFiles(driver, [path], WRITE_TIMEOUT_MS);
    const text = files.get(path);
    const settings = parseRemoteSettingsFile(text);
    if (text !== undefined && settings === undefined) {
      // A file that does not parse holds settings this module cannot see; writing
      // it back would drop them, so the scope is refused instead.
      for (const source of sources) errors.set(`${scope}\0${source}`, `${path} could not be read as a settings file`);
      continue;
    }
    const edit = applyPackagesDisabled(
      remotePackageEntries(settings) as Parameters<typeof applyPackagesDisabled>[0],
      sources,
      disabled,
      { keepEntrySettings },
    );
    for (const source of edit.missing) errors.set(`${scope}\0${source}`, "Package is not configured");
    for (const source of edit.kept) errors.set(`${scope}\0${source}`, FILTERED_PACKAGE_ERROR);
    if (!edit.changed) continue;
    await writeRemoteFile(
      driver,
      path,
      serializeRemoteSettings(settingsWithPackages(settings, edit.next)),
      WRITE_TIMEOUT_MS,
    );
  }
  invalidateRemoteSettings(driver.deviceId);
  return packages.map((pkg) => {
    const error = errors.get(`${pkg.scope}\0${pkg.source}`);
    return error ? { source: pkg.source, scope: pkg.scope, error } : { source: pkg.source, scope: pkg.scope };
  });
}

export interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runPi(
  driver: IHostDriver,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<RemoteCommandResult> {
  const result = await driver.exec("pi", [...args], { cwd, env, timeoutMs: CLI_TIMEOUT_MS });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
}

/** The device's `pi` arguments for one package command, and whether it is project-local. */
export function pluginCommandArgs(
  action: "install" | "remove" | "update",
  source: string | undefined,
  scope: PluginScope,
): string[] {
  const local = scope === "project";
  if (action === "install") return ["install", source ?? "", ...(local ? ["-l"] : [])];
  if (action === "remove") return ["remove", source ?? "", ...(local ? ["-l"] : [])];
  // `pi update` takes one source positionally, or `--extensions` for all of them.
  return source ? ["update", source] : ["update", "--extensions"];
}

/**
 * Run one package command on the device.
 *
 * The CLI reports failure through its exit status, which is what the route turns
 * into a 500, and its message is what the user sees. It also prints progress, so
 * the output is kept whole and stripped of colour only for display.
 */
export async function runRemotePluginCommand(
  driver: IHostDriver,
  action: "install" | "remove" | "update",
  options: { source?: string; scope: PluginScope; cwd: string },
): Promise<void> {
  const args = pluginCommandArgs(action, options.source, options.scope);
  const result = await runPi(driver, args, options.cwd, { FORCE_COLOR: "0", NO_COLOR: "1" });
  if (result.exitCode !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new Error(output || `pi ${args.join(" ")} exited with ${result.exitCode}`);
  }
  invalidateRemoteSettings(driver.deviceId);
}

/** A device's agent directory, for callers that only need the settings paths. */
export async function remoteAgentDir(deviceId: string): Promise<string> {
  return getRemoteAgentDir(deviceId);
}
