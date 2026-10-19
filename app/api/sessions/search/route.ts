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
  // Content search reads transcript bytes off this host. For a remote device the
  // only correct answer available today is "nothing found": searching the local
  // catalogue would surface unrelated localhost sessions.
  if (isRemoteDevice(getRequestDeviceId(request))) {
    return NextResponse.json({ results: [], truncated: false } satisfies SessionSearchResponse, { headers });
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
