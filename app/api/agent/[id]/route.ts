import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { cwdMissingBody, missingCwdFromBody } from "@/lib/missing-cwd";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { EXTENSION_REPORTED_CODE } from "@/lib/agent-client";

/**
 * Resolve the remote channel for this session, resuming a persisted remote
 * session when nothing is running in this process.
 *
 * A remote session that was created in an earlier request (or before a restart)
 * only exists as a transcript on the device, so the in-memory miss has to fall
 * through to `ensureRemoteRpcSessionForExisting` instead of the local
 * `resolveSessionPath` lookup, which can never see remote files.
 */
async function resolveRemoteSession(req: Request, id: string) {
  const deviceId = getRequestDeviceId(req);
  // A localhost request must never be served by a remote channel that happens to
  // share the id: the local branch owns those ids, and skipping the import keeps
  // the local fast path free of remote machinery.
  if (!isRemoteDevice(deviceId)) return undefined;

  const {
    getRemoteRpcSession,
    ensureRemoteRpcSessionForExisting,
  } = await import("@/lib/remote-agent-manager");

  const inMemory = getRemoteRpcSession(id);
  if (inMemory) return inMemory;

  try {
    return await ensureRemoteRpcSessionForExisting(deviceId, id);
  } catch (error) {
    console.error("[agent/[id]] failed to resume remote session:", error);
    return undefined;
  }
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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
        unblockPendingRealtimeWait(id, getRequestDeviceId(req), "Unblocked by user message.");
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

    // Fast path: already-running local session
    const existing = getRpcSession(id);

    // Remote sessions (in memory, or resumed from the device transcript).
    const remote = await resolveRemoteSession(req, id);

    if (remote && body.type === "set_tools") {
      // pi's RPC mode has no `set_tools` (rpc-mode.js answers
      // `Unknown command: set_tools`), and the local pinning path cannot be reused
      // here: `setRpcSessionTools` opens the transcript with `SessionManager.open`,
      // which only sees this machine's filesystem. The loadout is therefore kept on
      // the live session and reported as accepted; it is re-sent whenever the
      // channel is (re)created.
      remote.pendingToolNames = toolNames ? [...toolNames] : undefined;
      remote.channel.send({
        type: "set_tools",
        ...(toolNames !== undefined ? { toolNames } : {}),
      });
      return NextResponse.json({
        success: true,
        data: { sessionId: remote.sessionId || id, recreated: false },
      });
    }

    if (remote) {
      // pi's RPC mode has no `get_tools` command over headless RPC.
      // Instead of returning an empty array, resolve the full active tool loadout
      // including core coding tools, mesh inter-session tools, and remote skills.
      if (body.type === "get_tools") {
        const { getRemoteTools } = await import("@/lib/remote-tools");
        const tools = await getRemoteTools(remote.deviceId, remote.state?.cwd || (remote.state?.sessionFile ? undefined : "/"));
        return NextResponse.json({ success: true, data: tools });
      }
      remote.channel.send(body);
      // An answered dialog is not echoed back on the channel this process reads,
      // so release the awaiting-input flag here or the sidebar keeps the session
      // parked on a question the user already answered.
      if (body.type === "extension_ui_response") {
        const { clearRemotePendingUiRequest } = await import("@/lib/remote-agent-manager");
        clearRemotePendingUiRequest(remote.sessionId || id, body.id);
      }
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: { accepted: true } });
    }

    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(body);
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
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      // Remote status polling (`agentStatusUrl()` adds `?systemPrompt=0`) has to
      // work for sessions that only exist on the device.
      const remote = await resolveRemoteSession(req, id);
      if (!remote) return NextResponse.json({ running: false });

      const { getRemoteRpcSessionState } = await import("@/lib/remote-agent-manager");
      const state = (await getRemoteRpcSessionState(id))
        ?? (remote.state as Record<string, unknown> | null)
        ?? {};
      const trimmed = { ...state } as Record<string, unknown>;
      if (new URL(req.url).searchParams.get("systemPrompt") === "0") delete trimmed.systemPrompt;
      return NextResponse.json({ running: true, state: trimmed });
    }

    const state = await session.send({ type: "get_state" }) as Record<string, unknown>;
    // Status reads leave out the system prompt, most of the reply (agentStatusUrl()).
    if (new URL(req.url).searchParams.get("systemPrompt") === "0") delete state.systemPrompt;
    return NextResponse.json({ running: true, state });
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
    const { closeRemoteRpcSession } = await import("@/lib/remote-agent-manager");
    const closed = closeRemoteRpcSession(id);
    return NextResponse.json({ success: true, closed });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
