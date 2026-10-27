import { createAgentEventStream } from "@/lib/agent-event-stream";
import type { AgentEventStreamSession } from "@/lib/agent-event-stream";
import { toClientAgentEvent } from "@/lib/agent-event-wire";
import type { AgentEventLike } from "@/lib/agent-event-wire";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/**
 * Wrap a remote RPC channel in the `AgentEventStreamSession` shape.
 *
 * The stream itself (heartbeat, backpressure, `connected`, snapshot replay) is
 * the same code the local path uses; only the event source differs. pi's RPC
 * output is already event-shaped, so the adapter just normalises it to the
 * client wire format and keeps `state.isStreaming` in sync so a reconnecting
 * client sees the right `connected.isStreaming`.
 */
function toRemoteEventSession(remote: {
  channel: {
    onMessage(listener: (msg: any) => void): () => void;
    onClose(listener: (code?: number) => void): () => void;
  };
  state: any;
}): AgentEventStreamSession {
  let closed = false;
  const listeners = new Set<(event: AgentEventLike) => void>();

  // pi emits no `session_shutdown` over RPC: a channel close is the only signal
  // that the remote agent is gone, so synthesize the event the stream builder
  // uses to end the response. Without it a dead remote session would keep an SSE
  // connection open on heartbeats alone.
  remote.channel.onClose(() => {
    closed = true;
    for (const listener of listeners) {
      try {
        listener({ type: "session_shutdown" });
      } catch {
        /* listener already torn down */
      }
    }
  });

  const setStreaming = (isStreaming: boolean) => {
    if (remote.state) remote.state.isStreaming = isStreaming;
  };

  return {
    get isStreaming() {
      return remote.state?.isStreaming ?? false;
    },
    // Remote sessions publish no partial snapshot: pi only reports whole events
    // over RPC, so a reconnecting client rebuilds from the `connected` frame.
    get streamingMessage() {
      return null;
    },
    isAlive() {
      return !closed;
    },
    onEvent(listener: (event: AgentEventLike) => void) {
      listeners.add(listener);
      const unsubscribe = remote.channel.onMessage((msg: any) => {
        if (!msg || typeof msg.type !== "string") return;
        // RPC plumbing (`response` frames to our own get_state / set_model calls)
        // is not an agent event: the local path never sees it, so dropping it here
        // keeps both transports byte-compatible for the client reducer.
        if (msg.type === "response") return;
        // pi reports `agent_start` / `agent_end` / `agent_settled` as they happen;
        // mirror them so status polling and reconnects agree with the stream.
        if (msg.type === "agent_start") setStreaming(true);
        else if (msg.type === "agent_end" || msg.type === "agent_settled") setStreaming(false);

        const clientEvent = toClientAgentEvent(msg as AgentEventLike);
        if (!clientEvent) return;
        listener(clientEvent);
      });
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
  };
}

/**
 * Resolve the remote channel for this session, resuming a persisted remote
 * session (created in an earlier request or before a restart) when it is not
 * already in memory.
 */
async function resolveRemoteSession(req: Request, id: string) {
  const deviceId = getRequestDeviceId(req);
  // Localhost ids belong to the local branch; do not even load the remote
  // machinery for them.
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
    console.error("[agent/[id]/events] failed to resume remote session:", error);
    return undefined;
  }
}

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const remote = await resolveRemoteSession(req, id);
  if (remote) {
    // Same builder as the local path: `connected` first, 30 s heartbeat,
    // backlog limits and client-shaped events all come from createAgentEventStream.
    const stream = createAgentEventStream(
      req,
      id,
      Promise.resolve(toRemoteEventSession(remote)),
    );
    return new Response(stream, { headers: SSE_HEADERS });
  }

  // Fast path: already-running session
  const session = getRpcSession(id);
  let sessionPromise;
  if (session?.isAlive()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, { headers: SSE_HEADERS });
}
