import "server-only";
import type { ProjectTrustStatus } from "@/lib/api-types";
import { getGateway } from "@/lib/gateway/singleton";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { shellQuote } from "@/lib/shell-quote";

/**
 * Project trust as a *device* keeps it.
 *
 * `lib/project-trust.ts` answers trust for this machine: it reads `trust.json`
 * here, stats `.pi/` here, and walks this filesystem. A device's folders are not
 * paths on this machine at all, so every one of those calls answers "no such
 * folder" and the panel would refuse every project write on a device that is
 * perfectly trusted there. The device itself is asked instead, in one round
 * trip that also carries the files the caller needs, so a pane or a write does
 * not pay a second round trip for the trust it needs to decide with.
 *
 * The rules are pi's own (`dist/core/trust-manager.js`): a folder requires trust
 * when `<cwd>/.pi/` holds a trust-requiring entry or `.agents/skills` exists at
 * or above it (the user's own `$HOME/.agents/skills` excepted), and the decision
 * is the nearest `true`/`false` at or above the folder in `trust.json`. Writing
 * one is the store's own bytes: sorted keys, two-space JSON, one trailing
 * newline.
 */

/** The `.pi/` entries that make a folder require trust, as the SDK lists them. */
export const REMOTE_TRUST_ENTRIES = [
  "settings.json",
  "mcp.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

const HOME_MARKER = "PIWEB-HOME";
const DIR_MARKER = "PIWEB-DIR";
const REAL_MARKER = "PIWEB-REAL";
const ENTRY_MARKER = "PIWEB-ENTRY";
const SKILLS_MARKER = "PIWEB-SKILLS";
const TRUST_MARKER = "PIWEB-TRUST";
const FILE_MARKER = "PIWEB-FILE";

export interface RemoteTrustSnapshot {
  /** Whether `cwd` is a directory on the device; always false when no cwd was asked about. */
  directoryExists: boolean;
  /** The device's `$HOME`. */
  home: string;
  /** `pwd -P` of `cwd`: where it really leads, for a folder reached through a link. */
  realPath: string;
  /** Which of `REMOTE_TRUST_ENTRIES` `<cwd>/.pi/` holds. */
  entries: string[];
  /** The nearest folder at or above `cwd` holding `.agents/skills`, unless it is the user's own. */
  skillsDir?: string;
  /** The parsed `trust.json`, or undefined when the device has none. */
  trust?: Record<string, boolean | null>;
  /** Why `trust.json` could not be read: an unparsable or wrongly shaped file. */
  trustError?: string;
  /** The files asked for, by their path on the device; a missing file has no entry. */
  files: Map<string, string>;
}

/**
 * The script that answers everything in one round trip.
 *
 * Base64-wrapped like every other device script: the login shell then only ever
 * sees an opaque blob, so quoting, globs and `$` behave the same on every device
 * (macOS's zsh aborts a script holding an unmatched glob).
 */
function snapshotScript(agentDir: string, cwd: string | null, files: readonly string[]): string {
  const lines: string[] = [`printf '%s %s\\n' '${HOME_MARKER}' "$HOME"`];
  if (cwd !== null) {
    lines.push(
      `if [ -d ${shellQuote(cwd)} ]; then`,
      `  printf '%s ok\\n' '${DIR_MARKER}'`,
      `  printf '%s %s\\n' '${REAL_MARKER}' "$(cd ${shellQuote(cwd)} && pwd -P)"`,
      `  for e in ${REMOTE_TRUST_ENTRIES.join(" ")}; do`,
      `    if [ -e ${shellQuote(`${cwd}/.pi/`)}"$e" ] || [ -L ${shellQuote(`${cwd}/.pi/`)}"$e" ]; then`,
      `      printf '%s %s\\n' '${ENTRY_MARKER}' "$e"`,
      `    fi`,
      `  done`,
      `  d=${shellQuote(cwd)}`,
      `  while :; do`,
      `    if [ -d "$d/.agents/skills" ] && [ "$d/.agents/skills" != "$HOME/.agents/skills" ]; then`,
      `      printf '%s %s\\n' '${SKILLS_MARKER}' "$d"`,
      `      break`,
      `    fi`,
      `    p=$(dirname "$d")`,
      `    if [ "$p" = "$d" ]; then break; fi`,
      `    d="$p"`,
      `  done`,
      `else`,
      `  printf '%s missing\\n' '${DIR_MARKER}'`,
      `fi`,
    );
  }
  lines.push(
    `if [ -f ${shellQuote(`${agentDir}/trust.json`)} ]; then`,
    `  printf '%s\\n' '${TRUST_MARKER}'`,
    `  base64 < ${shellQuote(`${agentDir}/trust.json`)}`,
    `fi`,
  );
  files.forEach((path, index) => {
    lines.push(
      `if [ -f ${shellQuote(path)} ]; then`,
      `  printf '%s %s\\n' '${FILE_MARKER}' '${index}'`,
      `  base64 < ${shellQuote(path)}`,
      `fi`,
    );
  });
  return lines.join("\n");
}

/** The `trust.json` pi writes: only true/false/null values, keys sorted, one trailing newline. */
export function serializeRemoteTrust(data: Record<string, boolean | null>): string {
  const sorted: Record<string, boolean | null> = {};
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === true || value === false || value === null) sorted[key] = value;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** A `trust.json` read from the device, or why it cannot be used; pi's own rules. */
export function parseRemoteTrust(text: string | undefined): {
  trust?: Record<string, boolean | null>;
  trustError?: string;
} {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { trustError: `Failed to read trust store: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { trustError: "Invalid trust store: expected an object" };
  }
  const data: Record<string, boolean | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== true && value !== false && value !== null) {
      return { trustError: `Invalid trust store: value for ${JSON.stringify(key)} must be true, false, or null` };
    }
    data[key] = value;
  }
  return { trust: data };
}

/** A folder as `trust.json` keys it: absolute, with no trailing slash and no `.`/`..` left. */
function trustKey(cwd: string): string {
  const parts: string[] = [];
  for (const part of cwd.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * The nearest decision at or above `cwd`, as pi's `findNearestTrustEntry()` finds
 * it: only `true` and `false` count, a `null` entry is a removed decision and is
 * walked past. Both where the folder really leads and the path as given are
 * tried, so a folder reached through a link finds the decision pi wrote for its
 * target. `inherited` compares against pi's own key (the canonical path), the way
 * `describeDecision()` does here.
 */
export function nearestRemoteTrustDecision(
  trust: Record<string, boolean | null> | undefined,
  cwd: string,
  realPath?: string,
): { decision: boolean; path: string; inherited: boolean } | undefined {
  if (!trust) return undefined;
  const canonical = trustKey(realPath || cwd);
  const starts = canonical === trustKey(cwd) ? [canonical] : [canonical, trustKey(cwd)];
  for (const start of starts) {
    let current = start;
    while (true) {
      const value = trust[current];
      if (value === true || value === false) return { decision: value, path: current, inherited: current !== canonical };
      const parent = current.replace(/\/[^/]*$/, "");
      if (parent === current || parent === "") break;
      current = parent;
    }
  }
  return undefined;
}

/** The folder's trust as the device sees it, from one snapshot. */
export function remoteProjectTrustStatus(snapshot: RemoteTrustSnapshot, cwd: string): ProjectTrustStatus {
  const requiresTrust = snapshot.entries.length > 0 || snapshot.skillsDir !== undefined;
  const found = nearestRemoteTrustDecision(snapshot.trust, cwd, snapshot.realPath);
  const base = {
    requiresTrust,
    decision: found?.decision ?? null,
    inherited: found?.inherited ?? false,
    ...(found ? { decisionPath: found.path } : {}),
  };
  if (snapshot.trustError !== undefined) {
    return { ...base, trusted: !requiresTrust, decisionError: snapshot.trustError };
  }
  return { ...base, trusted: requiresTrust ? found?.decision === true : true };
}

/** Read the device's trust for `cwd` plus the files the caller needs, in one round trip. */
export async function readRemoteTrustSnapshot(
  driver: IHostDriver,
  agentDir: string,
  cwd: string | null,
  files: readonly string[] = [],
  timeoutMs = 20_000,
): Promise<RemoteTrustSnapshot> {
  const snapshot: RemoteTrustSnapshot = {
    directoryExists: false,
    home: "",
    realPath: "",
    entries: [],
    files: new Map(),
  };
  const script = snapshotScript(agentDir, cwd, files);
  const result = await driver.exec(
    `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
    [],
    { timeoutMs },
  );
  if (result.exitCode !== 0) return snapshot;

  // Every marker starts a line of its own; the payload lines after one are base64
  // until the next marker. Nothing in base64 can spell a marker, so the split is
  // unambiguous.
  type Sink = { kind: "trust" } | { kind: "file"; path: string } | undefined;
  let sink: Sink;
  let encoded: string[] = [];
  const flush = () => {
    if (!sink) return;
    const text = Buffer.from(encoded.join(""), "base64").toString("utf8");
    if (sink.kind === "trust") {
      const parsed = parseRemoteTrust(text);
      if (parsed.trust) snapshot.trust = parsed.trust;
      if (parsed.trustError) snapshot.trustError = parsed.trustError;
    } else {
      snapshot.files.set(sink.path, text);
    }
    sink = undefined;
    encoded = [];
  };

  for (const line of result.stdout.split("\n")) {
    const fileMatch = new RegExp(`^${FILE_MARKER} ([0-9]+)$`).exec(line);
    if (fileMatch) {
      flush();
      const path = files[Number(fileMatch[1])];
      if (path !== undefined) sink = { kind: "file", path };
      continue;
    }
    if (line === TRUST_MARKER) {
      flush();
      sink = { kind: "trust" };
      continue;
    }
    if (line.startsWith(`${HOME_MARKER} `)) {
      snapshot.home = line.slice(HOME_MARKER.length + 1).trim();
      continue;
    }
    if (line.startsWith(`${DIR_MARKER} `)) {
      snapshot.directoryExists = line.slice(DIR_MARKER.length + 1).trim() === "ok";
      continue;
    }
    if (line.startsWith(`${REAL_MARKER} `)) {
      snapshot.realPath = line.slice(REAL_MARKER.length + 1).trim();
      continue;
    }
    if (line.startsWith(`${ENTRY_MARKER} `)) {
      snapshot.entries.push(line.slice(ENTRY_MARKER.length + 1).trim());
      continue;
    }
    if (line.startsWith(`${SKILLS_MARKER} `)) {
      snapshot.skillsDir = line.slice(SKILLS_MARKER.length + 1).trim();
      continue;
    }
    if (sink) encoded.push(line.trim());
  }
  flush();
  return snapshot;
}

/** Trusting the folder would also trust this, so Pi Web does not do it. */
export interface RemoteTrustBreadth {
  kind: "root" | "home" | "contains-home" | "contains-agent-dir";
  path: string;
}

/**
 * Why `cwd` is too broad to trust in one step, in the order
 * `freshFolderTrustBreadth()` checks it. The `contains-folder` case is this
 * machine's own project list and has no meaning on a device; `inherits` is a
 * *freshness* answer, not breadth, and is checked with the rest of freshness.
 */
export function remoteTrustBreadth(
  snapshot: RemoteTrustSnapshot,
  cwd: string,
  agentDir: string,
): RemoteTrustBreadth | undefined {
  const folder = trustKey(cwd);
  const within = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`);
  if (folder === "/") return { kind: "root", path: "/" };
  if (snapshot.home && folder === trustKey(snapshot.home)) return { kind: "home", path: folder };
  if (snapshot.home && within(trustKey(snapshot.home), folder)) return { kind: "contains-home", path: folder };
  if (within(trustKey(agentDir), folder)) return { kind: "contains-agent-dir", path: folder };
  return undefined;
}

/** Whether the folder is fresh: no trust-requiring resources, and no decision at or above it. */
export function remoteFolderIsFresh(snapshot: RemoteTrustSnapshot, cwd: string): boolean {
  if (snapshot.entries.length > 0 || snapshot.skillsDir !== undefined) return false;
  return nearestRemoteTrustDecision(snapshot.trust, cwd, snapshot.realPath) === undefined;
}

/** Write one decision into the device's `trust.json`, keeping every other key. */
export async function setRemoteTrust(
  driver: IHostDriver,
  agentDir: string,
  cwd: string,
  decision: boolean | null,
  timeoutMs = 20_000,
): Promise<void> {
  const path = `${agentDir}/trust.json`;
  const current = await readRemoteTrustSnapshot(driver, agentDir, null, [path], timeoutMs);
  const data = { ...(current.trust ?? {}) };
  const key = trustKey(cwd);
  if (decision === null) delete data[key];
  else data[key] = decision;
  const { writeRemoteFile } = await import("@/lib/remote-settings-file");
  await writeRemoteFile(driver, path, serializeRemoteTrust(data), timeoutMs);
}

interface TrustCacheEntry {
  value: ProjectTrustStatus;
  expiresAt: number;
}

const TRUST_CACHE_TTL_MS = 30_000;

// Hot reload re-evaluates modules; globalThis keeps one cache per process.
function trustCache(): Map<string, TrustCacheEntry> {
  const store = globalThis as Record<symbol, Map<string, TrustCacheEntry> | undefined>;
  return (store[Symbol.for("pi-web:remote-trust-cache")] ??= new Map());
}

/** Drop cached trust for one device, or every device; a write changes what it says. */
export function invalidateRemoteTrust(deviceId?: string): void {
  const cache = trustCache();
  if (deviceId === undefined) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${deviceId}\u0000`)) cache.delete(key);
  }
}

/**
 * The device's trust for a folder, cached for a moment.
 *
 * The pane asks on every read, and the answer only changes when someone trusts a
 * folder (this panel, the pi CLI, or a `trust.json` edited by hand), so a short
 * cache keeps a pane open from costing a round trip per render. Writes invalidate
 * it, and so does anything that changes `.pi/` on the device; a stale answer can
 * only ever be a moment old and is corrected by the next read.
 */
export async function cachedRemoteProjectTrust(deviceId: string, cwd: string): Promise<ProjectTrustStatus | undefined> {
  const key = `${deviceId}\u0000${cwd}`;
  const cache = trustCache();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const { getRemoteAgentDir } = await import("@/lib/remote-settings");
    const driver = await getGateway().getDriverForRequest(deviceId);
    const agentDir = await getRemoteAgentDir(deviceId);
    const snapshot = await readRemoteTrustSnapshot(driver, agentDir, cwd);
    if (!snapshot.directoryExists) return undefined;
    const value = remoteProjectTrustStatus(snapshot, cwd);
    cache.set(key, { value, expiresAt: Date.now() + TRUST_CACHE_TTL_MS });
    return value;
  } catch {
    return undefined;
  }
}
