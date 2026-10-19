import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents, type SessionSearchResponse } from "@/lib/session-search";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  // Content search reads transcript bytes off this host, so a remote device is
  // searched by its own grep rather than by scanning the local catalogue.
  const deviceId = getRequestDeviceId(request);
  if (isRemoteDevice(deviceId)) {
    if (!query) return NextResponse.json({ results: [], truncated: false } satisfies SessionSearchResponse, { headers });
    try {
      const [{ getGateway }, { listRemoteSessions }, { searchRemoteSessionContents }] = await Promise.all([
        import("@/lib/gateway/singleton"),
        import("@/lib/remote-session-store"),
        import("@/lib/session-search"),
      ]);
      const driver = await getGateway().getOrConnectDriver(deviceId);
      const sessions = await listRemoteSessions(deviceId);
      return NextResponse.json(
        await searchRemoteSessionContents(driver, sessions, query, request.signal),
        { headers },
      );
    } catch (error) {
      return NextResponse.json({ error: String(error) }, { status: 500, headers });
    }
  }
  try {
    // Paths come only from the same catalog used by the sidebar. `allowStale`
    // keeps the request off the catalogue rebuild path: agent activity
    // invalidates the scan constantly, and rebuilding it costs hundreds of
    // milliseconds because loadAllSessions() re-reads every forked and subagent
    // session. The trade-off is that a session created in the last couple of
    // seconds is not searched yet; the stale read schedules the rebuild, so the
    // next search sees it.
    const sessions = query && !request.signal.aborted ? await listAllSessions({ allowStale: true }) : [];
    return NextResponse.json(await searchSessionContents(sessions, query, request.signal), { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
