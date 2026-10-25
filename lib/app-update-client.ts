"use client";

import type { AppUpdateResponse } from "@/lib/api-types";

/**
 * One update check per page, shared by everything that reads it.
 *
 * Every fresh composer mounts the new-session header again (each move of the
 * new-session bar does), and a link that turned up late each time would
 * lengthen the versions line under the reader's eyes; from the second header
 * on it is there in the first paint. The same answer carries the running `pi`
 * version, so the versions line costs no second request.
 */
let appUpdateCheck: Promise<AppUpdateResponse | null> | null = null;
let appUpdateFound: AppUpdateResponse | null = null;

/** The answer already in hand, if a check has finished. */
export function appUpdateSnapshot(): AppUpdateResponse | null {
  return appUpdateFound;
}

export function checkAppUpdate(): Promise<AppUpdateResponse | null> {
  appUpdateCheck ??= fetch("/api/app-update")
    .then(async (response) => {
      if (!response.ok) return null;
      return await response.json() as AppUpdateResponse;
    })
    .then((result) => {
      appUpdateFound = result;
      return result;
    })
    .catch(() => {
      // Update checks are best-effort and must not interrupt a new session;
      // a later header asks again.
      appUpdateCheck = null;
      return null;
    });
  return appUpdateCheck;
}

/** The answer when it names a newer release, else `null`. */
export function appUpdateAvailable(result: AppUpdateResponse | null): AppUpdateResponse | null {
  if (!result) return null;
  return result.updateAvailable && result.latestVersion && result.releaseUrl ? result : null;
}

/** Only tests need this. */
export function resetAppUpdateCheck(): void {
  appUpdateCheck = null;
  appUpdateFound = null;
}
