import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readTestModelPayload } from "@/lib/model-test";
import { getRequestDeviceId, isLocalHost, LOCAL_DEVICE_ID } from "@/lib/device-context";

export const dynamic = "force-dynamic";

/**
 * POST /api/models-config/test — probe one configured model with a tiny chat
 * request. The probe is a runtime capability: the local runtime runs it
 * in-process, a remote runtime runs the same probe on the device (its Base URL
 * is often the device's own loopback, which this server cannot reach), so the
 * route stays validation + dispatch and carries no device logic.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const payload = readTestModelPayload(body);
    if ("error" in payload) {
      return NextResponse.json({ ok: false, error: payload.error }, { status: payload.status });
    }

    // The header/query device wins (the UI addresses a device through it);
    // the body's deviceId is the documented fallback for scripts.
    const contextDevice = getRequestDeviceId(req);
    const bodyDevice = typeof body.deviceId === "string" && body.deviceId.trim() ? body.deviceId.trim() : "";
    const deviceId = contextDevice && !isLocalHost(contextDevice)
      ? contextDevice
      : (bodyDevice && !isLocalHost(bodyDevice) ? bodyDevice : LOCAL_DEVICE_ID);

    const { getDeviceRuntime } = await import("@/lib/device-runtime");
    const runtime = await getDeviceRuntime(deviceId);
    const result = await runtime.testModelConfig(payload);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offline = /not connected or offline/i.test(message);
    return NextResponse.json({ ok: false, error: message }, { status: offline ? 503 : 500 });
  }
}
