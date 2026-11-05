import { NextRequest, NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { getDeviceRuntime } from "@/lib/device-runtime";

export const dynamic = "force-dynamic";

// GET /api/cwd/browse?path=...
export async function GET(request: NextRequest) {
  try {
    const requested = request.nextUrl.searchParams.get("path")?.trim() || undefined;
    const deviceId = getRequestDeviceId(request);
    const runtime = await getDeviceRuntime(deviceId);
    const result = await runtime.browseDir(requested);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not exist") || message.includes("ENOENT")) {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }
    if (message.includes("not a directory")) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/cwd/browse  body: { path: string, name: string, deviceId?: string }
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { path?: unknown; name?: unknown; deviceId?: unknown };
    const parentPath = typeof body.path === "string" ? body.path.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const bodyDeviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const deviceId = isRemoteDevice(bodyDeviceId) ? bodyDeviceId : getRequestDeviceId(request);

    if (!parentPath) {
      return NextResponse.json({ error: "Parent path is required" }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: "Directory name is required" }, { status: 400 });
    }

    const runtime = await getDeviceRuntime(deviceId);
    const createdPath = await runtime.createDir(parentPath, name);
    return NextResponse.json({ success: true, path: createdPath });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code === "EEXIST") {
      return NextResponse.json({ error: "A file or directory with this name already exists" }, { status: 409 });
    }
    if (code === "ENOENT") {
      return NextResponse.json({ error: "Parent directory does not exist" }, { status: 404 });
    }
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }
    if (code === "EINVAL" || code === "ENAMETOOLONG") {
      return NextResponse.json({ error: "Directory name is invalid" }, { status: 400 });
    }
    if (error instanceof Error && (
      error.message === "Directory name must be a single folder name"
      || error.message === "Parent path is not a directory"
    )) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
