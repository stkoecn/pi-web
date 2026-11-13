import { NextResponse } from "next/server";
import { getRequestDeviceId } from "@/lib/device-context";
import { getDeviceRuntime } from "@/lib/device-runtime";
import { DeviceOfflineError } from "@/lib/gateway/singleton";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let deviceId: string | undefined;
  try {
    deviceId = getRequestDeviceId(req);
    const runtime = await getDeviceRuntime(deviceId);
    const active = await runtime.getActiveSession(id);
    if (active) {
      // Two active-session shapes reach this point: the local RPC wrapper
      // carries `send` itself, while the remote runtime wraps it in `.session`.
      // Cached `.state` answers without a round trip on either.
      const anyActive = active as any;
      const state = anyActive.session?.state
        ?? anyActive.state
        ?? (typeof anyActive.send === "function"
          ? await anyActive.send({ type: "get_state" }).catch(() => undefined)
          : await anyActive.session?.send?.({ type: "get_state" }).catch(() => undefined));
      return NextResponse.json({ running: true, ...(state ? { state } : {}) });
    }

    const exists = await runtime.hasSession(id);
    if (!exists) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    if (error instanceof DeviceOfflineError || (error as { code?: string })?.code === "device-offline") {
      return NextResponse.json(
        { error: (error as Error).message, code: (error as any).code || "device-offline", deviceId },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
