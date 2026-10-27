import { NextResponse } from "next/server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { devicePiVersion } from "@/lib/device-pi-version";
import type { AppUpdateResponse } from "@/lib/api-types";
import { getPiWebReleaseUrl, isNewerStableVersion } from "@/lib/app-update";
import { piCliVersion } from "@/lib/pi-cli-version";

export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const NPM_LATEST_URL = "https://registry.npmjs.org/@agegr%2Fpi-web/latest";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const SKIP_VERSION_CHECK = process.env.PI_WEB_SKIP_VERSION_CHECK === "1";

interface AppUpdateCache {
  value?: AppUpdateResponse;
  expiresAt: number;
  inFlight?: Promise<AppUpdateResponse>;
}

declare global {
  var __piWebAppUpdateCache: AppUpdateCache | undefined;
}

function getCache(): AppUpdateCache {
  return globalThis.__piWebAppUpdateCache ??= { expiresAt: 0 };
}

/**
 * The registry's latest release.
 *
 * Deliberately carries no `piVersion`: this answer is cached for half a day,
 * while the version belongs to one device and can change under it.
 */
async function fetchLatestVersion(): Promise<AppUpdateResponse> {
  const response = await fetch(NPM_LATEST_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);

  const body = await response.json() as { version?: unknown };
  const latestVersion = typeof body.version === "string" ? body.version : "";
  const releaseUrl = getPiWebReleaseUrl(latestVersion);
  if (!releaseUrl) throw new Error("npm registry returned an invalid version");

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: isNewerStableVersion(latestVersion, CURRENT_VERSION),
    releaseUrl,
  };
}

async function loadUpdateStatus(): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (!cache.inFlight) {
    cache.inFlight = fetchLatestVersion().then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + CACHE_TTL_MS;
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (cache.value) return cache.value;
    throw error;
  }
}

/**
 * The `pi` version to show for this request's device.
 *
 * A device answers for itself: the CLI is upgraded on each machine on its own
 * schedule, so the gateway's number is not the number answering a prompt there.
 * The gateway's own probe is the fallback when the device cannot be asked.
 */
async function versionFor(deviceId: string): Promise<string | undefined> {
  if (!isRemoteDevice(deviceId)) return piCliVersion();
  try {
    const { getGateway } = await import("@/lib/gateway/singleton");
    const driver = getGateway().getOnlineDriver(deviceId);
    if (!driver) return undefined;
    return await devicePiVersion(deviceId, {
      exec: (command, { timeoutMs }) => driver.exec(command, [], { timeoutMs }),
    });
  } catch {
    // A device that is not connected answers nothing. The release check above
    // is about Pi Web, not about that host, so it still gets through: the
    // versions line simply has no pi number to show.
    return undefined;
  }
}

export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);
  if (SKIP_VERSION_CHECK) {
    const piVersion = await versionFor(deviceId);
    return NextResponse.json({
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      updateAvailable: false,
      releaseUrl: "",
      ...(piVersion ? { piVersion } : {}),
    } satisfies AppUpdateResponse);
  }
  try {
    const [status, piVersion] = await Promise.all([loadUpdateStatus(), versionFor(deviceId)]);
    // `undefined` rather than absent: a device whose CLI cannot be read must not
    // inherit the cached answer of a device that could.
    return NextResponse.json({ ...status, piVersion });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
