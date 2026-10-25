"use client";

import type { AppUpdateResponse } from "@/lib/api-types";

/**
 * One update check per device, shared by everything that reads it.
 *
 * Every fresh composer mounts the new-session header again (each move of the
 * new-session bar does), and a link that turned up late each time would
 * lengthen the versions line under the reader's eyes; from the second header on
 * it is there in the first paint. The same answer carries the `pi` version of
 * that device, so the versions line costs no second request — and it is keyed
 * by device, because each machine upgrades its CLI on its own schedule.
 */
const checks = new Map<string, Promise<AppUpdateResponse | null>>();
const found = new Map<string, AppUpdateResponse | null>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * React's subscription for `appUpdateSnapshot`.
 *
 * Read through `useSyncExternalStore`, never by seeding `useState`: this module
 * can already hold an answer when a component first renders on the client, and
 * a state initialiser that read it would paint a line the server's HTML does
 * not have — React then reports "some attributes of the server rendered HTML
 * didn't match the client properties" and refuses to patch it up.
 */
export function subscribeAppUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The answer already in hand for `deviceId`, if a check has finished. */
export function appUpdateSnapshot(deviceId: string): AppUpdateResponse | null {
  return found.get(deviceId) ?? null;
}

/** The URL the check asks, scoped to the device whose `pi` it reports. */
export function appUpdateUrl(deviceId: string): string {
  return deviceId && deviceId !== "localhost"
    ? `/api/app-update?deviceId=${encodeURIComponent(deviceId)}`
    : "/api/app-update";
}

export function checkAppUpdate(deviceId: string): Promise<AppUpdateResponse | null> {
  const cached = checks.get(deviceId);
  if (cached) return cached;
  const request = fetch(appUpdateUrl(deviceId))
    .then(async (response) => {
      if (!response.ok) return null;
      return await response.json() as AppUpdateResponse;
    })
    .then((result) => {
      found.set(deviceId, result);
      notify();
      return result;
    })
    .catch(() => {
      // Update checks are best-effort and must not interrupt a new session;
      // a later header asks again.
      checks.delete(deviceId);
      return null;
    });
  checks.set(deviceId, request);
  return request;
}

/** The answer when it names a newer release, else `null`. */
export function appUpdateAvailable(result: AppUpdateResponse | null): AppUpdateResponse | null {
  if (!result) return null;
  return result.updateAvailable && result.latestVersion && result.releaseUrl ? result : null;
}

/** Only tests need this. */
export function resetAppUpdateCheck(): void {
  checks.clear();
  found.clear();
  notify();
}
