import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { hasUnsettledSubagentRun } from "@/lib/subagent-runtime";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

// POST /api/agent/[id]/lease - A page renews the session it has selected, whether or not it
// holds the event stream: the session's idle countdown starts over (renewIdleTimer()), so it
// is reaped one idle timeout after the last page let go. The reply says what is under way:
// a hidden page lets go of an idle stream and opens it again when this reports activity
// (#1283). Never starts a wrapper.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // A device's session lives in the gateway's remote registry, not the local
  // one: its lease answers from the channel's own run state and — the point of
  // the awaiting flag — from the pending extension dialogs it holds, which is
  // how the sidebar shows "waiting for your answer" on a remote host.
  if (isRemoteDevice(getRequestDeviceId(req))) {
    const { getRemoteRpcSession, isRemoteSessionRunning } = await import("@/lib/remote-agent-manager");
    const session = getRemoteRpcSession(id);
    const alive = Boolean(session && !(session.channel as { isClosed?: () => boolean }).isClosed?.());
    return NextResponse.json({
      success: true,
      running: alive && Boolean(session && isRemoteSessionRunning(session)),
      awaitingInput: alive && Boolean(session && session.pendingUiRequestIds.size > 0),
      // A device's subagents have no local snapshot to settle from.
      subagentsActive: false,
    }, { headers: { "Cache-Control": "no-store" } });
  }
  const session = getRpcSession(id);
  const alive = Boolean(session?.isAlive());
  // A wrapper built before a hot reload lacks the method; its own timer still runs.
  if (alive && typeof session!.renewIdleTimer === "function") session!.renewIdleTimer();
  return NextResponse.json({
    success: true,
    // A run, a queued prompt, a `!` command or a compaction (isRunning()).
    running: alive && session!.isRunning(),
    // An extension dialog waiting for an answer.
    awaitingInput: alive && session!.isAwaitingInput(),
    // A subagent under this session, at any depth, whose end starts a turn here.
    subagentsActive: hasUnsettledSubagentRun(id),
  }, { headers: { "Cache-Control": "no-store" } });
}
