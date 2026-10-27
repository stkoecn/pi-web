import { NextResponse } from "next/server";
import { resolveSessionPath, openSessionManager, buildSessionContext } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { attachTranscriptNotices, readSessionTranscriptNotices } from "@/lib/transcript-notices-server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { DeviceOfflineError } from "@/lib/gateway/singleton";
import { openRemoteSessionManager } from "@/lib/remote-session-store";
import type { SessionEntry } from "@/lib/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned (default 50); `before` rewinds the
  // walk start to an older entry so the client can page upward without
  // re-fetching the whole active branch.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;

  try {
    const deviceId = getRequestDeviceId(req, url.searchParams);
    if (isRemoteDevice(deviceId)) {
      // Identical pipeline, different byte source: the remote manager is a
      // `SessionManager.inMemory` over the remote JSONL.
      const remote = await openRemoteSessionManager(deviceId, id);
      if (!remote) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const sm = remote.sm;
      const entries = sm.getEntries();
      const transcriptNotices = readSessionTranscriptNotices({
        entries: entries as unknown as SessionEntry[],
        cwd: sm.getHeader()?.cwd ?? "",
        leafId: leafId ?? sm.getLeafId(),
        models: undefined,
      });
      const remoteContext = attachTranscriptNotices(buildSessionContext(entries as never, before ?? leafId, {
        deferThinking,
        deferToolResultImages,
        tail,
        excludeLeaf: Boolean(before),
        sessionId: id,
        deviceId,
      }), transcriptNotices);
      return NextResponse.json({ context: remoteContext, tail, before: before ?? null });
    }

    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const entries = sm.getEntries();
    const transcriptNotices = readSessionTranscriptNotices({
      entries: entries as unknown as SessionEntry[],
      cwd: sm.getHeader()?.cwd ?? "",
      leafId: leafId ?? sm.getLeafId(),
      models: liveRpc?.inner.modelRuntime,
    });
    const context = attachTranscriptNotices(buildSessionContext(entries as never, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      sessionId: id,
    }), transcriptNotices);

    return NextResponse.json({ context, tail, before: before ?? null });
  } catch (error) {
    // A device mid-reconnect answers at once with a state the client can act on
    // instead of a 500 after the pool's ten-second connect wait.
    if (error instanceof DeviceOfflineError) {
      return NextResponse.json(
        { error: error.message, code: error.code, deviceId: error.deviceId },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
