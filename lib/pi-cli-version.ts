import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The version of the `pi` CLI this gateway actually runs.
 *
 * Deliberately not `next.config.ts`'s `NEXT_PUBLIC_PI_VERSION`: that reads
 * `node_modules/@earendil-works/pi-coding-agent/package.json`, which is the
 * *SDK* copy bundled with this app — pinned by `package.json`, replaced only by
 * `npm install`, and not necessarily the CLI on `PATH`. On this machine they
 * differ (SDK 1.2.0, CLI 1.3.0), so the versions line under "Pi Web" was
 * reporting a number that no process was running.
 *
 * Asking the binary costs one spawn (~120 ms here) and is cached for the
 * process lifetime: the CLI cannot change under a running gateway without a
 * restart anyway, and the answer only appears when someone clicks the brand.
 */
const VERSION_TIMEOUT_MS = 10_000;

let cached: Promise<string | undefined> | undefined;

async function readPiVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("pi", ["--version"], {
      // Windows resolves `pi` through a `.cmd` shim, which needs a shell.
      shell: process.platform === "win32",
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    const version = stdout.trim().split(/\s+/).pop() ?? "";
    // A version, not an error message that happened to reach stdout.
    return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    // No CLI on this host, or it refused to answer: the line shows nothing
    // rather than a wrong number.
    return undefined;
  }
}

/** The `pi` CLI's version, or `undefined` when it cannot be read. */
export function piCliVersion(): Promise<string | undefined> {
  cached ??= readPiVersion();
  return cached;
}

/** Drop the cache. Only tests need this; the CLI cannot change under a gateway. */
export function resetPiCliVersionCache(): void {
  cached = undefined;
}
