import { NextResponse } from "next/server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import type { PluginScope } from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { checkPluginUpdates } from "@/lib/plugin-updates";

export const dynamic = "force-dynamic";

/**
 * A device's packages are its own installs, so the check runs there: the device
 * prints where each configured package actually lives, and the registry or
 * remote-branch comparison happens on its network, with its credentials.
 */
async function postRemote(req: Request, deviceId: string): Promise<NextResponse> {
  try {
    const body = await req.json() as { cwd?: unknown; source?: unknown; scope?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!cwd.startsWith("/")) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    const filter = readFilter(body);
    if (filter === "invalid") {
      return NextResponse.json({ error: "source and scope must be provided together" }, { status: 400 });
    }

    const { checkRemotePluginUpdates } = await import("@/lib/remote-plugin-check");
    const updates = await checkRemotePluginUpdates(deviceId, cwd, filter);
    if (filter && updates.length === 0) {
      return NextResponse.json({ error: "Configured package not found" }, { status: 404 });
    }
    return NextResponse.json({ updates });
  } catch (error) {
    const offline = (error as { code?: unknown } | null)?.code === "device-offline";
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: offline ? 503 : 500 },
    );
  }
}

/** The one-package filter, `undefined` for all of them, `"invalid"` for half of it. */
function readFilter(body: { source?: unknown; scope?: unknown }): { source: string; scope: PluginScope } | undefined | "invalid" {
  const source = typeof body.source === "string" ? body.source : undefined;
  const scope = body.scope === "global" || body.scope === "project"
    ? body.scope as PluginScope
    : undefined;
  if ((source && !scope) || (!source && scope)) return "invalid";
  return source && scope ? { source, scope } : undefined;
}

export async function POST(req: Request) {
  const deviceId = getRequestDeviceId(req);
  if (isRemoteDevice(deviceId)) return postRemote(req, deviceId);

  try {
    const body = await req.json() as {
      cwd?: unknown;
      source?: unknown;
      scope?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const source = typeof body.source === "string" ? body.source : undefined;
    const scope = body.scope === "global" || body.scope === "project"
      ? body.scope as PluginScope
      : undefined;
    if ((source && !scope) || (!source && scope)) {
      return NextResponse.json({ error: "source and scope must be provided together" }, { status: 400 });
    }

    const updates = await checkPluginUpdates(cwd, source && scope ? { source, scope } : undefined);
    if (source && scope && updates.length === 0) {
      return NextResponse.json({ error: "Configured package not found" }, { status: 404 });
    }

    return NextResponse.json({ updates });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
