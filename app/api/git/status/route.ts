import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitStatus } from "@/lib/git-changes";

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const deviceId = request.nextUrl.searchParams.get("deviceId") || request.headers.get("x-device-id");

    if (deviceId && deviceId !== "localhost") {
      try {
        const { getGateway } = await import("@/lib/gateway/singleton");
        const driver = await getGateway().getOrConnectDriver(deviceId);
        const branchRes = await driver.exec(`git -C "${(cwd || '~').replace(/"/g, '\\"')}" branch --show-current 2>/dev/null || echo ""`);
        const statusRes = await driver.exec(`git -C "${(cwd || '~').replace(/"/g, '\\"')}" status --porcelain=v1 2>/dev/null || echo ""`);
        const branch = branchRes.stdout.trim() || "main";
        const lines = statusRes.stdout.trim().split("\n").filter(Boolean);
        return NextResponse.json({
          branch,
          clean: lines.length === 0,
          entries: lines.map((l) => ({
            path: l.slice(3).trim(),
            status: l.slice(0, 2).trim(),
          })),
        });
      } catch (err: any) {
        return NextResponse.json({ branch: "unknown", clean: true, entries: [] });
      }
    }

    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(await getGitStatus(cwd));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
