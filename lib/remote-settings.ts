import "server-only";
import { getGateway } from "@/lib/gateway/singleton";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { deviceHomeOrDefault } from "@/lib/device-home";
import { shellQuote } from "@/lib/shell-quote";
import { stripJsonComments } from "@/lib/jsonc";
import { readRemoteTextFile } from "@/lib/remote-files";
import { CODEMODE_INLINE_BUDGET_DEFAULT, CODEMODE_INLINE_BUDGET_MAX } from "@/lib/codemode-settings";
import type {
  McpResponse,
  PluginsResponse,
  SkillsResponse,
  SkillInfo,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginStandaloneExtensionInfo,
} from "@/lib/api-types";

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
  const home = await deviceHomeOrDefault(deviceId);
  let agentDir = `${home}/.pi/agent`;

  const probe = await runOnDevice(
    driver,
    'printf %s "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"',
    { timeoutMs: 10_000 },
  );
  const printed = probe?.exitCode === 0 ? probe.stdout.trim() : "";
  if (printed.startsWith("/")) agentDir = printed;

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
 * Prefers `pi mcp list --json`, which reports each server's live connection state
 * and tool list — data this process could never obtain by reading files. Falls
 * back to the device's `mcp.json` when the device's pi is too old for `--json`,
 * so the pane still lists what is configured.
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
  const cached = store.mcp.get(key);
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.value;

  const driver = await driverFor(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const { settings, path: settingsPath } = await readRemoteGlobalSettings(driver, agentDir);

  const remember = (value: McpResponse): McpResponse => {
    store.mcp.set(key, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
    return value;
  };

  const cli = await runOnDevice(driver, "pi mcp list --json");
  if (cli && cli.exitCode === 0 && cli.stdout.trim()) {
    try {
      const parsed = JSON.parse(cli.stdout) as { servers?: RemoteMcpServer[] };
      const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
      return remember(toMcpResponse(servers, agentDir, deviceId, settings, settingsPath, cwd));
    } catch {
      // Not JSON (older pi, or a warning printed first): fall through to the file.
    }
  }

  return remember(await readMcpFromFile(driver, agentDir, deviceId, settings, settingsPath, cwd));
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

/** The global `settings.json` of a device, or `{}` when it cannot be read. */
async function readRemoteGlobalSettings(
  driver: IHostDriver,
  agentDir: string,
): Promise<{ settings: Record<string, unknown>; path: string }> {
  const path = `${agentDir}/settings.json`;
  try {
    const raw = await readRemoteTextFile(driver, path);
    const parsed = JSON.parse(raw) as unknown;
    return { settings: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}, path };
  } catch {
    return { settings: {}, path };
  }
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
    const connected = server.state === "connected";
    // `pi mcp list` reports where a server lives but not how it is launched, so
    // the command is all the transport detail there is. The arrays the panel
    // reads unconditionally (`envNames`, `headerNames`, `commandFields`,
    // `variableReferences`) are present and empty rather than absent: the local
    // route always sends them, and a missing one crashes the detail view.
    return {
      name,
      scope,
      sourcePath: String(server.source ?? ""),
      configKey: `remote:${deviceId}:${name}`,
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

async function readMcpFromFile(
  driver: IHostDriver,
  agentDir: string,
  deviceId: string,
  settings: Record<string, unknown>,
  settingsPath: string,
  cwd: string | null,
): Promise<McpResponse> {
  let raw: string | null = null;
  try {
    raw = (await driver.readFile(`${agentDir}/mcp.json`)).toString("utf8");
  } catch {
    raw = null;
  }

  let servers: RemoteMcpServer[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { servers?: Record<string, unknown> } | Record<string, unknown>;
      const map = (parsed as { servers?: Record<string, unknown> }).servers ?? parsed;
      if (map && typeof map === "object") {
        servers = Object.entries(map as Record<string, unknown>).map(([name, value]) => {
          const entry = (value ?? {}) as Record<string, unknown>;
          return {
            name,
            scope: "global",
            source: `${agentDir}/mcp.json`,
            enabled: entry.enabled !== false,
            exposure: typeof entry.exposure === "string" ? entry.exposure : "direct",
            transport: typeof entry.command === "string"
              ? entry.command
              : (typeof entry.url === "string" ? entry.url : ""),
            state: "unknown",
          };
        });
      }
    } catch {
      // Malformed file: report the file as present but unreadable.
    }
  }

  const files: McpResponse["files"] = [
    { path: `${agentDir}/mcp.json`, scope: "global", exists: raw !== null, problems: [] },
  ];
  if (cwd) {
    const projectPath = `${cwd}/.pi/mcp.json`;
    let projectExists = false;
    try {
      await driver.stat(projectPath);
      projectExists = true;
    } catch {
      projectExists = false;
    }
    files.push({ path: projectPath, scope: "project", exists: projectExists, problems: [] });
  }

  return {
    mcp: { available: true },
    codemode: remoteCodemodeInfo(settings, settingsPath),
    files,
    servers: servers.map((server) => ({
      name: String(server.name ?? ""),
      scope: "global" as const,
      sourcePath: `${agentDir}/mcp.json`,
      configKey: `remote:${deviceId}:file:${server.name}`,
      enabled: server.enabled !== false,
      validated: true,
      transport: "stdio" as const,
      exposure: server.exposure === "codemode" ? "codemode" as const : "direct" as const,
      command: String(server.transport ?? ""),
      envNames: [] as string[],
      headerNames: [] as string[],
      usesOAuth: false,
      commandFields: [],
      variableReferences: [],
      masked: false,
    })),
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

  for (const root of roots) {
    const listing = await runOnDevice(
      driver,
      // Print each skill directory that holds a SKILL.md, one per line.
      `for d in ${JSON.stringify(root.dir)}/*/; do [ -f "$d/SKILL.md" ] && printf '%s\\n' "\${d%/}"; done 2>/dev/null; true`,
      { timeoutMs: 15_000 },
    );
    if (!listing || listing.exitCode !== 0) continue;

    const dirs = listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const dir of dirs) {
      const read = await runOnDevice(
        driver,
        // Frontmatter only: the first fenced block, capped so a huge skill file
        // cannot blow up the response.
        `sed -n '1,40p' ${JSON.stringify(`${dir}/SKILL.md`)} 2>/dev/null; true`,
        { timeoutMs: 15_000 },
      );
      const content = read?.stdout ?? "";
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

  async function readSettings(path: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = (await driver.readFile(path)).toString("utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const globalSettings = await readSettings(`${agentDir}/settings.json`);
  const projectSettings = await readSettings(`${cwd}/.pi/settings.json`);

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
  for (const root of roots) {
    const listing = await runOnDevice(
      driver,
      `for f in ${JSON.stringify(root.dir)}/*.md; do [ -f "$f" ] && printf '%s\n' "$f"; done 2>/dev/null; true`,
      { timeoutMs: 15_000 },
    );
    if (!listing || listing.exitCode !== 0) continue;

    for (const file of listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const read = await runOnDevice(
        driver,
        `sed -n '1,40p' ${JSON.stringify(file)} 2>/dev/null; true`,
        { timeoutMs: 15_000 },
      );
      const meta = parseFrontmatter(read?.stdout ?? "");
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
