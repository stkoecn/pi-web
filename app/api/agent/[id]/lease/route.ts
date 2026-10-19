import { NextResponse } from "next/server";
import { renewSessionLivenessLeases } from "@/lib/session-liveness";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

// POST /api/agent/[id]/lease - Renew selected-session SSE leases.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Leases are an in-process notion: a remote pi keeps its session alive on the
  // device, so there is nothing to renew and the client must not see a 404.
  if (isRemoteDevice(getRequestDeviceId(req))) {
    return NextResponse.json({ success: true, renewed: 0 }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({
    success: true,
    renewed: renewSessionLivenessLeases(id),
  }, { headers: { "Cache-Control": "no-store" } });
}
