import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitStatus } from "@/lib/git-changes";
import { shellQuote } from "@/lib/shell-quote";

/** 2 s: long enough to collapse a tool-call burst, short enough to feel live. */
const REMOTE_GIT_TTL_MS = 2_000;
/** Splits the branch name from the status list in one command's stdout. */
const REMOTE_GIT_SEPARATOR = "@@piweb-git@@";
type RemoteGitValue = { branch: string; clean: boolean; entries: { path: string; status: string }[] };
const remoteGitCache = new Map<string, { at: number; value: RemoteGitValue }>();

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const deviceId = request.nextUrl.searchParams.get("deviceId") || request.headers.get("x-device-id");

    if (deviceId && deviceId !== "localhost") {
      // The file tree asks for this after every finished tool call and on every
      // window focus, so a short cache matters more than freshness here: one
      // round trip to the device costs 250-900 ms.
      const key = `${deviceId}\u0000${cwd}`;
      const cached = remoteGitCache.get(key);
      if (cached && Date.now() - cached.at < REMOTE_GIT_TTL_MS) {
        return NextResponse.json(cached.value);
      }
      try {
        const { getGateway } = await import("@/lib/gateway/singleton");
        const driver = await getGateway().getDriverForRequest(deviceId);
        // One script, one round trip: the branch and the status list used to be
        // two serial execs, i.e. two full device round trips for one answer.
        const dir = shellQuote(cwd || "~");
        const script = [
          `git -C ${dir} branch --show-current 2>/dev/null || echo ""`,
          `printf '%s' '${REMOTE_GIT_SEPARATOR}'`,
          `git -C ${dir} status --porcelain=v1 2>/dev/null || echo ""`,
        ].join("\n");
        const result = await driver.exec(
          `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
          [],
          { timeoutMs: 15_000 },
        );
        const separatorAt = result.stdout.indexOf(REMOTE_GIT_SEPARATOR);
        const branchPart = separatorAt >= 0 ? result.stdout.slice(0, separatorAt) : result.stdout;
        const statusPart = separatorAt >= 0 ? result.stdout.slice(separatorAt + REMOTE_GIT_SEPARATOR.length) : "";
        const statusLines = statusPart.trim().split("\n").filter(Boolean);
        const value: RemoteGitValue = {
          branch: branchPart.trim() || "main",
          clean: statusLines.length === 0,
          entries: statusLines.map((line) => ({
            path: line.slice(3).trim(),
            status: line.slice(0, 2).trim(),
          })),
        };
        remoteGitCache.set(key, { at: Date.now(), value });
        if (remoteGitCache.size > 64) remoteGitCache.clear();
        return NextResponse.json(value);
      } catch {
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
