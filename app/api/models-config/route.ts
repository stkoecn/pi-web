import { NextResponse } from "next/server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { ModelsConfigReadError, readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // models.json lives in the agent directory, which belongs to the device.
  const deviceId = getRequestDeviceId(req);
  if (isRemoteDevice(deviceId)) {
    try {
      const { readRemoteModelsConfig } = await import("@/lib/remote-settings");
      return NextResponse.json(await readRemoteModelsConfig(deviceId));
    } catch (error) {
      return NextResponse.json({ error: String(error) }, { status: 500 });
    }
  }
  try {
    return NextResponse.json(readModelsConfig());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  // Writing would have to land in the device's own agent directory.
  if (isRemoteDevice(getRequestDeviceId(req))) {
    return NextResponse.json({ error: "Not supported on remote devices yet" }, { status: 501 });
  }
  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsConfig(normalizeContextWindowOverrides(body));
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ContextWindowError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
