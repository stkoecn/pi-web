"use client";

import { LOCAL_DEVICE_ID, isRemoteDevice, withDeviceId } from "@/lib/device-context";

/**
 * Browser-side home directory lookup, one per device.
 *
 * The devices we attach to are not all Linux VPSes: macOS answers
 * `/Users/<name>` and has no `/root`, so a hardcoded `/root` default made every
 * path the UI opened point at a missing directory. The value is fetched once
 * per device and cached in a module map; a failed lookup is evicted so it
 * retries after a reconnect.
 *
 * `deviceHomeOrRoot` is the synchronous fallback for render paths that cannot
 * await: `/` exists on every POSIX device, unlike `/root`.
 */

const homes = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

/** Home already resolved for this device, if any. */
export function peekHome(deviceId: string | null | undefined): string | undefined {
  if (!isRemoteDevice(deviceId)) return undefined;
  return homes.get(deviceId);
}

/** Seed the cache (the sidebar fetches `/api/home` for its own use). */
export function rememberHome(deviceId: string | null | undefined, home: string | undefined): void {
  if (isRemoteDevice(deviceId) && home) homes.set(deviceId, home);
}

export function loadHome(deviceId: string | null | undefined): Promise<string> {
  const id = deviceId || LOCAL_DEVICE_ID;
  const cached = homes.get(id);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = pending.get(id);
  if (inflight) return inflight;

  const promise = fetch(withDeviceId("/api/home", id))
    .then((response) => (response.ok ? response.json() as Promise<{ home?: string | null }> : null))
    .then((data) => {
      const home = typeof data?.home === "string" && data.home ? data.home : "";
      if (home) homes.set(id, home);
      return home;
    })
    .catch(() => "")
    .finally(() => pending.delete(id));
  pending.set(id, promise);
  return promise;
}

/** Default workspace for a device: its home, or `/` before the lookup lands. */
export function deviceHomeOrRoot(deviceId: string | null | undefined): string {
  if (!isRemoteDevice(deviceId)) return "";
  return homes.get(deviceId) ?? "/";
}

/** Forget a device's home (after it reconnects with a different account). */
export function forgetHome(deviceId?: string): void {
  if (deviceId) {
    homes.delete(deviceId);
    pending.delete(deviceId);
  } else {
    homes.clear();
    pending.clear();
  }
}
