import "server-only";
import { randomBytes } from "node:crypto";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { getGateway } from "@/lib/gateway/singleton";
import { shellQuote } from "@/lib/shell-quote";
import { buildForkedSession, sessionFileTimestamp } from "@/lib/remote-fork-file";
import { SessionForkError } from "@/lib/session-fork";
import { sessionDisplayTitle } from "@/lib/session-fork-name";
import {
  findRemoteSessionFile,
  invalidateRemoteSessionCache,
  listRemoteSessions,
  readRemoteSessionContent,
} from "@/lib/remote-session-store";
import type { SessionInfo } from "@/lib/types";

/**
 * The sidebar's Fork on a *remote* device.
 *
 * `forkSessionBranch` (lib/session-fork.ts) copies a file on this machine, so a
 * remote device needs the same pass with the copy written over there. The copy
 * itself is still built by pi's own `SessionManager` (lib/remote-fork-file.ts),
 * so a remote fork is byte-shaped like a local one.
 *
 * Cost is three round trips no matter how long the transcript is: read the
 * source, write the copy, re-list to answer with the row.
 */

/** The title the source row shows; undefined when the row itself is unknown. */
function sourceTitleOf(row: SessionInfo | undefined): string | null | undefined {
  if (!row) return undefined;
  if (!row.name && row.firstMessage === "(no messages)") return null;
  return sessionDisplayTitle(row).trim() || undefined;
}

export interface RemoteForkResult {
  sessionId: string;
  session: SessionInfo;
}

/**
 * Fork `sessionId` on `deviceId` at its saved leaf.
 *
 * A session still being written by a `pi` on the device is forked from what is
 * already on disk — the same rule the local path applies to a run in progress.
 */
export async function forkRemoteSession(
  deviceId: string,
  sessionId: string,
): Promise<RemoteForkResult> {
  const file = await findRemoteSessionFile(deviceId, sessionId);
  if (!file) throw new SessionForkError("not_found", "Session not found");

  const [content, rows] = await Promise.all([
    readRemoteSessionContent(deviceId, file),
    // Almost always the catalogue the sidebar just loaded; used only for the
    // name the copy inherits.
    listRemoteSessions(deviceId).catch(() => [] as SessionInfo[]),
  ]);

  const fork = buildForkedSession({
    entries: parseSessionEntries(content),
    cwd: file.cwd,
    sourcePath: file.path,
    sourceTitle: sourceTitleOf(rows.find((row) => row.id === sessionId)),
    suffix: randomBytes(2).toString("hex"),
  });

  const directory = file.path.slice(0, file.path.lastIndexOf("/"));
  const targetPath = `${directory}/${sessionFileTimestamp(fork.timestamp)}_${fork.sessionId}.jsonl`;

  // Never overwrite: a session file is opened by id elsewhere, so a silent
  // replacement would destroy a transcript.
  const script = [
    `[ -e ${shellQuote(targetPath)} ] && exit 3`,
    `printf %s ${shellQuote(Buffer.from(fork.contents, "utf8").toString("base64"))} | base64 -d > ${shellQuote(targetPath)} || exit 4`,
  ].join("\n");
  const result = await getGateway().getOnlineDriver(deviceId).exec(
    `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
    [],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode === 3) throw new Error("The forked session already exists");
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Failed to write the fork (exit ${result.exitCode})`);
  }

  // The catalogue's rows were scanned before the copy existed.
  invalidateRemoteSessionCache(deviceId);
  const created = (await listRemoteSessions(deviceId)).find((row) => row.id === fork.sessionId);
  if (!created) throw new Error("The forked session could not be read");
  // Only the copy was scanned, so its origin is added here (as the local route does).
  return {
    sessionId: fork.sessionId,
    session: {
      ...created,
      parentSessionId: sessionId,
      relation: { kind: "fork", originSessionId: sessionId },
    },
  };
}
