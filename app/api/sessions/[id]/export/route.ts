import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { promisify } from "util";
import { fileURLToPath, pathToFileURL } from "url";
import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

type PiCodingAgentModule = {
  getPackageDir: () => string;
};

type ExportHtmlModule = {
  exportFromFile: (inputPath: string, outputPath: string) => Promise<string>;
};

async function getPiPackageDir(): Promise<string | null> {
  try {
    const { getPackageDir } = (await import("@earendil-works/pi-coding-agent")) as PiCodingAgentModule;
    return getPackageDir();
  } catch {
    return null;
  }
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

async function getPiCliPath(): Promise<string | null> {
  const candidates = new Set<string>();
  const packageDir = await getPiPackageDir();

  if (packageDir) {
    candidates.add(join(packageDir, "dist", "cli.js"));
  }

  try {
    const resolver = (import.meta as ImportMeta & {
      resolve?: (specifier: string) => string | Promise<string>;
    }).resolve;
    if (typeof resolver === "function") {
      const indexUrl = await resolver("@earendil-works/pi-coding-agent");
      candidates.add(join(dirname(fileURLToPath(indexUrl)), "cli.js"));
    }
  } catch {
    // Next.js production bundles can strip import.meta.resolve.
  }

  candidates.add(
    join(
      process.cwd(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js"
    )
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function exportSession(filePath: string, outputPath: string): Promise<void> {
  const cliPath = await getPiCliPath();
  if (cliPath) {
    await execFileAsync(process.execPath, [cliPath, "--export", filePath, outputPath], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      maxBuffer: 1024 * 1024,
    });
    return;
  }

  const packageDir = await getPiPackageDir();
  if (!packageDir) throw new Error("pi CLI not found");

  const exporterUrl = pathToFileURL(join(packageDir, "dist", "core", "export-html", "index.js")).href;
  const { exportFromFile } = (await import(exporterUrl)) as ExportHtmlModule;
  await exportFromFile(filePath, outputPath);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const inline = url.searchParams.get("inline") === "1";
  const deviceId = url.searchParams.get("deviceId")?.trim() || undefined;

  // Per-request private directory. A fixed /tmp/pi-web-export is created by
  // whichever OS user runs the first WebUI process; other users on the same
  // host then cannot write into it and history export fails. The remote
  // session's staged input copy lives inside the same directory, so one
  // recursive removal at the end cleans both.
  let tempDir: string | null = null;
  try {
    let filePath = await resolveSessionPath(id);
    let tempInputPath: string | null = null;
    let sessionBase = id;

    if (!filePath && deviceId) {
      try {
        const { findRemoteSessionFile, readRemoteSessionContent } = await import("@/lib/remote-session-store");
        const file = await findRemoteSessionFile(deviceId, id);
        if (file) {
          const content = await readRemoteSessionContent(deviceId, file);
          tempDir = mkdtempSync(join(tmpdir(), "pi-web-export-"));
          tempInputPath = join(tempDir, `${randomUUID()}.jsonl`);
          writeFileSync(tempInputPath, content, "utf8");
          filePath = tempInputPath;
          sessionBase = basename(file.path, ".jsonl");
        }
      } catch (err) {
        console.warn(`[ExportRoute] Failed to load remote session ${id} from ${deviceId}:`, err);
      }
    }

    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (!tempDir) {
      tempDir = mkdtempSync(join(tmpdir(), "pi-web-export-"));
    }
    if (!tempInputPath) {
      sessionBase = basename(filePath, ".jsonl");
    }

    const fileName = `pi-session-${sessionBase}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);

    await exportSession(filePath, outputPath);

    const html = readFileSync(outputPath, "utf8");
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": getContentDisposition(fileName, inline),
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
