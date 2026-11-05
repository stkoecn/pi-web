import { NextResponse } from "next/server";
import { getRequestDeviceId } from "@/lib/device-context";
import { getDeviceRuntime } from "@/lib/device-runtime";
import { ModelsConfigReadError } from "@/lib/models-config-store";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);
  try {
    const runtime = await getDeviceRuntime(deviceId);
    const config = await runtime.getModelsConfig();
    return NextResponse.json(config);
  } catch (error) {
    if (error instanceof ModelsConfigReadError || (error as { name?: string })?.name === "ModelsConfigReadError") {
      return NextResponse.json({ error: (error as Error).message }, { status: 422 });
    }
    if ((error as { code?: unknown } | null)?.code === "device-offline") {
      return NextResponse.json({ error: String(error) }, { status: 503 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const deviceId = getRequestDeviceId(req);
  try {
    const body = await req.json() as Record<string, unknown>;
    const next = normalizeContextWindowOverrides(body);
    const runtime = await getDeviceRuntime(deviceId);
    await runtime.setModelsConfig(next);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ContextWindowError || (error as { name?: string })?.name === "ContextWindowError") {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError || (error as { name?: string })?.name === "ModelsConfigReadError") {
      return NextResponse.json({ error: (error as Error).message }, { status: 409 });
    }
    if ((error as { code?: unknown } | null)?.code === "device-offline") {
      return NextResponse.json({ error: String(error) }, { status: 503 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
