import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { createTerminal } from "@/lib/terminal-manager";
import { isLocalHostId } from "@/lib/gateway/host-identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json() as { id?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown; deviceId?: unknown };
    if (body.id !== undefined && (typeof body.id !== "string" || !/^[a-f0-9]{32}$/.test(body.id))) {
      return NextResponse.json({ error: "Invalid terminal id" }, { status: 400 });
    }
    const rawDeviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : undefined;
    const isRemote = Boolean(rawDeviceId) && !isLocalHostId(rawDeviceId);
    const deviceId = isRemote ? rawDeviceId : undefined;

    let cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      cwd = isRemote ? "~" : process.cwd();
    }

    if (!isRemote) {
      let validDir = false;
      try {
        const candidate = resolve(cwd);
        const s = await stat(candidate);
        if (s.isDirectory()) {
          const roots = await getAllowedFileRoots();
          if (isExistingFilePathAllowed(candidate, roots)) {
            cwd = candidate;
            validDir = true;
          }
        }
      } catch {
        // Path does not exist (e.g. leftover Linux path on Windows host)
      }
      if (!validDir) {
        cwd = process.cwd();
      }
    }

    const id = await createTerminal(
      cwd,
      typeof body.cols === "number" ? body.cols : 80,
      typeof body.rows === "number" ? body.rows : 24,
      body.id as string | undefined,
      deviceId,
    );
    return NextResponse.json({ id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
