import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getSessionUiStateRevision } from "@/lib/session-ui-state";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);

  if (isRemoteDevice(deviceId)) {
    // Remote sessions run on the device, so only this process's live channels
    // are reportable. Same key set as the local branch: the poller is shared.
    // "Live channel" is not "running": an opened session keeps its `pi` process
    // alive so reopening is instant, and reporting those as running left idle
    // sessions spinning forever in the sidebar.
    const {
      getAwaitingInputRemoteRpcSessionIdsForDevice,
      getRunningRemoteRpcSessionIdsForDevice,
    } = await import("@/lib/remote-agent-manager");
    const { getRemoteSessionListVersion } = await import("@/lib/remote-session-store");
    return NextResponse.json(
      {
        // The device's own counter, not a constant: the sidebar reloads its list
        // when this changes, and a hard-coded 0 meant a remote device never saw a
        // session created (or deleted) from another tab.
        sessionListVersion: getRemoteSessionListVersion(deviceId),
        runningSessionIds: getRunningRemoteRpcSessionIdsForDevice(deviceId),
        awaitingInputSessionIds: getAwaitingInputRemoteRpcSessionIdsForDevice(deviceId),
        completionNotificationSuppressedSessionIds: [],
        sessionUiStateRevision: null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      sessionUiStateRevision: getSessionUiStateRevision(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
