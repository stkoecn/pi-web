import "server-only";
import { getGateway } from "@/lib/gateway/singleton";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { getRemoteAgentDir } from "@/lib/remote-settings";
import { readRemoteTextFile } from "@/lib/remote-files";
import { shellQuote } from "@/lib/shell-quote";
import { closeRemoteRpcSession, getRemoteRpcSessionIdsForDevice } from "@/lib/remote-agent-manager";
import { invalidateRemoteSessionCache } from "@/lib/remote-session-store";
import type { SessionDeleteResult } from "@/lib/session-delete";

/**
 * Deleting a session on a remote device.
 *
 * The local `deleteSessions` (lib/session-delete.ts) works on this machine's
 * filesystem, so a remote device needs its own pass — but it must reach the
 * same outcome: the named sessions and every subagent session below them go,
 * subagents first, and a session left behind whose parent went is re-pointed at
 * the nearest ancestor that stays.
 *
 * Cost is bounded to two round trips however many sessions are deleted: one
 * scan that reads every header (and each file's subagent metadata) on the
 * device, and one `rm`. Re-parenting a survivor is the only case that touches
 * file contents, and it only happens when a fork's origin is deleted.
 */

/** `sessionPathKey` for POSIX paths: the device's paths are already absolute. */
function pathKey(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

interface DeviceSessionFile {
  path: string;
  sessionId: string;
  /** The header's `parentSession`: a fork's origin, display metadata only. */
  parentSession?: string;
  /** The subagent metadata's `parentSessionPath`: the session that spawned it. */
  subagentParentPath?: string;
}

/** The id a session file carries: `<timestamp>_<id>.jsonl`. */
function sessionIdOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.jsonl$/, "").split("_").pop() ?? "";
}

/**
 * Every session file on the device with the two links deletion cares about, in
 * one round trip. Only the first line of each file and its single subagent
 * metadata line are read, so a folder of hundreds of sessions stays cheap.
 */
async function scanDeviceSessions(
  driver: IHostDriver,
  agentDir: string,
): Promise<DeviceSessionFile[]> {
  const sessionsDir = `${agentDir}/sessions`;
  const script = `
__dir=${shellQuote(sessionsDir)}
[ -d "$__dir" ] || exit 0
find "$__dir" -name '*.jsonl' -type f 2>/dev/null | while IFS= read -r path; do
  printf '@@P %s\\n' "$path"
  head -n 1 "$path" 2>/dev/null | cut -c1-2000
  grep -m 1 '"customType":"subagent-meta"' "$path" 2>/dev/null | cut -c1-2000 | sed 's/^/@@S /'
done
`;
  const result = await driver.exec(script, [], { timeoutMs: 120_000 });
  const files: DeviceSessionFile[] = [];
  let current: DeviceSessionFile | null = null;

  const parse = (line: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };

  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("@@P ")) {
      const path = line.slice(4);
      if (!path.endsWith(".jsonl")) {
        current = null;
        continue;
      }
      current = { path, sessionId: sessionIdOfPath(path) };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@S ")) {
      const meta = parse(line.slice(4));
      const data = meta && typeof meta.data === "object" && meta.data ? meta.data as Record<string, unknown> : null;
      if (data && typeof data.parentSessionPath === "string") current.subagentParentPath = data.parentSessionPath;
      continue;
    }
    if (line.startsWith("{")) {
      const header = parse(line);
      if (header?.type === "session") {
        if (typeof header.id === "string" && header.id) current.sessionId = header.id;
        if (typeof header.parentSession === "string") current.parentSession = header.parentSession;
      }
    }
  }
  return files;
}

/**
 * Deletes `ids` and the subagent sessions below them on `deviceId`.
 *
 * With `keepRunning`, a family containing a session that is live on the device
 * is kept and reported, exactly as the local path does: a bulk delete the user
 * confirmed a moment ago must not abort a run that started since.
 */
export async function deleteRemoteSessions(
  deviceId: string,
  ids: readonly string[],
  options: { keepRunning?: boolean } = {},
): Promise<SessionDeleteResult> {
  // Deleting is a click the user watches, so it must not wait out a reconnect:
  // an offline device is reported at once and the pool reconnects on its own.
  const driver = getGateway().getOnlineDriver(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const scanned = await scanDeviceSessions(driver, agentDir);

  const byPath = new Map(scanned.map((file) => [pathKey(file.path), file]));
  const byId = new Map(scanned.map((file) => [file.sessionId, file]));

  const missing: string[] = [];
  const targets = new Map<string, DeviceSessionFile>();
  for (const id of new Set(ids)) {
    const file = byId.get(id);
    if (file) targets.set(id, file);
    else missing.push(id);
  }
  if (targets.size === 0) return { deleted: [], missing, running: [] };

  // Subagents are linked by the metadata's parentSessionPath, not by the
  // header's parentSession (that one records a fork's origin).
  const childrenByParentPath = new Map<string, DeviceSessionFile[]>();
  for (const file of scanned) {
    if (!file.subagentParentPath) continue;
    const key = pathKey(file.subagentParentPath);
    const siblings = childrenByParentPath.get(key) ?? [];
    siblings.push(file);
    childrenByParentPath.set(key, siblings);
  }

  const runningIds = options.keepRunning
    ? new Set(getRemoteRpcSessionIdsForDevice(deviceId))
    : new Set<string>();

  const doomed = new Map<string, DeviceSessionFile>();
  const running: string[] = [];
  for (const [id, file] of targets) {
    if (doomed.has(file.path)) continue;
    const family: DeviceSessionFile[] = [];
    const seen = new Set<string>();
    const visit = (node: DeviceSessionFile) => {
      const key = pathKey(node.path);
      if (seen.has(key) || doomed.has(node.path)) return;
      seen.add(key);
      for (const child of childrenByParentPath.get(key) ?? []) visit(child);
      family.push(node);
    };
    visit(file);
    if (family.some((node) => runningIds.has(node.sessionId))) {
      running.push(id);
      continue;
    }
    for (const node of family) doomed.set(node.path, node);
  }
  if (doomed.size === 0) return { deleted: [], missing, running };

  // Stop the live agents first: a running `pi` would rewrite its transcript
  // after the unlink and leave the file behind.
  for (const node of doomed.values()) closeRemoteRpcSession(node.sessionId);

  const doomedKeys = new Set([...doomed.keys()].map(pathKey));
  const survivors = scanned.filter((file) => !doomedKeys.has(pathKey(file.path)));

  // Re-attach a survivor whose parent is gone to the nearest ancestor that
  // stays. `parentSession` is display metadata, so the rewrite is safe.
  const parentOf = (path: string | undefined): string | undefined =>
    path ? byPath.get(pathKey(path))?.parentSession : undefined;
  const survivingParent = (parent: string | undefined): string | undefined => {
    const seen = new Set<string>();
    let current = parent;
    while (current) {
      const key = pathKey(current);
      if (!doomedKeys.has(key)) return current;
      if (seen.has(key)) return undefined;
      seen.add(key);
      current = parentOf(current);
    }
    return undefined;
  };

  const reparented: Array<{ path: string; parent: string | undefined }> = [];
  for (const file of survivors) {
    if (!file.parentSession || !doomedKeys.has(pathKey(file.parentSession))) continue;
    const next = survivingParent(file.parentSession);
    if (next === file.parentSession) continue;
    reparented.push({ path: file.path, parent: next });
  }

  const removed = [...doomed.keys()];
  const rmResult = await driver.exec(
    `for f in ${removed.map(shellQuote).join(" ")}; do rm -f -- "$f"; done; true`,
    [],
    { timeoutMs: 60_000 },
  );
  if (rmResult.exitCode !== 0) {
    throw new Error(rmResult.stderr.trim() || `Failed to delete ${removed.length} session file(s)`);
  }

  for (const { path, parent } of reparented) {
    try {
      const content = await readRemoteTextFile(driver, path);
      const newlineAt = content.indexOf("\n");
      const headerLine = newlineAt === -1 ? content : content.slice(0, newlineAt);
      const rest = newlineAt === -1 ? "" : content.slice(newlineAt);
      const header = JSON.parse(headerLine) as Record<string, unknown>;
      if (parent) header.parentSession = parent;
      else delete header.parentSession;
      await driver.writeFile(path, `${JSON.stringify(header)}${rest}`);
    } catch {
      // A header this process cannot rewrite leaves a dangling origin id, which
      // the sidebar already tolerates; the deletion itself has succeeded.
    }
  }

  invalidateRemoteSessionCache(deviceId);
  return { deleted: [...doomed.values()].map((file) => file.sessionId), missing, running };
}
