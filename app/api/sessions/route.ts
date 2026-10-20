import { NextResponse } from "next/server";
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
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { DeviceOfflineError } from "@/lib/gateway/singleton";
import { listRemoteSessions } from "@/lib/remote-session-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const deviceId = getRequestDeviceId(req, searchParams);
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";

    if (isRemoteDevice(deviceId)) {
      // Same key set as the local branch, same `SessionInfo` shape: the sidebar
      // cannot tell the two apart. `lib/remote-session-store.ts` does the whole
      // catalogue in one round trip (find + one awk pass), not one exec per file.
      const { getAllRemoteRpcSessions } = await import("@/lib/remote-agent-manager");
      // An offline device must answer immediately: `getOrConnectDriver` polls for
      // 10 s before it gives up, and the sidebar polls this route. An empty
      // catalogue plus `deviceOnline: false` lets the UI say "offline" at once
      // while the pool keeps reconnecting in the background.
      const { getGateway } = await import("@/lib/gateway/singleton");
      const entry = getGateway().registry.get(deviceId);
      const online = Boolean(entry && entry.driver.isAlive());
      if (!online) {
        return jsonResponse(req, {
          sessions: [],
          sessionListVersion: getSessionListVersion(),
          runningSessionIds: [],
          awaitingInputSessionIds: [],
          completionNotificationSuppressedSessionIds: [],
          deviceOnline: false,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const sessions = await listRemoteSessions(deviceId, { force, deferDetails: summary });
      perf?.span("remote-scan");
      return jsonResponse(req, {
        sessions,
        sessionListVersion: getSessionListVersion(),
        runningSessionIds: getAllRemoteRpcSessions()
          .filter((s) => s.deviceId === deviceId)
          .map((s) => s.sessionId),
        awaitingInputSessionIds: [],
        completionNotificationSuppressedSessionIds: [],
        deviceOnline: true,
      }, { headers: { "Cache-Control": "no-store" } });
    }

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
    // The sidebar polls this route, so a device mid-reconnect must not answer
    // 500 (that reads as a broken app): 503 says the device, not the app, is away.
    if (error instanceof DeviceOfflineError) {
      return NextResponse.json(
        { error: error.message, code: error.code, deviceId: error.deviceId },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
