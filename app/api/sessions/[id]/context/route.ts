import { NextResponse } from "next/server";
import { getRequestDeviceId } from "@/lib/device-context";
import { DeviceOfflineError } from "@/lib/gateway/singleton";
import { getDeviceRuntime } from "@/lib/device-runtime";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferMedia = url.searchParams.has("deferMedia");
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;

  try {
    const deviceId = getRequestDeviceId(req, url.searchParams);
    const runtime = await getDeviceRuntime(deviceId);
    const result = await runtime.readSessionContext(id, undefined, {
      leafId,
      tail,
      before,
      deferThinking,
      deferMedia,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DeviceOfflineError) {
      return NextResponse.json(
        { error: error.message, code: error.code, deviceId: error.deviceId },
        { status: 503 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Session not found") || message.includes("not found")) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
