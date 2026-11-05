import { NextResponse, type NextRequest } from "next/server";
import { mkdirSync } from "fs";
import { defaultCwdPath, localDateStamp } from "@/lib/default-cwd";
import { getDeviceRuntime } from "@/lib/device-runtime";

// POST /api/default-cwd
// Creates ~/pi-cwd/<YYYYMMDD> (local date) if it doesn't exist and returns the path.
// The client then selects it through /api/cwd/validate like any other directory.
export async function POST(req: NextRequest) {
  try {
    let deviceId: string | undefined;
    try {
      const body = await req.json();
      deviceId = body?.deviceId?.trim() || undefined;
    } catch {}

    const runtime = await getDeviceRuntime(deviceId);
    if (!runtime.isRemote) {
      const dir = defaultCwdPath();
      mkdirSync(dir, { recursive: true });
      return NextResponse.json({ cwd: dir });
    }

    // Remote device
    const home = await runtime.getHomeDir();
    const parent = `${home}/pi-cwd`.replace(/\\/g, "/");
    const stamp = localDateStamp();
    const fullDir = `${parent}/${stamp}`;

    try {
      await runtime.createDir(home, "pi-cwd");
    } catch {}
    try {
      await runtime.createDir(parent, stamp);
    } catch {}

    return NextResponse.json({ cwd: fullDir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
