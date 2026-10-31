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

    // sessionId is optional; if missing, cancelRealtimeWait cancels any pending wait matching deviceId or cancels the latest


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
