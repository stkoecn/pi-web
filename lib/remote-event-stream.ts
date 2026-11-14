import type { AgentEventStreamSession } from "@/lib/agent-event-stream";
import { toClientAgentEvent } from "@/lib/agent-event-wire";
import type { AgentEventLike } from "@/lib/agent-event-wire";
import type { RemoteRpcSession } from "./remote-agent-manager";

/**
 * Wrap a remote RPC channel in the `AgentEventStreamSession` shape.
 *
 * The stream itself (heartbeat, backpressure, `connected`, snapshot replay) is
 * the same code the local path uses; only the event source differs. pi's RPC
 * output is already event-shaped, so the adapter just normalises it to the
 * client wire format and keeps `state.isStreaming` in sync so a reconnecting
 * client sees the right `connected.isStreaming`.
 */
export function toRemoteEventSession(remote: RemoteRpcSession): AgentEventStreamSession {
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
