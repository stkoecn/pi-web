import { NextResponse } from "next/server";
import { getRequestDeviceId } from "@/lib/device-context";
import { getDeviceRuntime } from "@/lib/device-runtime";
import type { SessionEntry } from "@/lib/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const blockIndexParam = new URL(req.url).searchParams.get("blockIndex");
  const blockIndex = blockIndexParam === null ? Number.NaN : Number(blockIndexParam);
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return NextResponse.json({ error: "Valid blockIndex is required" }, { status: 400 });
  }

  try {
    const deviceId = getRequestDeviceId(req);
    let entries: SessionEntry[];
    try {
      const runtime = await getDeviceRuntime(deviceId);
      const transcript = await runtime.readSessionTranscript(id);
      entries = transcript.entries;
    } catch {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // SessionManager-backed parsing preserves the SDK's malformed-line tolerance.
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
      return NextResponse.json({ error: "Assistant message not found" }, { status: 404 });
    }

    const block = entry.message.content[blockIndex];
    if (!block || block.type !== "thinking") {
      return NextResponse.json({ error: "Thinking block not found" }, { status: 404 });
    }

    return NextResponse.json({ thinking: block.thinking });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
