import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { SessionForkError } from "./session-fork";
import { forkSessionName, sessionDisplayTitle } from "./session-fork-name";
import { readSubagentRun } from "./subagents";
import type { SessionEntry } from "./types";

/**
 * The file a remote Fork writes, built without touching any filesystem.
 *
 * `forkRemoteSession` (lib/remote-session-fork.ts) reads the transcript off the
 * device and writes the copy back over there; everything in between is here, so
 * the shape of a remote fork can be tested without a device.
 *
 * pi's own `SessionManager` computes the branch — label re-chaining, a fresh
 * header, a new session id — exactly as `forkSessionBranch` gets it locally, so
 * a remote copy is indistinguishable from a local one.
 */

export interface RemoteForkFile {
  sessionId: string;
  /** The copy header's timestamp: the session directory names its file by it. */
  timestamp: string;
  /** The `.jsonl` contents, one entry per line, trailing newline included. */
  contents: string;
  /**
   * The copy's `session_info` name, or undefined when the source showed no
   * title (`(no messages)`) and so must not get one.
   */
  name?: string;
  /** The branch the copy was cut from, in order. */
  branch: SessionEntry[];
}

/** `timestamp`'s file-safe form, `<date>T<hh>-<mm>-<ss>-<ms>Z`. */
export function sessionFileTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

/**
 * Build the copy of `entries` for a Fork of `<cwd>`'s session at `sourcePath`.
 *
 * `sourceTitle` is the title the sidebar shows for the source; null means "the
 * source has no title" (a fork of that copy gets none either), undefined means
 * "not known" and falls back to the source's id, as the local route does.
 */
export function buildForkedSession(options: {
  /** Every line of the source, header included (pi's `parseSessionEntries`). */
  entries: readonly FileEntry[];
  cwd: string;
  sourcePath: string;
  sourceTitle?: string | null;
  suffix: string;
}): RemoteForkFile {
  const { entries, cwd, sourcePath, sourceTitle, suffix } = options;
  if (entries.length === 0) throw new SessionForkError("not_found", "Session not found");

  const manager = SessionManager.inMemory(cwd || "/", undefined, [...entries]);
  const leafId = manager.getLeafId();
  if (!leafId || !manager.getEntry(leafId)) {
    throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  }
  const branch = manager.getBranch(leafId) as unknown as SessionEntry[];
  // A copy carrying a subagent's metadata would be read as that subagent and
  // folded, out of sight, into its parent's family.
  if (readSubagentRun(branch, "", sourcePath)) {
    throw new SessionForkError("subagent", "A subagent session cannot be forked");
  }
  if (!branch.some((entry) => entry.type === "message")) {
    throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  }

  // Read before createBranchedSession() repoints the in-memory instance.
  const name = sourceTitle === null
    ? undefined
    : forkSessionName(
        sourceTitle?.trim() || sessionDisplayTitle({
          id: manager.getSessionId(),
          firstMessage: "",
        }),
        suffix,
        typeof manager.getHeader()?.parentSession === "string",
      );

  // In-memory manager: this rewrites its own entry list into the branch and
  // gives it a fresh session id and header, but writes no file.
  manager.createBranchedSession(leafId);
  const header = manager.getHeader();
  if (!header) throw new Error("Failed to fork the session");
  // Two fields are about *this* machine by the time the manager is done, and
  // both are wrong for the copy: the cwd was normalised for the platform pi-web
  // runs on (`/Users/x` became `D:\Users\x` on Windows), and an in-memory
  // manager has no source path. The fork is a session on the device, so both are
  // restated in the device's own terms.
  header.cwd = cwd || "/";
  header.parentSession = sourcePath;
  if (name) manager.appendSessionInfo(name);

  const copied = [header, ...manager.getEntries()];
  return {
    sessionId: manager.getSessionId(),
    timestamp: typeof header.timestamp === "string" ? header.timestamp : new Date().toISOString(),
    contents: `${copied.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    ...(name ? { name } : {}),
    branch,
  };
}
