import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { cancelRealtimeWait } from "@/lib/gateway/mesh-router";

const NO_CACHE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const deviceId = url.searchParams.get("deviceId") || undefined;
    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;

    // sessionId is required: unblockPendingRealtimeWait matches only the named
    // session's own wait, so a bodyless cancel can no longer release every
    // wait on the device.
    if (!sessionId) {
      return NextResponse.json(
        { error: "sessionId is required" },
        { status: 400, headers: NO_CACHE_HEADERS }
      );
    }

    const cancelled = cancelRealtimeWait(sessionId, deviceId);
    return NextResponse.json(
      { success: true, cancelled },
      { headers: NO_CACHE_HEADERS }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
