import io

p = "app/api/files/[[...path]]/route.ts"
s = io.open(p, encoding="utf-8").read()

anchor = "export async function GET(\n  request: NextRequest,"

handler = '''/**
 * Device branch of the file API.
 *
 * Answers with the exact shapes the local branch below produces, because the
 * explorer, the viewer and the upload dialog are the same components either
 * way. Kept in one function so every operation stays side by side with its
 * local twin.
 */
async function handleRemoteFileRequest(
  request: NextRequest,
  options: { deviceId: string; filePath: string; type: FileRequestType },
): Promise<Response> {
  const { deviceId, filePath, type } = options;
  try {
    const { getGateway } = await import("@/lib/gateway/singleton");
    const driver = await getGateway().getOrConnectDriver(deviceId);

    if (type === "list") {
      const showHidden = request.nextUrl.searchParams.get("hidden") === "1";
      const entries = await listRemoteDirectory(driver, filePath, { showHidden });
      return NextResponse.json({ entries, path: filePath });
    }

    const stat = await statRemotePath(driver, filePath);

    if (type === "read") {
      if (!stat || stat.isDirectory) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      // Media is streamed as bytes, exactly like the local branch: the viewer
      // points an <img>/<video> at this URL, so JSON would render nothing.
      const imageMime = getImageMime(filePath);
      if (imageMime) {
        if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
          return NextResponse.json({ error: "Image too large (>10MB)" }, { status: 413 });
        }
        return streamRemoteFile(driver, filePath, imageMime);
      }
      const mediaMime = getAudioMime(filePath) || getVideoMime(filePath) || getDocumentMime(filePath);
      if (mediaMime) {
        return streamRemoteFile(driver, filePath, mediaMime);
      }
      const rawOffset = request.nextUrl.searchParams.get("offset");
      if (rawOffset !== null && !/^\\d+$/.test(rawOffset)) {
        return NextResponse.json({ error: "Invalid text preview offset" }, { status: 400 });
      }
      const offset = Number(rawOffset ?? 0);
      if (!Number.isSafeInteger(offset) || offset > stat.size) {
        return NextResponse.json({ error: "Invalid text preview offset" }, { status: 400 });
      }
      const length = Math.min(TEXT_PREVIEW_MAX_BYTES + 1, stat.size - offset);
      const buffer = await readRemoteSlice(driver, filePath, offset, length);
      const chunk = chunkFromBuffer(buffer, buffer.length, stat.size, offset);
      return NextResponse.json({ ...chunk, language: getLanguage(filePath), size: stat.size });
    }

    if (type === "download") {
      if (!stat || stat.isDirectory) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const mime = getImageMime(filePath) || getAudioMime(filePath) || getVideoMime(filePath)
        || getDocumentMime(filePath) || "application/octet-stream";
      return streamRemoteFile(driver, filePath, mime, true);
    }

    if (type === "meta") {
      if (!stat || stat.isDirectory) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      return NextResponse.json({
        size: stat.size,
        language: getLanguage(filePath),
        mime: getImageMime(filePath) || getAudioMime(filePath) || getVideoMime(filePath)
          || getDocumentMime(filePath) || "text/plain",
        previewKind: documentPreviewKind(filePath),
      });
    }

    if (type === "preview") {
      if (!stat || stat.isDirectory) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      if (getFileExt(filePath) !== "docx") {
        return NextResponse.json({ error: "Preview not available for this file type" }, { status: 400 });
      }
      if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "DOCX too large for preview (>10MB)" }, { status: 413 });
      }
      // mammoth needs the bytes in memory; the local branch hands it a path.
      const bytes = await readRemoteBuffer(driver, filePath);
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { buffer: bytes },
        { externalFileAccess: false, convertImage: mammoth.images.dataUri },
      );
      const html = wrapDocxPreviewHtml(result.value, path.basename(filePath));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // type === "watch": the local branch uses fs.watch, which cannot see a
    // device. Poll the device's mtime instead and emit the same SSE events.
    if (!stat || stat.isDirectory) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let lastMtime = stat.mtimeMs;
        let lastSize = stat.size;
        const send = (eventName: string, data: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(`event: ${eventName}\\ndata: ${JSON.stringify(data)}\\n\\n`));
          } catch {
            // client disconnected
          }
        };
        send("connected", { path: filePath, size: lastSize });
        let polling = false;
        timer = setInterval(() => {
          if (polling) return;
          polling = true;
          void statRemotePath(driver, filePath)
            .then((next) => {
              if (!next) {
                send("deleted", { path: filePath });
                return;
              }
              if (next.mtimeMs === lastMtime && next.size === lastSize) return;
              lastMtime = next.mtimeMs;
              lastSize = next.size;
              send("change", { size: next.size, mtime: next.mtimeMs });
            })
            .catch(() => { /* device hiccup: try again on the next tick */ })
            .finally(() => { polling = false; });
        }, REMOTE_WATCH_INTERVAL_MS);
      },
      cancel() {
        if (timer) clearInterval(timer);
        timer = null;
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** Device bytes as a response body; the whole file is fetched once over SFTP. */
async function streamRemoteFile(
  driver: IHostDriver,
  filePath: string,
  mime: string,
  asAttachment = false,
): Promise<Response> {
  const bytes = await readRemoteBuffer(driver, filePath);
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-cache",
  };
  if (asAttachment) {
    headers["Content-Disposition"] = `attachment; filename="${path.basename(filePath)}"`;
  }
  return new Response(new Uint8Array(bytes), { headers });
}

'''

assert anchor in s, "GET anchor not found"
s = s.replace(anchor, handler + anchor, 1)

old_import = 'import { readTextPreviewChunk } from "@/lib/text-preview";'
new_import = '''import { chunkFromBuffer, readTextPreviewChunk } from "@/lib/text-preview";
import {
  inspectRemoteUploadTargets,
  listRemoteDirectory,
  readRemoteBuffer,
  readRemoteSlice,
  statRemotePath,
} from "@/lib/remote-files";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";'''
assert old_import in s
s = s.replace(old_import, new_import)

old_const = "const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;"
new_const = old_const + '''
// A device file cannot be watched through fs.watch, so its mtime is polled. One
// `stat` round trip costs ~300 ms on a 257 ms-RTT link, so 3 s keeps the cost
// near 10% of a single shell while still feeling live to the reader.
const REMOTE_WATCH_INTERVAL_MS = 3_000;'''
assert old_const in s
s = s.replace(old_const, new_const)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("handler added")
