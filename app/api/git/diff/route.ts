import { NextRequest, NextResponse } from "next/server";
import { lstatSync } from "fs";
import path from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { hasParentDirectorySegment } from "@/lib/path-security";

function isDiffPathAllowed(filePath: string, allowedRoots: Set<string>): boolean {
  if (hasParentDirectorySegment(filePath)) return false;
  // Deleted files (and their parents) may be absent. Authorize the nearest
  // existing entry, but never walk past a dangling link or an access error.
  let candidate = filePath;
  while (isFilePathAllowed(candidate, allowedRoots)) {
    try {
      lstatSync(candidate);
      return isExistingFilePathAllowed(candidate, allowedRoots);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
  return false;
}

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const filePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    const deviceId = request.nextUrl.searchParams.get("deviceId") || request.headers.get("x-device-id");

    if (deviceId && deviceId !== "localhost") {
      try {
        const { getGateway } = await import("@/lib/gateway/singleton");
        const driver = await getGateway().getOrConnectDriver(deviceId);
        const diffRes = await driver.exec(`git -C "${(cwd || '~').replace(/"/g, '\\"')}" diff -- "${filePath.replace(/"/g, '\\"')}" 2>/dev/null || echo ""`);
        return NextResponse.json({
          supported: true,
          patch: diffRes.stdout || "",
          path: filePath,
        });
      } catch (err: any) {
        return NextResponse.json({ supported: false, patch: "", path: filePath });
      }
    }

    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    // Check the target as well as cwd: a directory junction inside a repository
    // can otherwise expose an outside file through an apparently local path.
    if (!isExistingFilePathAllowed(cwd, allowedRoots) || !isDiffPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(await getGitFileDiff(cwd, filePath));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
