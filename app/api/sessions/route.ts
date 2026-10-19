import { NextResponse } from "next/server";
import path from "path";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { startServerPerf } from "@/lib/perf";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const deviceId = searchParams.get("deviceId") || req.headers.get("x-device-id");

    if (deviceId && deviceId !== "localhost") {
      const { getGateway } = await import("@/lib/gateway/singleton");
      const { getAllRemoteRpcSessions } = await import("@/lib/remote-agent-manager");
      const driver = await getGateway().getOrConnectDriver(deviceId);

      // Active remote sessions in memory
      const activeRemote = getAllRemoteRpcSessions()
        .filter(s => s.deviceId === deviceId)
        .map(s => ({
          id: s.sessionId,
          path: `remote://${deviceId}/${s.sessionId}`,
          cwd: s.state?.cwd || "/root",
          created: new Date(s.createdAt).toISOString(),
          modified: new Date().toISOString(),
          messageCount: s.state?.messageCount || 0,
          firstMessage: "Remote Pi Session",
        }));

      // Remote persisted files
      const findRes = await driver.exec('find ~/.pi/agent/sessions/ -name "*.jsonl" 2>/dev/null | head -n 20 || echo ""');
      const files = (findRes.stdout || "").trim().split("\n").filter(Boolean);

      const persistedRemote: any[] = [];
      for (const f of files) {
        try {
          const headRes = await driver.exec(`head -n 1 "${f}" 2>/dev/null`);
          const line = headRes.stdout.trim();
          if (line.startsWith("{")) {
            const meta = JSON.parse(line);
            persistedRemote.push({
              id: meta.id || path.basename(f, ".jsonl"),
              path: f,
              cwd: meta.cwd || "/root",
              created: meta.timestamp || new Date().toISOString(),
              modified: meta.timestamp || new Date().toISOString(),
              messageCount: 1,
              firstMessage: meta.firstMessage || `Session ${meta.id?.slice(0, 8)}`,
            });
          }
        } catch {}
      }

      const allSessions = [...activeRemote, ...persistedRemote.filter(p => !activeRemote.some(a => a.id === p.id))];
      return jsonResponse(req, {
        sessions: allSessions,
        sessionListVersion: 1,
        runningSessionIds: activeRemote.map(s => s.id),
        awaitingInputSessionIds: [],
        completionNotificationSuppressedSessionIds: [],
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    perf?.span("scan+projects");
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    return perf?.attach(jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    )) ?? jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
