import { NextResponse } from "next/server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { ModelsConfigReadError, readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { readRemoteModelsConfig, writeRemoteModelsConfig } from "@/lib/remote-models-config";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // models.json lives in the agent directory, which belongs to the device.
  const deviceId = getRequestDeviceId(req);
  if (isRemoteDevice(deviceId)) {
    try {
      return NextResponse.json(await readRemoteModelsConfig(deviceId));
    } catch (error) {
      // Same statuses as the local branch below, so the panel cannot tell the
      // two apart: unusable contents are 422, an offline device is 503.
      if (error instanceof ModelsConfigReadError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      if ((error as { code?: unknown } | null)?.code === "device-offline") {
        return NextResponse.json({ error: String(error) }, { status: 503 });
      }
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
  // The write lands in the device's own agent directory.
  const deviceId = getRequestDeviceId(req);
  try {
    const body = await req.json() as Record<string, unknown>;
    const next = normalizeContextWindowOverrides(body);
    if (isRemoteDevice(deviceId)) {
      await writeRemoteModelsConfig(deviceId, next);
    } else {
      writeModelsConfig(next);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ContextWindowError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Identified by code as well as class: the gateway is imported through
    // several module instances, so a duplicated class would slip past
    // `instanceof` and surface as a 500.
    if ((error as { code?: unknown } | null)?.code === "device-offline") {
      return NextResponse.json({ error: String(error) }, { status: 503 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
