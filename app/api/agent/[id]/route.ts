import { NextResponse } from "next/server";
import { cwdMissingBody, missingCwdFromBody } from "@/lib/missing-cwd";
import { getRequestDeviceId } from "@/lib/device-context";
import { getDeviceRuntime } from "@/lib/device-runtime";
import { EXTENSION_REPORTED_CODE } from "@/lib/agent-client";

// POST /api/agent/[id] - Send a command to an existing session.
// A facade: request parsing, the mesh unblock hook and error mapping live here;
// everything device-specific (local wrapper semantics, remote channels, resume,
// the per-device queue) is the runtime's sendSessionCommand / setSessionTools /
// getTools under getDeviceRuntime(deviceId).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deviceId = getRequestDeviceId(req);
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // A prompt, steer, follow_up or abort into THIS session releases only the
    // realtime wait this session itself started (the user took over). Passing
    // this request's device — never undefined — keeps a same-id session on
    // another device from being released too.
    if (commandType === "prompt" || commandType === "steer" || commandType === "follow_up" || commandType === "abort") {
      try {
        const { unblockPendingRealtimeWait } = await import("@/lib/gateway/mesh-router");
        unblockPendingRealtimeWait(id, deviceId, "Unblocked by user message.");
      } catch {}
    }
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    const runtime = await getDeviceRuntime(deviceId);

    if (body.type === "set_tools") {
      const changed = await runtime.setSessionTools(id, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (body.type === "get_tools") {
      return NextResponse.json({ success: true, data: await runtime.getTools(id) });
    }

    const result = await runtime.sendSessionCommand(id, body, { toolNames });
    promptAccepted = body.type === "prompt";
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    // Read by its fields: the wrapper that threw may come from another route's bundle.
    const missingCwd = missingCwdFromBody(error);
    const status = (error as { status?: number })?.status;
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(missingCwd ? cwdMissingBody(missingCwd) : {}),
      ...((error as { code?: unknown } | null)?.code === EXTENSION_REPORTED_CODE ? { code: EXTENSION_REPORTED_CODE } : {}),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: status === 404 ? status : 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const runtime = await getDeviceRuntime(getRequestDeviceId(req));
    const status = await runtime.getSessionStatus(id);
    if (status.running && status.state) {
      // Status reads leave out the system prompt, most of the reply (agentStatusUrl()).
      const state = { ...status.state } as Record<string, unknown>;
      if (new URL(req.url).searchParams.get("systemPrompt") === "0") delete state.systemPrompt;
      return NextResponse.json({ running: true, state });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const runtime = await getDeviceRuntime(getRequestDeviceId(_req));
    const closed = await runtime.closeSession(id);
    return NextResponse.json({ success: true, closed });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
