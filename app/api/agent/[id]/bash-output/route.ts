import { NextResponse } from "next/server";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  MAX_INLINE_BASH_OUTPUT_BYTES,
  openRegularFileNoFollow,
  readUtf8FileWithinLimit,
  resolveBashOutputPath,
} from "@/lib/bash-output";
import { isBashOutputPathReferencedBySession } from "@/lib/session-file-references";
import { isBashOutputPathReferencedByEntries } from "@/lib/session-file-references-core";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { openRemoteSessionManager } from "@/lib/remote-session-store";
import { getGateway } from "@/lib/gateway/singleton";

// GET /api/agent/[id]/bash-output?path=<absPath>
// Reads a bash output temp file referenced by this session. Inline display is
// size-limited; download responses stream the file without buffering it.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let path: string | null = null;
  let download = false;
  try {
    const url = new URL(_req.url);
    path = url.searchParams.get("path");
    download = url.searchParams.get("download") === "1";
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  if (!path) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  const deviceId = getRequestDeviceId(_req);
  if (isRemoteDevice(deviceId)) {
    // The log was written by the device's own pi into the device's temp dir, so
    // it is validated and read there. Same two checks as the local path: the
    // file must be a `pi-bash-*.log` inside the temp dir, and the session must
    // reference it.
    if (!/^pi-bash-[A-Za-z0-9_-]+\.log$/.test(path.split("/").pop() ?? "")) {
      return NextResponse.json({ error: "invalid path" }, { status: 400 });
    }
    try {
      const remote = await openRemoteSessionManager(deviceId, id);
      if (!remote) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      if (!isBashOutputPathReferencedByEntries(path, remote.sm.getEntries() as never)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }

      const driver = await getGateway().getOrConnectDriver(deviceId);
      // -w0 is GNU-only; plain `base64` wraps, and the wrapper strips the breaks.
      const encoded = await driver.exec(`base64 '${path.replace(/'/g, `'\''`)}'`, [], { timeoutMs: 30_000 });
      if (encoded.exitCode !== 0) {
        return NextResponse.json({ error: "full output unavailable" }, { status: 404 });
      }
      const bytes = Buffer.from(encoded.stdout.replace(/\s+/g, ""), "base64");
      if (bytes.length > MAX_INLINE_BASH_OUTPUT_BYTES && !download) {
        return NextResponse.json({
          error: `Full output is too large to display (limit ${MAX_INLINE_BASH_OUTPUT_BYTES} bytes)`,
          data: { size: bytes.length, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES },
        }, { status: 413 });
      }
      if (download) {
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": "attachment; filename=\"bash-output.log\"",
            "Cache-Control": "no-store",
          },
        });
      }
      return NextResponse.json({ success: true, data: { output: bytes.toString("utf8") } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  const resolved = resolveBashOutputPath(path, tmpdir());
  if (!resolved) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  if (!await isBashOutputPathReferencedBySession(resolved, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    if (download) {
      const { handle } = await openRegularFileNoFollow(resolved);
      const stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"bash-output.log\"",
          "Cache-Control": "no-store",
        },
      });
    }

    const result = await readUtf8FileWithinLimit(resolved);
    if (result.tooLarge) {
      return NextResponse.json({
        error: `Full output is too large to display (limit ${MAX_INLINE_BASH_OUTPUT_BYTES} bytes)`,
        data: { size: result.size, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES },
      }, { status: 413 });
    }
    return NextResponse.json({ success: true, data: { output: result.content } });
  } catch {
    return NextResponse.json({ error: "full output unavailable" }, { status: 404 });
  }
}
