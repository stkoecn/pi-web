import "server-only";
import { getGateway } from "@/lib/gateway/singleton";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { deviceHomeOrDefault } from "@/lib/device-home";
import { shellQuote } from "@/lib/shell-quote";
import { stripJsonComments } from "@/lib/jsonc";
import { CODEMODE_INLINE_BUDGET_DEFAULT, CODEMODE_INLINE_BUDGET_MAX } from "@/lib/codemode-settings";
import {
  McpResponse,
  PluginsResponse,
  SkillsResponse,
  SkillInfo,
  McpScope,
  McpServerInfo,
  McpServerStatus,
  McpTestResult,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginStandaloneExtensionInfo,
} from "@/lib/api-types";
import { readMcpStatus, recordMcpStatus } from "@/lib/mcp-status";

/**
 * Settings panes (models / skills / subagents / plugins / MCP) read pi's own
 * configuration. On a remote device that configuration lives in the device's
 * `~/.pi/agent`, not here, so every reader in this module answers from the
 * device.
 *
 * Two strategies, chosen per pane by what pi exposes:
 *
 * - **pi CLI over SSH** (`pi mcp list --json`) when the device's pi can print the
 *   data itself. This is authoritative: it is the same code path the device uses
 *   to load the resources, so it cannot drift from what a session there sees.
 * - **Remote file read** (`~/.pi/agent/*.json`) when pi has no listing command.
 *   Reads go through the gateway's `readFile`, never the local filesystem.
 *
 * Nothing here writes: mutation routes answer 501 for remote devices, because a
 * half-supported write is worse than a clear refusal.
 */

const SETTINGS_CACHE_TTL_MS = 15_000;
const CLI_TIMEOUT_MS = 20_000;
/** Delimits one file's content inside a batched read. */
const BATCH_MARKER = "@@piweb-file@@";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

declare global {
  var __piWebRemoteSettings:
    | {
        mcp: Map<string, CacheEntry<McpResponse>>;
        skills: Map<string, CacheEntry<SkillsResponse>>;
        plugins: Map<string, CacheEntry<PluginsResponse>>;
        agentDir: Map<string, CacheEntry<string>>;
        subagents: Map<string, CacheEntry<{ enabled: boolean; maxConcurrent: number }>>;
      }
    | undefined;
}

function cache() {
  globalThis.__piWebRemoteSettings ??= {
    mcp: new Map(),
    skills: new Map(),
    plugins: new Map(),
    agentDir: new Map(),
    subagents: new Map(),
  };
  return globalThis.__piWebRemoteSettings;
}

/** Drop cached settings for one device (or all) after a write elsewhere. */
export function invalidateRemoteSettings(deviceId?: string): void {
  const store = cache();
  for (const map of [store.mcp, store.skills, store.plugins, store.agentDir, store.subagents]) {
    if (deviceId) map.delete(deviceId);
    else map.clear();
  }
}

async function driverFor(deviceId: string): Promise<IHostDriver> {
  // Same rule as the session read path: a device mid-reconnect answers at once
  // instead of making the settings panel wait ten seconds to fail.
  return getGateway().getDriverForRequest(deviceId);
}

/** Run a command on the device and return stdout, or null when it failed. */
async function runOnDevice(
  driver: IHostDriver,
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
  try {
    const result = await driver.exec(command, [], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      timeoutMs: options.timeoutMs ?? CLI_TIMEOUT_MS,
    });
    return result;
  } catch {
    return null;
  }
}

/**
 * Run a POSIX shell script on the device.
 *
 * Base64 so the login shell only ever sees an opaque blob: quoting, globs and
 * `$` then behave the same on every device (macOS's zsh aborts a script that
 * contains an unmatched glob, which silently emptied whole listings).
 */
async function runScript(
  driver: IHostDriver,
  script: string,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
  return runOnDevice(
    driver,
    `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
    { timeoutMs },
  );
}

/**
 * Read several files in ONE round trip.
 *
 * A per-file read costs a full round trip (250-900 ms on a WAN device), so a
 * settings pane listing eight skills used to spend eight of them. Each section
 * is delimited by a marker line holding the index, and a file that could not be
 * read simply has no section: the caller sees a missing key instead of an error.
 */
async function readFilesAtOnce(
  driver: IHostDriver,
  paths: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (paths.length === 0) return found;
  const script = paths
    .map((path, index) => {
      const quoted = shellQuote(path);
      return [
        `if [ -f ${quoted} ]; then`,
        `  printf '%s%s\\n' '${BATCH_MARKER}' '${index}'`,
        `  cat ${quoted}`,
        `  printf '\\n'`,
        `fi`,
      ].join("\n");
    })
    .join("\n");
  const result = await runScript(driver, script, options.timeoutMs ?? 20_000);
  if (!result || result.exitCode !== 0) return found;
  const marker = new RegExp(`^${BATCH_MARKER}(\\d+)$`);
  let current: { path: string; lines: string[] } | null = null;
  for (const line of result.stdout.split("\n")) {
    const match = marker.exec(line);
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
 * pi's agent directory on the device.
 *
 * `PI_CODING_AGENT_DIR` wins (it is what the SDK's `getAgentDir()` honours), then
 * `~/.pi/agent`. A device whose shell is not POSIX-compatible is not supported by
 * the gateway anyway, so `$HOME` expansion is safe here.
 */
export async function getRemoteAgentDir(deviceId: string): Promise<string> {
  const store = cache();
  const cached = store.agentDir.get(deviceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const driver = await driverFor(deviceId);

  // One round trip, and no `$HOME` probe first: the script expands the fallback
  // itself, so the common case costs a single command instead of two.
  const probe = await runOnDevice(
    driver,
    'printf %s "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"',
    { timeoutMs: 10_000 },
  );
  const printed = probe?.exitCode === 0 ? probe.stdout.trim() : "";
  const agentDir = printed.startsWith("/")
    ? printed
    : `${await deviceHomeOrDefault(deviceId)}/.pi/agent`;

  store.agentDir.set(deviceId, { value: agentDir, expiresAt: Date.now() + 5 * 60_000 });
  return agentDir;
}

/* ------------------------------------------------------------------ MCP --- */

interface RemoteMcpServer {
  name?: string;
  scope?: string;
  source?: string;
  enabled?: boolean;
  exposure?: string;
  transport?: string;
  state?: string;
  tools?: string[];
  resources?: boolean;
  error?: string;
}

/**
 * Settings › MCP for a remote device.
 *
 * The pane is answered from the device's files, in ONE round trip. The device's
 * own `pi mcp list --json` is authoritative — it connects every server and
 * prints each one's state and tools — but it boots a whole Node process there
 * (1.44 s measured on a 1-vCPU VPS), which is most of what made this pane slow.
 * Its live state only feeds the status dots, so it refreshes those in the
 * background (`refreshMcpStateFromCli`) and the pane never waits for it.
 *
 * The listing therefore comes from `~/.pi/agent/mcp.json` (and the project's
 * `.pi/mcp.json`, listed for its existence), which holds everything the panel
 * renders: the names, their scope, whether they are enabled, their command, and
 * how they are exposed. The CLI is still the source when the files hold nothing
 * a listing can be built from (an unreadable file, or a device whose pi knows
 * servers this code cannot see).
 */
export async function readRemoteMcpOverview(
  deviceId: string,
  cwd: string | null = null,
  options: { force?: boolean } = {},
): Promise<McpResponse> {
  // The cache key carries the cwd: the project file and the Code-mode override
  // are per folder, so one device can legitimately have several answers.
  const key = `${deviceId}\u0000${cwd ?? ""}`;
  const store = cache();
  // Statuses are attached on every read rather than baked into the cached
  // value: the background refresh can land between two reads of the same
  // files, and that is exactly when the dots should change.
  const cached = store.mcp.get(key);
  if (!options.force && cached && cached.expiresAt > Date.now()) return attachStatuses(cached.value);

  const driver = await driverFor(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const settingsPath = `${agentDir}/settings.json`;
  const globalMcpPath = `${agentDir}/mcp.json`;
  const projectMcpPath = cwd ? `${cwd}/.pi/mcp.json` : null;

  // One round trip for the settings the Code-mode pane shows and both mcp.json
  // files, where it used to be one per file.
  const files = await readFilesAtOnce(
    driver,
    projectMcpPath ? [settingsPath, globalMcpPath, projectMcpPath] : [settingsPath, globalMcpPath],
  );
  const settings = parseJsonObject(files.get(settingsPath));

  const remember = (value: McpResponse): McpResponse => {
    store.mcp.set(key, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
    return attachStatuses(value);
  };

  const listing = mcpResponseFromFiles(
    files.get(globalMcpPath) ?? null,
    projectMcpPath ? files.get(projectMcpPath) ?? null : null,
    agentDir,
    deviceId,
    settings,
    settingsPath,
    cwd,
  );
  if (listing.servers.length > 0) {
    // The files describe servers: answer now, and let the CLI fill the dots in
    // while the user is already reading the list.
    void refreshMcpStateFromCli(deviceId, driver, cwd, agentDir);
    return remember(listing);
  }

  // Nothing listable in the files: the CLI is the other source, and waiting for
  // it is what made this pane take 1.5–2.7 s on a device that has no `mcp.json`
  // at all. So it runs in the background and the pane answers empty now; when it
  // lands with servers they go into the cache, which the pane's quiet read-back
  // reads a moment later. A device whose servers live where these files cannot
  // see them therefore appears one read late instead of costing every open a
  // Node process to boot on the device.
  void refreshMcpStateFromCli(deviceId, driver, cwd, agentDir)
    .then((servers) => {
      if (!servers || servers.length === 0) return;
      remember(toMcpResponse(servers, agentDir, deviceId, settings, settingsPath, cwd));
    })
    .catch(() => {});

  return remember(listing);
}

/** A JSON object read from the device, or `{}` when it is missing or not one. */
function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Every server of this device is keyed by its file entry, so the background CLI refresh and the file listing agree. */
function remoteMcpConfigKey(deviceId: string, name: string): string {
  return `remote:${deviceId}:file:${name}`;
}

/**
 * The cached listing with each server's last known state attached.
 *
 * `GET /api/mcp` for a local folder does the same through `withMcpStatuses`.
 * The state comes from the device's `pi mcp list --json`
 * (`refreshMcpStateFromCli`), recorded under the same key the listing uses, so
 * a row whose entry changed reads as untested again.
 */
function attachStatuses(value: McpResponse): McpResponse {
  if (value.servers.length === 0) return value;
  return {
    ...value,
    servers: value.servers.map((server) => {
      const status = readMcpStatus(
        { scope: server.scope, sourcePath: server.sourcePath, name: server.name },
        server.configKey,
      );
      return status ? { ...server, status } : server;
    }),
  };
}

/**
 * The CLI listings on their way, by device and folder.
 *
 * Module scope, not `globalThis`: an in-flight promise belongs to this process
 * and a hot reload must not share one with the module instance it replaces.
 * Concurrent reads of one device (the panel loads once, but a refresh can
 * overlap it) join the same CLI instead of each booting a Node process there.
 */
const inflightCliListings = new Map<string, Promise<RemoteMcpServer[] | null>>();

/**
 * Refresh the status dots from the device's own `pi mcp list --json`.
 *
 * Best effort and never awaited for its own sake when the files already answered:
 * the pane is on screen and this only fills the dots. A device that cannot run
 * the CLI (old pi, no shell) simply leaves the rows untested, which is what the
 * panel showed before.
 *
 * Returns the servers the CLI listed, or null when it could not answer — the
 * caller with an empty file listing is the one place that needs them.
 */
function refreshMcpStateFromCli(
  deviceId: string,
  driver: IHostDriver,
  cwd: string | null,
  agentDir: string,
): Promise<RemoteMcpServer[] | null> {
  const key = `${deviceId}\u0000${cwd ?? ""}`;
  const existing = inflightCliListings.get(key);
  if (existing) return existing;
  const run = (async (): Promise<RemoteMcpServer[] | null> => {
    const started = Date.now();
    const cli = await runOnDevice(driver, "pi mcp list --json", cwd ? { cwd } : {});
    const durationMs = Date.now() - started;
    if (!cli || cli.exitCode !== 0 || !cli.stdout.trim()) return null;
    const parsed = JSON.parse(cli.stdout) as { servers?: RemoteMcpServer[] };
    if (!Array.isArray(parsed.servers)) return null;
    recordCliStatuses(parsed.servers, agentDir, deviceId, durationMs);
    return parsed.servers;
  })()
    .catch(() => {
      // Malformed output (a warning line before the JSON, an older pi): the
      // files already answered, so there is nothing to report.
      return null;
    })
    .finally(() => inflightCliListings.delete(key));
  inflightCliListings.set(key, run);
  return run;
}

/** Record what the device's CLI saw of each server, under the key the file listing uses. */
function recordCliStatuses(
  servers: RemoteMcpServer[],
  agentDir: string,
  deviceId: string,
  durationMs: number,
): void {
  const testedAt = Date.now();
  for (const server of servers) {
    const name = String(server.name ?? "");
    if (!name) continue;
    const sourcePath = String(server.source ?? "") || `${agentDir}/mcp.json`;
    const scope: McpScope = server.scope === "project" ? "project" : "global";
    const tools = Array.isArray(server.tools) ? server.tools : [];
    // `pi mcp list` connected to each server to read its state and tools, which
    // is what a Test does, so the row shows it as one — with the CLI's own
    // duration, since that is how long the connection took to report.
    const status: McpServerStatus = {
      origin: "test",
      state: server.state === "connected" ? "connected" : server.state === "needs-auth" ? "needs-auth" : "failed",
      ...(server.error ? { error: String(server.error) } : {}),
      tools: tools.map((tool) => ({ name: String(tool) })) as McpTestResult["tools"],
      toolCount: tools.length,
      ...(server.resources ? { resources: true as const } : {}),
      durationMs,
      testedAt,
    };
    recordMcpStatus(
      { scope, sourcePath, name },
      remoteMcpConfigKey(deviceId, name),
      status,
    );
  }
}

/**
 * The `McpResponse` fields a remote device can answer, filled to the same shape
 * the local route produces.
 *
 * `McpConfig` validates the payload before rendering (`isMcpResponse`), and it
 * requires `mcp`, `codemode`, `files` and `servers` — the first remote version
 * omitted `mcp`/`codemode` and carried a bare `capabilities`, so the panel
 * rejected the answer and showed a load failure while the data was fine.
 *
 * What genuinely differs on a device is stated rather than guessed:
 * `capabilities`/`diagnostics` are not part of `McpResponse` at all; Code mode
 * settings are read from the device's own `settings.json`; the sandbox state is
 * `not-checked` because the self-test runs inside a session on the device and
 * this process never sees it; and the project file is listed only when a cwd
 * was asked for, since the device decides trust for its own folders.
 */
function remoteCodemodeInfo(
  settings: Record<string, unknown>,
  settingsPath: string,
): McpResponse["codemode"] {
  const codemode = (settings.codemode ?? {}) as Record<string, unknown>;
  const defaultTools = Array.isArray(settings.defaultTools) ? settings.defaultTools as unknown[] : [];
  const entries = defaultTools.filter((entry): entry is string => typeof entry === "string");
  const rawMode = codemode.mode;
  const rawBudget = codemode.inlineBudget;
  const info: McpResponse["codemode"] = {
    // The self-test runs inside a session on the device; this process has no
    // way to observe it, and "not-checked" is the honest answer.
    sandbox: { state: "not-checked" },
    builtinDisabled: entries.some((entry) => entry === "-builtin:codemode"),
    preference: entries.includes("codemode") ? "always" : "automatic",
    mode: rawMode === "only"
      ? { value: "only", settingsPath }
      : rawMode === undefined || rawMode === "on"
        ? { value: "on", settingsPath }
        : { value: "on", invalid: JSON.stringify(rawMode), settingsPath },
    inlineBudget: {
      settingsPath,
      default: CODEMODE_INLINE_BUDGET_DEFAULT,
      max: CODEMODE_INLINE_BUDGET_MAX,
      ...(typeof rawBudget === "number" && Number.isFinite(rawBudget) && rawBudget >= 0
        ? { value: rawBudget }
        : rawBudget === undefined ? {} : { invalid: JSON.stringify(rawBudget) }),
    },
  };
  return info;
}

/** Shape `pi mcp list --json` output like the local route's `McpResponse`. */
function toMcpResponse(
  servers: RemoteMcpServer[],
  agentDir: string,
  deviceId: string,
  settings: Record<string, unknown>,
  settingsPath: string,
  cwd: string | null,
): McpResponse {
  const infos: McpResponse["servers"] = servers.map((server) => {
    const name = String(server.name ?? "");
    const scope: McpResponse["servers"][number]["scope"] = server.scope === "project" ? "project" : "global";
    const exposure = server.exposure === "codemode" ? "codemode" as const : "direct" as const;
    // `pi mcp list` reports where a server lives but not how it is launched, so
    // the command is all the transport detail there is. The arrays the panel
    // reads unconditionally (`envNames`, `headerNames`, `commandFields`,
    // `variableReferences`) are present and empty rather than absent: the local
    // route always sends them, and a missing one crashes the detail view.
    return {
      name,
      scope,
      sourcePath: String(server.source ?? ""),
      // The same key the file listing and the status records use, so a row read
      // from either source carries the state the CLI reported for it.
      configKey: remoteMcpConfigKey(deviceId, name),
      enabled: server.enabled !== false,
      validated: true,
      transport: "stdio" as const,
      exposure,
      command: String(server.transport ?? ""),
      envNames: [],
      headerNames: [],
      usesOAuth: false,
      commandFields: [],
      variableReferences: [],
      masked: false,
      ...(server.error ? { invalidError: String(server.error) } : {}),
    };
  });

  const files: McpResponse["files"] = [
    {
      path: `${agentDir}/mcp.json`,
      scope: "global",
      exists: servers.some((server) => server.scope !== "project"),
      problems: [],
    },
  ];
  if (cwd) {
    files.push({ path: `${cwd}/.pi/mcp.json`, scope: "project", exists: false, problems: [] });
  }

  return {
    mcp: { available: true },
    codemode: remoteCodemodeInfo(settings, settingsPath),
    files,
    servers: infos,
    // A device decides trust for its own folders; reporting the folder without
    // a trust verdict keeps the panel from offering a Trust button it cannot act on.
    ...(cwd ? { project: { cwd, trustFolder: { allowed: true } } } : {}),
    remote: { deviceId, source: "pi-cli" },
  } as unknown as McpResponse;
}

/**
 * The pane's answer built from the device's files alone: no round trip of its own.
 *
 * `raw` is the global `mcp.json` (null when it does not exist) and
 * `projectFileExists` says whether the folder's `.pi/mcp.json` is there. What the
 * files cannot say — whether each server actually connects, and which tools it
 * offers — arrives later through `refreshMcpStateFromCli`, which is why the
 * servers start out as untested rows.
 */
function mcpResponseFromFiles(
  raw: string | null,
  projectRaw: string | null,
  agentDir: string,
  deviceId: string,
  settings: Record<string, unknown>,
  settingsPath: string,
  cwd: string | null,
): McpResponse {
  const globalMcpPath = `${agentDir}/mcp.json`;
  const projectMcpPath = cwd ? `${cwd}/.pi/mcp.json` : null;

  // Both files hold `{ "mcpServers": { name: entry } }`; a file that puts the
  // map at the top level is accepted too, which is what the previous reader did.
  const readServers = (content: string | null, scope: McpScope, source: string): McpResponse["servers"] => {
    const parsed = parseJsonObject(content ?? undefined);
    const map = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, unknown>;
    if (!map || typeof map !== "object") return [];    return Object.entries(map).map(([name, value]) => {
      const entry = (value ?? {}) as Record<string, unknown>;
      const command = typeof entry.command === "string" ? entry.command : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      return {
        name,
        scope,
        sourcePath: source,
        configKey: remoteMcpConfigKey(deviceId, name),
        enabled: entry.enabled !== false,
        validated: true,
        // An entry with a `url` talks HTTP; one with a command runs it.
        transport: (url ? "http" : "stdio") as McpServerInfo["transport"],
        exposure: entry.exposure === "codemode" ? "codemode" as const : "direct" as const,
        ...(command ? { command } : {}),
        ...(url ? { url } : {}),
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        envNames: Object.keys((entry.env ?? {}) as Record<string, unknown>),
        // Header names only: the values can hold tokens, and the local route
        // masks them too.
        headerNames: Object.keys((entry.headers ?? {}) as Record<string, unknown>),
        // The SDK signs an HTTP server in with OAuth when it answers 401.
        usesOAuth: Boolean(url),
        commandFields: [],
        variableReferences: [],
        masked: false,
      } satisfies McpServerInfo;
    });
  };

  const servers = [
    ...readServers(raw, "global", globalMcpPath),
    ...readServers(projectRaw, "project", projectMcpPath ?? ""),
  ];

  const files: McpResponse["files"] = [
    { path: globalMcpPath, scope: "global", exists: raw !== null, problems: [] },
  ];
  if (projectMcpPath) {
    files.push({ path: projectMcpPath, scope: "project", exists: projectRaw !== null, problems: [] });
  }

  return {
    mcp: { available: true },
    codemode: remoteCodemodeInfo(settings, settingsPath),
    files,
    servers,
    // A device decides trust for its own folders; reporting the folder without
    // a trust verdict keeps the panel from offering a Trust button it cannot act on.
    ...(cwd ? { project: { cwd, trustFolder: { allowed: true } } } : {}),
    remote: { deviceId, source: "file" },
  } as unknown as McpResponse;
}

/* --------------------------------------------------------------- skills --- */

/**
 * Settings › Skills for a remote device.
 *
 * pi has no `skills list` command, so this enumerates the skill roots the device
 * uses — the global `~/.pi/agent/skills` and `~/.agents/skills`, plus the
 * project's `.pi/skills` — and reads each `SKILL.md` frontmatter over the gateway.
 * The result carries the same fields the local loader produces for the parts a
 * listing needs (name, description, path, source), and says so via `remote`.
 */
export async function readRemoteSkills(
  deviceId: string,
  cwd: string,
  options: { force?: boolean } = {},
): Promise<SkillsResponse> {
  const store = cache();
  const key = `${deviceId}\u0000${cwd}`;
  const cached = store.skills.get(key);
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.value;

  const driver = await driverFor(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const home = await deviceHomeOrDefault(deviceId);

  const roots: Array<{ dir: string; source: string; scope: string }> = [
    { dir: `${agentDir}/skills`, source: "global", scope: "global" },
    { dir: `${home}/.agents/skills`, source: "global", scope: "global" },
    { dir: `${cwd}/.pi/skills`, source: "project", scope: "project" },
  ];

  const skills: SkillInfo[] = [];
  const diagnostics: Array<{ type: string; message: string; source?: string }> = [];

  // One round trip for every root: three separate listings cost three full
  // device round trips, and the panel has nothing to show until all are in.
  const listingScript = roots
    .map((root, index) => {
      const quoted = shellQuote(root.dir);
      return [
        `printf '%s%s\\n' '${BATCH_MARKER}' '${index}'`,
        `for d in ${quoted}/*/; do [ -f "$d/SKILL.md" ] && printf '%s\\n' "\${d%/}"; done 2>/dev/null; true`,
      ].join("\n");
    })
    .join("\n");
  const listingResult = await runScript(driver, listingScript, 20_000);
  const dirsByRoot = new Map<number, string[]>();
  if (listingResult && listingResult.exitCode === 0) {
    const marker = new RegExp(`^${BATCH_MARKER}(\\d+)$`);
    let currentRoot: number | null = null;
    for (const line of listingResult.stdout.split("\n")) {
      const match = marker.exec(line);
      if (match) {
        currentRoot = Number(match[1]);
        dirsByRoot.set(currentRoot, []);
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed || currentRoot === null) continue;
      dirsByRoot.get(currentRoot)?.push(trimmed);
    }
  }

  // Frontmatter only: the first fenced block, capped so a huge skill file
  // cannot blow up the response. Every skill is read in one command.
  const skillDirs = roots.flatMap((root, index) =>
    (dirsByRoot.get(index) ?? []).map((dir) => ({ dir, root })),
  );
  const skillFiles = await readFilesAtOnce(
    driver,
    skillDirs.map(({ dir }) => `${dir}/SKILL.md`),
  );

  for (const { dir, root } of skillDirs) {
    const content = (skillFiles.get(`${dir}/SKILL.md`) ?? "").split("\n").slice(0, 40).join("\n");
    const meta = parseFrontmatter(content);
    skills.push({
      name: meta.name || dir.slice(dir.lastIndexOf("/") + 1),
      description: meta.description ?? "",
      filePath: `${dir}/SKILL.md`,
      // `baseDir`/`sourceInfo` are what the local loader emits; the Skills panel
      // reads `baseDir` to resolve a skill's relative document links, so a
      // remote skill must carry it too or its documents refuse to open.
      baseDir: dir,
      disableModelInvocation: meta.disableModelInvocation === true,
      sourceInfo: { source: root.source, scope: root.scope },
    });
  }

  const value: SkillsResponse = {
    skills,
    diagnostics: diagnostics as SkillsResponse["diagnostics"],
    projectResourcesLoaded: false,
    ...({ remote: { deviceId, source: "file" } } as object),
  } as SkillsResponse;

  store.skills.set(key, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return value;
}

/** Minimal YAML frontmatter reader: `key: value` pairs between `---` fences. */
function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const result: { name?: string; description?: string; disableModelInvocation?: boolean } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    const [, rawKey, rawValue] = pair;
    const value = rawValue.replace(/^["']|["']$/g, "").trim();
    if (rawKey === "name") result.name = value;
    else if (rawKey === "description") result.description = value;
    else if (rawKey === "disable-model-invocation" || rawKey === "disableModelInvocation") {
      result.disableModelInvocation = value === "true";
    }
  }
  return result;
}

/* -------------------------------------------------------------- plugins --- */

/**
 * Settings › Plugins for a remote device.
 *
 * `pi list` prints configured packages but has no JSON mode, so the device's
 * `settings.json` is read directly: it is where pi records installed package
 * sources, and it is the same file `SettingsManager` consults on the device.
 */
export async function readRemotePlugins(
  deviceId: string,
  cwd: string,
  options: { force?: boolean } = {},
): Promise<PluginsResponse> {
  const store = cache();
  const key = `${deviceId}\u0000${cwd}`;
  const cached = store.plugins.get(key);
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.value;

  const driver = await driverFor(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);

  const empty: PluginResourceCounts = { extensions: 0, skills: 0, prompts: 0, themes: 0 };

  // Both settings files in one round trip: the plugin list is a single answer,
  // so paying two full device round trips for it is pure latency.
  const globalPath = `${agentDir}/settings.json`;
  const projectPath = `${cwd}/.pi/settings.json`;
  const settingsFiles = await readFilesAtOnce(driver, [globalPath, projectPath]);
  function parseSettings(raw: string | undefined): Record<string, unknown> | null {
    if (raw === undefined) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  const globalSettings = parseSettings(settingsFiles.get(globalPath));
  const projectSettings = parseSettings(settingsFiles.get(projectPath));

  const packages: PluginPackageInfo[] = [];
  const diagnostics: PluginsResponse["diagnostics"] = [];

  for (const [scope, settings] of [
    ["global", globalSettings],
    ["project", projectSettings],
  ] as const) {
    if (!settings) continue;
    const sources = settings.packages;
    if (!Array.isArray(sources)) continue;
    for (const entry of sources) {
      const source = typeof entry === "string"
        ? entry
        : (entry && typeof entry === "object" && "source" in entry
          ? String((entry as { source?: unknown }).source ?? "")
          : "");
      if (!source) continue;
      const disabled = Boolean(
        entry && typeof entry === "object" && (entry as { disabled?: unknown }).disabled,
      );
      packages.push({
        source,
        scope,
        canCheckForUpdates: false,
        filtered: false,
        disabled,
        installedPath: undefined,
        packageName: undefined,
        version: undefined,
        configuredVersion: undefined,
        description: undefined,
        counts: empty,
        resources: [],
        // Counting a package's resources needs the package manager to resolve it
        // on the device; the pane shows the configured source and scope instead.
        status: disabled ? "disabled" : "installed",
      } as unknown as PluginPackageInfo);
    }
  }

  const value: PluginsResponse = {
    packages,
    standaloneExtensions: [] as PluginStandaloneExtensionInfo[],
    totals: empty,
    diagnostics,
    projectResourcesLoaded: false,
    ...({ remote: { deviceId, source: "file" } } as object),
  } as PluginsResponse;

  store.plugins.set(key, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return value;
}

/* ------------------------------------------------------------ subagents --- */

/**
 * Settings › Agents (subagent profiles) for a remote device.
 *
 * Built-in profiles ship inside pi itself, so the device has the same set this
 * host does; only the file-backed profiles differ. Those live in the device's
 * `~/.pi/agent/agents`, `<cwd>/.agents/agents` and `<cwd>/.pi/agents`, each one
 * a markdown file with frontmatter — the same layout the local loader reads, so
 * this enumerates them over the gateway and reports the fields the panel shows.
 */
export async function readRemoteSubagentProfiles(
  deviceId: string,
  cwd: string,
  options: { force?: boolean } = {},
): Promise<{ profiles: Array<Record<string, unknown>>; remote: { deviceId: string; source: string } }> {
  const driver = await driverFor(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);

  const roots: Array<{ dir: string; scope: string }> = [
    { dir: `${agentDir}/agents`, scope: "global" },
    { dir: `${cwd}/.agents/agents`, scope: "workspace" },
    { dir: `${cwd}/.pi/agents`, scope: "project" },
  ];

  const profiles: Array<Record<string, unknown>> = [];
  // One round trip for all three roots plus every profile file, instead of a
  // listing and a read per file on a link where each costs a full round trip.
  const listingScript = roots
    .map((root, index) => {
      const quoted = shellQuote(root.dir);
      return [
        `printf '%s%s\\n' '${BATCH_MARKER}' '${index}'`,
        `for f in ${quoted}/*.md; do [ -f "$f" ] && printf '%s\\n' "$f"; done 2>/dev/null; true`,
      ].join("\n");
    })
    .join("\n");
  const listingResult = await runScript(driver, listingScript, 20_000);
  const filesByRoot = new Map<number, string[]>();
  if (listingResult && listingResult.exitCode === 0) {
    const marker = new RegExp(`^${BATCH_MARKER}(\\d+)$`);
    let currentRoot: number | null = null;
    for (const line of listingResult.stdout.split("\n")) {
      const match = marker.exec(line);
      if (match) {
        currentRoot = Number(match[1]);
        filesByRoot.set(currentRoot, []);
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed || currentRoot === null) continue;
      filesByRoot.get(currentRoot)?.push(trimmed);
    }
  }

  const entries = roots.flatMap((root, index) =>
    (filesByRoot.get(index) ?? []).map((file) => ({ file, root })),
  );
  const contents = await readFilesAtOnce(driver, entries.map(({ file }) => file));

  for (const { file, root } of entries) {
    const content = (contents.get(file) ?? "").split("\n").slice(0, 40).join("\n");
    const meta = parseFrontmatter(content);
    const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.md$/, "");
    profiles.push({
      name: meta.name || base,
      displayName: meta.name || base,
      description: meta.description ?? "",
      scope: root.scope,
      filePath: file,
      enabled: true,
    });
  }

  return { profiles, remote: { deviceId, source: "file" } };
}

/* ------------------------------------------------------------- Subagents --- */

/**
 * Subagent feature switch and concurrency limit from the device's own
 * `~/.pi/agent/agents/settings.json`.
 *
 * Read rather than run through `pi`: the CLI has no subagent section, and this
 * file is the only place the values live. Defaults mirror `readSubagentSettings`
 * so an untouched device shows the same thing a device-local pi would.
 */
export async function readRemoteSubagentSettings(
  deviceId: string,
  options: { force?: boolean } = {},
): Promise<{ enabled: boolean; maxConcurrent: number }> {
  const store = cache();
  const cached = store.subagents.get(deviceId);
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.value;

  const agentDir = await getRemoteAgentDir(deviceId);
  const driver = await driverFor(deviceId);
  const settingsPath = `${agentDir}/agents/settings.json`;
  const script = [
    `f=${shellQuote(settingsPath)}`,
    `[ -f "$f" ] || exit 0`,
    `base64 "$f"`,
  ].join("\n");
  const result = await runOnDevice(driver, `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`, { timeoutMs: 15_000 });

  let parsed: Record<string, unknown> = {};
  const encoded = (result?.stdout ?? "").replace(/\s+/g, "");
  if (encoded) {
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const rawMax = parsed.maxConcurrent;
  const value = {
    enabled: parsed.builtInEnabled === true,
    maxConcurrent: typeof rawMax === "number" && Number.isFinite(rawMax)
      ? Math.min(64, Math.max(1, Math.trunc(rawMax)))
      : 10,
  };
  store.subagents.set(deviceId, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return value;
}

/* --------------------------------------------------------------- Models --- */

/**
 * The device's `models.json`, in the same shape the Models panel expects.
 *
 * Read as text rather than through `pi` because the panel edits this file: it
 * needs exactly what is stored, including comments and unknown keys, so a save
 * elsewhere cannot silently drop a field. Unparsable contents return an empty
 * provider map instead of throwing, so the panel opens read-only rather than
 * failing outright on a hand-edited file.
 */
export async function readRemoteModelsConfig(
  deviceId: string,
): Promise<Record<string, unknown>> {
  const agentDir = await getRemoteAgentDir(deviceId);
  const driver = await driverFor(deviceId);
  const script = [
    `f=${shellQuote(`${agentDir}/models.json`)}`,
    `[ -f "$f" ] || exit 0`,
    `base64 "$f"`,
  ].join("\n");
  const result = await runOnDevice(driver, `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`, { timeoutMs: 15_000 });
  const encoded = (result?.stdout ?? "").replace(/\s+/g, "");
  if (!encoded) return { providers: {} };
  try {
    const text = Buffer.from(encoded, "base64").toString("utf8").replace(/^﻿/, "");
    if (!text.trim()) return { providers: {} };
    const parsed = JSON.parse(stripJsonComments(text)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { providers: {} };
  } catch {
    return { providers: {} };
  }
}
