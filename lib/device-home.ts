import { homedir } from "node:os";
import { isRemoteDevice } from "@/lib/device-context";

/**
 * The home directory of a device.
 *
 * Never hardcode `/root`: the devices we attach to are not all Linux VPSes
 * (macOS answers `/Users/<name>`), so a hardcoded `/root` makes every default
 * path point at a directory that does not exist and the session and file
 * panels open empty. Ask the device instead and cache the answer per device —
 * a home directory does not move during a process lifetime.
 *
 * Only successes are cached: an offline device must retry once it comes back.
 */

const HOME_TIMEOUT_MS = 5_000;

interface HomeCaches {
  values: Map<string, string>;
  inflight: Map<string, Promise<string | null>>;
}

// Stored on globalThis so Next's dev-mode module reloads keep the cache.
function caches(): HomeCaches {
  const globalStore = globalThis as typeof globalThis & {
    __piWebDeviceHomes?: HomeCaches;
  };
  globalStore.__piWebDeviceHomes ??= { values: new Map(), inflight: new Map() };
  return globalStore.__piWebDeviceHomes;
}

/** Drop the cached home for one device (or every device). */
export function invalidateDeviceHome(deviceId?: string): void {
  const cache = caches();
  if (deviceId) {
    cache.values.delete(deviceId);
    cache.inflight.delete(deviceId);
  } else {
    cache.values.clear();
    cache.inflight.clear();
  }
}

async function probeRemoteHome(deviceId: string): Promise<string | null> {
  try {
    const { getGateway } = await import("@/lib/gateway/singleton");
    const driver = await getGateway().getOrConnectDriver(deviceId);
    const result = await Promise.race([
      driver.exec('printf %s "$HOME"'),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HOME_TIMEOUT_MS)),
    ]);
    if (!result) return null;
    const home = result.stdout.trim();
    // A shell without HOME, or an unexpected answer, is not a usable base path.
    return home.startsWith("/") ? home : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a device's home directory, or `null` when it cannot be determined.
 * Callers that must have a path should use `deviceHomeOrDefault`.
 */
export async function getDeviceHome(deviceId: string | null | undefined): Promise<string | null> {
  if (!isRemoteDevice(deviceId)) return homedir();
  const cache = caches();
  const cached = cache.values.get(deviceId);
  if (cached !== undefined) return cached;

  const pending = cache.inflight.get(deviceId);
  if (pending) return pending;

  const promise = probeRemoteHome(deviceId).then((home) => {
    if (home) cache.values.set(deviceId, home);
    cache.inflight.delete(deviceId);
    return home;
  });
  cache.inflight.set(deviceId, promise);
  return promise;
}

/**
 * Home directory for a device, falling back to `/` (the one path every POSIX
 * device has) rather than a plausible-looking `/root` that macOS lacks.
 */
export async function deviceHomeOrDefault(deviceId: string | null | undefined): Promise<string> {
  return (await getDeviceHome(deviceId)) ?? (isRemoteDevice(deviceId) ? "/" : homedir());
}

/** Synchronous peek at an already-resolved home, for hot paths. */
export function peekDeviceHome(deviceId: string | null | undefined): string | undefined {
  if (!isRemoteDevice(deviceId)) return homedir();
  return caches().values.get(deviceId);
}
