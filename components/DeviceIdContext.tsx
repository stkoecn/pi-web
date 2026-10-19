"use client";

import { createContext, useContext, type ReactNode } from "react";
import { LOCAL_DEVICE_ID } from "@/lib/device-context";

/**
 * Which device the current view is talking to.
 *
 * Threading `deviceId` through every prop in the transcript tree would touch a
 * dozen components that only forward it, so the selected device is published
 * once at the shell and read where a URL is actually built (thinking blocks,
 * tool-result images, bash output, subagent transcripts). Anything that fetches
 * must still call `withDeviceId(url, useClientDeviceId())` — the context carries
 * the id, not the URL.
 */
const DeviceIdContext = createContext<string>(LOCAL_DEVICE_ID);

export function DeviceIdProvider({ deviceId, children }: { deviceId: string; children: ReactNode }) {
  return <DeviceIdContext.Provider value={deviceId}>{children}</DeviceIdContext.Provider>;
}

export function useClientDeviceId(): string {
  return useContext(DeviceIdContext);
}
