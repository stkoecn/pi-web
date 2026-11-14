import { createAgentEventStream } from "@/lib/agent-event-stream";
import { isValidLivenessHolder } from "@/lib/session-liveness";
import { describeStreamClient } from "@/lib/stream-client";
import { getRequestDeviceId } from "@/lib/device-context";
import { getDeviceRuntime } from "@/lib/device-runtime";

export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

// GET /api/agent/[id]/events?holder=<page id> - SSE stream of agent events. The holder, the
// request's reported address and its browser label only label the stream for the debug panel: the
// page's lease renewals keep the session alive, never the stream (#1283).
// A facade: the runtime hands over the session as an event source (a live local
// wrapper, a resumed session, or the remote channel adapter) and the same
// createAgentEventStream builder — `connected` first, 30 s heartbeat, backlog
// limits and client-shaped events — serves both transports.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });
  const holderParam = new URL(req.url).searchParams.get("holder");
  const holder = isValidLivenessHolder(holderParam) ? holderParam : null;
  const clientInfo = { holder, ...describeStreamClient(req.headers) };

  try {
    const runtime = await getDeviceRuntime(getRequestDeviceId(req));
    const streamSession = await runtime.getEventStreamSession?.(id);
    if (!streamSession) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });

    const stream = createAgentEventStream(req, id, Promise.resolve(streamSession as never), clientInfo);
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (error) {
    if ((error as { status?: number })?.status === 404) {
      return new Response("Session not found", { status: 404 });
    }
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }
}
