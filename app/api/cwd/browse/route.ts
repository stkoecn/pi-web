import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { deviceHomeOrDefault } from "@/lib/device-home";
import { listRemoteDirectory } from "@/lib/remote-files";
import {
  createDirectory,
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
/**
 * Remote browse: the picker must walk the *device's* filesystem, so this goes
 * through the gateway instead of fs/promises. Parent paths are derived with
 * POSIX semantics because every gateway device is Unix-like.
 */
async function browseRemote(deviceId: string, requested: string | undefined): Promise<NextResponse> {
  const { getGateway } = await import("@/lib/gateway/singleton");
  const driver = await getGateway().getOrConnectDriver(deviceId);
  const home = await deviceHomeOrDefault(deviceId);

  let target = requested?.trim() || home;
  if (target === "~") target = home;
  else if (target.startsWith("~/")) target = `${home}/${target.slice(2)}`;
  if (!target.startsWith("/")) target = `${home}/${target}`.replace(/\/{2,}/g, "/");

  // `listRemoteDirectory` answers existence, type, names and sizes in ONE shell
  // round trip; `driver.stat` + `driver.readDir` were two SFTP round trips and
  // measured 3.9 s on the 257 ms link for a directory of the same size.
  let entries;
  try {
    entries = await listRemoteDirectory(driver, target);
  } catch {
    return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
  }

  const directories = entries
    .filter((entry) => entry.isDir)
    .map((entry) => ({
      name: entry.name,
      path: target === "/" ? `/${entry.name}` : `${target}/${entry.name}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = target === "/" ? null : target.slice(0, target.lastIndexOf("/")) || "/";
  return NextResponse.json({ path: target, parentPath, directories });
}

export async function GET(request: NextRequest) {
  try {
    const requested = request.nextUrl.searchParams.get("path")?.trim();
    const deviceId = getRequestDeviceId(request);
    if (isRemoteDevice(deviceId)) {
      return await browseRemote(deviceId, requested);
    }

    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const directories = await listDirectories(resolved);

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/cwd/browse  body: { path: string, name: string }
// Creates one direct child of the currently browsed directory.
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

    if (isRemoteDevice(deviceId)) {
      // mkdir over the gateway: the directory must appear on the device, not here.
      if (!name || name === "." || name === ".." || /[\/]/.test(name)) {
        return NextResponse.json({ error: "Directory name must be a single folder name" }, { status: 400 });
      }
      const { getGateway } = await import("@/lib/gateway/singleton");
      const driver = await getGateway().getOrConnectDriver(deviceId);
      const parentStat = await driver.stat(parentPath).catch(() => null);
      if (!parentStat?.isDirectory) {
        return NextResponse.json({ error: "Parent path is not a directory" }, { status: 400 });
      }
      const createdPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
      const res = await driver.exec(`mkdir -p -- ${JSON.stringify(createdPath)}`);
      if (res.exitCode !== 0) {
        return NextResponse.json({ error: res.stderr.trim() || "Failed to create directory" }, { status: 500 });
      }
      return NextResponse.json({ success: true, path: createdPath });
    }

    const createdPath = await createDirectory(parentPath, name);
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
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
