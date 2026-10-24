import { getGateway } from "@/lib/gateway/singleton";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { id, action } = body as {
      id?: string;
      action?: "connect" | "disconnect" | "enable" | "disable";
    };

    if (!id || typeof id !== "string") {
      return Response.json({ error: "Missing or invalid device id" }, { status: 400 });
    }

    if (action !== "connect" && action !== "disconnect" && action !== "enable" && action !== "disable") {
      return Response.json(
        { error: "Action must be 'connect', 'disconnect', 'enable' or 'disable'" },
        { status: 400 },
      );
    }

    const gateway = getGateway();

    // Switching a discovered host on or off. Turning one off also drops its
    // connection, so the switcher cannot keep offering a host the user closed.
    if (action === "enable" || action === "disable") {
      await gateway.setDeviceEnabled(id, action === "enable");
      return Response.json({ success: true, status: "offline" });
    }

    if (action === "disconnect") {
      const result = await gateway.disconnectDevice(id);
      return Response.json(result);
    }
    // A host discovered in `~/.ssh/config` is not in `devices.json`, so it must
    // be dialled through the path that knows about discovery. A refused connect
    // is a normal answer, not a server fault: the caller keeps its current view.
    const result = await gateway.connectForSelection(id);
    return Response.json(result, { status: result.success ? 200 : 409 });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Failed to control device connection" },
      { status: 500 },
    );
  }
}
