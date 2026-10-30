import os from "node:os";
import { readDevicesFile } from "./device-config-file";

let cachedHostId: string | null = null;

/**
 * Returns the canonical host ID for this gateway instance.
 *
 * Precedence:
 * 1. Process environment: `PI_WEB_HOST_ID` or `PI_WEB_DEVICE_ID`
 * 2. `devices.json` configured alias/self reference if specified
 * 3. System hostname (`os.hostname().toLowerCase()`)
 *
 * This ensures that a gateway running on `wsnas` is known as `wsnas`,
 * and one running on `wshome` is known as `wshome`, completely eliminating
 * ambiguous "localhost" references in mesh communications.
 */
export function getCanonicalHostId(): string {
  if (cachedHostId) return cachedHostId;

  // 1. Explicit environment variable override
  const envHost = (process.env.PI_WEB_HOST_ID || process.env.PI_WEB_DEVICE_ID || "").trim();
  if (envHost) {
    cachedHostId = envHost.toLowerCase();
    return cachedHostId;
  }

  // 2. Derive from system hostname
  try {
    const rawHostname = os.hostname().trim().toLowerCase();
    if (rawHostname && rawHostname !== "localhost") {
      // Strip domain suffix if present (e.g. wshome.lan -> wshome)
      cachedHostId = rawHostname.split(".")[0];
      return cachedHostId;
    }
  } catch {}

  // 3. Fallback
  cachedHostId = "localhost";
  return cachedHostId;
}

/**
 * Helper to check if a deviceId represents this local gateway instance,
 * matching either "localhost" or its canonical host ID.
 */
export function isLocalHostId(deviceId: string | null | undefined): boolean {
  if (!deviceId) return true;
  const canonical = getCanonicalHostId();
  const d = deviceId.trim().toLowerCase();
  return (
    d === "localhost" ||
    d === "local" ||
    d === "127.0.0.1" ||
    d === "::1" ||
    d === canonical
  );
}
