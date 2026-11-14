import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "@/lib/global-settings-file";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

export const dynamic = "force-dynamic";

// Settings › General's switch for pi's own `showCacheMissNotices` (#1265), in
// the global settings.json under the lock pi's SettingsManager takes. Off is
// pi's default, so turning it off removes the key. A project's
// .pi/settings.json still overrides it, as in pi.

const KEY = "showCacheMissNotices";

async function readEnabled(): Promise<boolean> {
  return readGlobalSettings(getGlobalSettingsPath(), (settings) => settings[KEY] === true);
}

/**
 * The device reads and writes its own global settings.json: the notice
 * setting that matters is the one the sessions on that machine consult.
 */
async function readRemoteEnabled(deviceId: string): Promise<boolean> {
  const { getGateway } = await import("@/lib/gateway/singleton");
  const { getRemoteAgentDir } = await import("@/lib/remote-settings");
  const { withRemoteSettingsFile } = await import("@/lib/remote-subagents");
  const driver = await getGateway().getDriverForRequest(deviceId);
  const settingsPath = `${await getRemoteAgentDir(deviceId)}/settings.json`;
  let enabled = false;
  await withRemoteSettingsFile(driver, settingsPath, async (tempPath) => {
    enabled = await readGlobalSettings(tempPath, (settings) => settings[KEY] === true);
  });
  return enabled;
}

async function writeRemoteEnabled(deviceId: string, enabled: boolean): Promise<boolean> {
  const { getGateway } = await import("@/lib/gateway/singleton");
  const { getRemoteAgentDir } = await import("@/lib/remote-settings");
  const { withRemoteSettingsFile } = await import("@/lib/remote-subagents");
  const driver = await getGateway().getDriverForRequest(deviceId);
  const settingsPath = `${await getRemoteAgentDir(deviceId)}/settings.json`;
  await withRemoteSettingsFile(driver, settingsPath, async (tempPath) => {
    await updateGlobalSettings(tempPath, (settings) => {
      if (enabled) settings[KEY] = true;
      else delete settings[KEY];
    });
  });
  return readRemoteEnabled(deviceId);
}

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function GET(req: Request) {
  if (isRemoteDevice(getRequestDeviceId(req))) {
    try {
      return NextResponse.json({ enabled: await readRemoteEnabled(getRequestDeviceId(req)) });
    } catch (error) {
      return errorResponse(error);
    }
  }
  try {
    return NextResponse.json({ enabled: await readEnabled() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (isRemoteDevice(getRequestDeviceId(req))) {
    try {
      return NextResponse.json({ enabled: await writeRemoteEnabled(getRequestDeviceId(req), enabled) });
    } catch (error) {
      return errorResponse(error);
    }
  }
  try {
    // Off with no settings file is already pi's default: nothing to create.
    if (!enabled && !existsSync(getGlobalSettingsPath())) return NextResponse.json({ enabled: false });
    await updateGlobalSettings(getGlobalSettingsPath(), (settings) => {
      if (enabled) settings[KEY] = true;
      else delete settings[KEY];
    });
    return NextResponse.json({ enabled: await readEnabled() });
  } catch (error) {
    return errorResponse(error);
  }
}
