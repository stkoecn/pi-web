import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import {
  attachSessionProjectInfo,
  openSessionManager,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  buildSessionContext,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { projectTreeForResponse, toSummaryTree } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { startServerPerf } from "@/lib/perf";
import { computeSessionRevision } from "@/lib/session-revision";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { jsonResponse } from "@/lib/json-response";
import { deleteSessions } from "@/lib/session-delete";
import { attachTranscriptNotices, readSessionTranscriptNotices } from "@/lib/transcript-notices-server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { invalidateRemoteSession, openRemoteSessionManager } from "@/lib/remote-session-store";
import { deviceHomeOrDefault } from "@/lib/device-home";
import { DeviceOfflineError } from "@/lib/gateway/singleton";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const perf = startServerPerf("GET /api/sessions/[id]");
  try {
    perf?.span("resolve");
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    const deviceId = getRequestDeviceId(req, searchParams);

    if (isRemoteDevice(deviceId)) {
      // Remote sessions are read through the gateway but built by the SAME
      // builders as the local branch below: `openRemoteSessionManager` returns a
      // `SessionManager.inMemory` over the remote JSONL, so every
      // getEntries/getLeafId/getTree/getHeader call behaves identically. The
      // response shape must stay the `SessionData` that
      // `hooks/useAgentSession.ts` loadSession consumes — never a hand-built one.
      // `?force=1` is the session mount / page refresh path; the local branch
      // evicts a stale wrapper there. The remote equivalent must refresh only
      // THIS session: dropping the whole device cache made every mount pay a
      // catalogue scan plus a transcript fetch (~2 s), while the session's own
      // fingerprint check is already enough to detect a changed transcript.
      if (force) invalidateRemoteSession(deviceId, id);
      const remote = await openRemoteSessionManager(deviceId, id, { force });
      if (!remote) {
        // A session that was just created (or resumed) has a live remote `pi`
        // but no transcript yet: pi writes the JSONL only after the first turn.
        // Answering 404 here made the client clear the chat it was watching, so
        // a brand-new remote session rendered empty until a reload. Serve an
        // empty-but-valid `SessionData` for the live session instead.
        const { getRemoteRpcSession } = await import("@/lib/remote-agent-manager");
        const live = getRemoteRpcSession(id);
        if (!live || live.deviceId !== deviceId) {
          return NextResponse.json({ error: "Session not found" }, { status: 404 });
        }
        const liveCwd = typeof live.state?.cwd === "string" ? live.state.cwd : await deviceHomeOrDefault(deviceId);
        const summaryTree = searchParams.get("tree") === "summary";
        return jsonResponse(req, {
          sessionId: id,
          filePath: typeof live.state?.sessionFile === "string" ? live.state.sessionFile : "",
          info: (await attachSessionProjectInfo([{
            path: typeof live.state?.sessionFile === "string" ? live.state.sessionFile : "",
            id,
            cwd: liveCwd,
            name: typeof live.state?.sessionName === "string" ? live.state.sessionName : undefined,
            created: new Date(live.createdAt).toISOString(),
            modified: new Date().toISOString(),
            messageCount: typeof live.state?.messageCount === "number" ? live.state.messageCount : 0,
            firstMessage: "(no messages)",
            transient: true,
          }], { platform: "linux" }))[0],
          leafId: null,
          tree: [],
          ...(summaryTree ? { treeFormat: "summary" as const } : {}),
          snapshotRevision: null,
          context: {
            messages: [],
            entryIds: [],
            oldestEntryId: null,
            hasMore: false,
            turnsBefore: 0,
            ...(live.state?.thinkingLevel ? { thinkingLevel: live.state.thinkingLevel } : {}),
            ...(live.state?.model ? { model: live.state.model } : {}),
          },
          // The client merges this against live messages with `mergeSessionStats`,
          // which reads `fileStats.tokens.*` and `fileStats.cost` unconditionally:
          // a stats object without them takes the page down.
          stats: {
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: 0,
          },
          totalActiveMs: 0,
        });
      }
      const sm = remote.sm;
      const filePath = remote.filePath;
      const entries = sm.getEntries();
      const leafId = sm.getLeafId();
      const summaryTree = searchParams.get("tree") === "summary";
      const tree = summaryTree
        ? toSummaryTree(projectTreeForResponse(sm.getTree()))
        : projectTreeForResponse(sm.getTree());
      const deferThinking = searchParams.has("deferThinking");
      const deferToolResultImages = searchParams.has("deferMedia");
      const rawTail = Number(searchParams.get("tail"));
      const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
      const transcriptNotices = readSessionTranscriptNotices({
        entries: entries as unknown as SessionEntry[],
        cwd: sm.getHeader()?.cwd ?? "",
        leafId,
        models: undefined,
      });
      const context = attachTranscriptNotices(buildSessionContext(entries as never, leafId, {
        deferThinking,
        deferToolResultImages,
        tail,
        sessionId: id,
        // Lazy tool-result image URLs must carry the device: the browser fetches
        // them later, when nothing else remembers which host the session is on.
        deviceId,
      }), transcriptNotices);
      const totalActiveMs = computeSessionTotalActiveMs(entries);
      const stats = computeSessionStats(entries as unknown as SessionEntry[]);
      const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
      const snapshotRevision = computeSessionRevision({
        filePath,
        // The remote transcript is always read from disk, never from a live
        // wrapper; `+notices` when the notices switch changed the messages.
        sourceId: `remote:${deviceId}${transcriptNotices ? "+notices" : ""}`,
        entryCount: entries.length,
        latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
        leafId: leafId ?? null,
      });
      const sessionName = sm.getSessionName();
      const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
      const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

      const header = sm.getHeader();
      // No statSync: the path lives on another host. The catalogue's mtime is
      // the same fingerprint the cache keys on.
      const modified = remote.mtimeMs
        ? new Date(remote.mtimeMs).toISOString()
        : (header?.timestamp ?? new Date().toISOString());
      // The fork origin needs the remote file list; skipped on this path.
      const parentSessionId = undefined;
      const subagent = header
        ? readSubagentRun(entries as never, header.id, filePath)
        : null;
      const toolNames = readSubagentSessionResources(entries as never)?.tools
        ?? readSessionToolSelection(entries as never);
      const info = header ? (await attachSessionProjectInfo([{
        path: filePath,
        id: header.id,
        cwd: header.cwd ?? "",
        name: sessionName,
        created: header.timestamp,
        modified,
        messageCount: stats.totalMessages,
        firstMessage: firstUserMessage
          ? (() => {
              const c = (firstUserMessage as { content: unknown }).content;
              return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
            })()
          : "(no messages)",
        parentSessionId,
        ...(subagent
          ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagent.status } }
          : header.parentSession
            ? { relation: { kind: "fork" as const } }
            : {}),
        // The file exists — on the remote host. existsSync() would be false here.
        transient: false,
      // `platform: "linux"`: the cwd is a remote path, so the project key has to
      // be normalized with POSIX rules instead of this host's.
      }], { platform: "linux" }))[0] : null;

      return perf?.attach(jsonResponse(
        req,
        {
          sessionId: id,
          filePath,
          info,
          leafId,
          tree,
          ...(summaryTree ? { treeFormat: "summary" as const } : {}),
          snapshotRevision,
          context,
          stats,
          totalActiveMs,
          ...(toolNames !== undefined ? { toolNames } : {}),
        },
      )) ?? jsonResponse(
        req,
        {
          sessionId: id,
          filePath,
          info,
          leafId,
          tree,
          ...(summaryTree ? { treeFormat: "summary" as const } : {}),
          snapshotRevision,
          context,
          stats,
          totalActiveMs,
          ...(toolNames !== undefined ? { toolNames } : {}),
        },
      );
    }

    // --- localhost ---
    const rpc = getRpcSession(id);
    // A live wrapper only reflects the appends pi-web itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);
    perf?.span("open");
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const summaryTree = searchParams.get("tree") === "summary";
    const tree = summaryTree
      ? toSummaryTree(projectTreeForResponse(sm.getTree()))
      : projectTreeForResponse(sm.getTree());
    perf?.span("tree");
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    // pi's showCacheMissNotices (#1265): cache, cost and provider notices on the messages they follow.
    const transcriptNotices = readSessionTranscriptNotices({
      entries: entries as unknown as SessionEntry[],
      cwd: sm.getHeader()?.cwd ?? "",
      leafId: leafId,
      models: liveRpc?.inner.modelRuntime,
    });
    const context = attachTranscriptNotices(buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    }), transcriptNotices);
    perf?.span("context");
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    perf?.span("stats");
    // Opaque freshness token for the session view cache. Derived from the
    // disk fingerprint and the actual read source; null tells the client the
    // snapshot is unstable and must not be cached as fresh.
    const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
    const snapshotRevision = computeSessionRevision({
      filePath,
      // The notices switch changes the messages without touching the file.
      sourceId: `${liveRpc ? `runtime:${String(liveRpc.inner.sessionId)}` : "disk"}${transcriptNotices ? "+notices" : ""}`,
      entryCount: entries.length,
      latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
      leafId: leafId ?? null,
    });
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return perf?.attach(jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        ...(summaryTree ? { treeFormat: "summary" as const } : {}),
        snapshotRevision,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      },
    )) ?? jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        ...(summaryTree ? { treeFormat: "summary" as const } : {}),
        snapshotRevision,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      },
    );
  } catch (error) {
    // An offline device is a state the user can act on, not a server fault: the
    // client shows a reconnect hint instead of the ten-second wait and a 500.
    if (error instanceof DeviceOfflineError) {
      return jsonResponse(
        req,
        { error: error.message, code: error.code, deviceId: error.deviceId },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Rename appends to a file on this host. On a remote device that would name
  // the wrong transcript, so refuse explicitly (see fork/delete).
  if (isRemoteDevice(getRequestDeviceId(req))) {
    return NextResponse.json({ error: "Not supported on remote devices yet" }, { status: 501 });
  }
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // PATCH writes via appendSessionInfo — open fresh, bypassing the cache.
    const sm = openSessionManager(filePath, { mutable: true });
    sm.appendSessionInfo(name.trim());
    invalidateSessionManagerCache(filePath);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id] - the session and the subagent sessions below it (lib/session-delete.ts).
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Deleting here would remove a local session the user never pointed at:
  // delete it on the device instead.
  if (isRemoteDevice(getRequestDeviceId(req))) {
    const deviceId = getRequestDeviceId(req);
    try {
      const { deleteRemoteSessions } = await import("@/lib/remote-session-delete");
      const { missing } = await deleteRemoteSessions(deviceId, [id]);
      if (missing.length > 0) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A device that is offline is a state the user can act on, not a server
      // fault: say so, and say it at once (see getOnlineDriver).
      const offline = message.includes("is not connected or offline");
      return NextResponse.json(
        { error: offline ? "The device is offline. Reconnect it, then delete again." : message, code: offline ? "device-offline" : undefined },
        { status: offline ? 503 : 500 },
      );
    }
  }
  try {
    const { missing } = await deleteSessions([id]);
    if (missing.length > 0) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
