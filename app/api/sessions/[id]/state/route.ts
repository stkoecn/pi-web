import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { getRemoteRpcSession } from "@/lib/remote-agent-manager";
import { openRemoteSessionManager } from "@/lib/remote-session-store";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const deviceId = getRequestDeviceId(req);
    if (isRemoteDevice(deviceId)) {
      const live = getRemoteRpcSession(id);
      if (live) {
        // `RPCChannel.send` is fire-and-forget (returns void), so a fresh
        // `get_state` cannot be awaited here. The cached state captured by
        // `createRemoteRpcSession` is the best snapshot available.
        return NextResponse.json({ running: true, state: live.state });
      }
      // Not running: only report idle when the transcript actually exists on
      // the device, so a stale sidebar row 404s instead of looking idle.
      const remote = await openRemoteSessionManager(deviceId, id);
      if (!remote) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      return NextResponse.json({ running: false });
    }

    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
