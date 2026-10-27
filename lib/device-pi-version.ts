import "server-only";

import { REMOTE_PATH_PREFIX } from "@/lib/gateway/drivers/persistent-shell";

/**
 * The `pi` a device actually runs, asked of that device.
 *
 * The gateway's own `pi --version` answers a different question: on a fleet of
 * machines the CLI is upgraded at different times, so a new session opened on a
 * device was reporting the gateway's number while the device's binary answered
 * every prompt. `/api/devices/env` already knows how to find it — this reuses
 * that probe's PATH, which is where a user-level install lives (`~/.local/node`,
 * `~/.local/bin`, cargo, bun, nvm) and which sshd's non-interactive `sh` does
 * not read from any rc file.
 *
 * Cached per device for the process: a running gateway cannot see the CLI
 * change, and the versions line is read on every new-session render.
 */
const PROBE_TIMEOUT_MS = 20_000;

const PROBE = `${REMOTE_PATH_PREFIX}
PI_PATH="$(command -v pi 2>/dev/null || which pi 2>/dev/null || true)"
[ -n "$PI_PATH" ] || exit 0
pi --version 2>/dev/null || true
`;

export interface DevicePiVersionProbe {
  /** The driver's `exec`, injected so the parse is testable without a device. */
  exec(command: string, options: { timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** `pi --version`'s last word when it looks like a version, else `undefined`. */
export function readVersionLine(stdout: string): string | undefined {
  // Some installs print a banner first; the version is the last token of the
  // last line that carries one.
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const version = line.trim().split(/\s+/).pop() ?? "";
    if (/^\d+\.\d+\.\d+/.test(version)) return version;
  }
  return undefined;
}

/** Ask one device; `undefined` when it has no `pi` or would not answer. */
export async function probeDevicePiVersion(
  driver: DevicePiVersionProbe,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const result = await driver.exec(PROBE, { timeoutMs });
    if (result.exitCode !== 0) return undefined;
    return readVersionLine(result.stdout);
  } catch {
    // An offline device is not an error here: the line simply shows nothing.
    return undefined;
  }
}

const cache = new Map<string, Promise<string | undefined>>();

/** The cached probe for `deviceId`. */
export function devicePiVersion(deviceId: string, driver: DevicePiVersionProbe): Promise<string | undefined> {
  let entry = cache.get(deviceId);
  if (!entry) {
    entry = probeDevicePiVersion(driver);
    cache.set(deviceId, entry);
  }
  return entry;
}

/** Forget one device (after an install) or every device (tests). */
export function invalidateDevicePiVersion(deviceId?: string): void {
  if (deviceId === undefined) cache.clear();
  else cache.delete(deviceId);
}
