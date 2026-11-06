"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { LOCAL_DEVICE_ID } from "@/lib/device-context";

interface DeviceContextValue {
  deviceId: string;
  hostId: string;
}

/**
 * Which device the current view is talking to, and the hostId of this gateway.
 *
 * Threading `deviceId` through every prop in the transcript tree would touch a
 * dozen components that only forward it, so the selected device is published
 * once at the shell and read where a URL is actually built (thinking blocks,
 * tool-result images, bash output, subagent transcripts). Anything that fetches
 * must still call `withDeviceId(url, useClientDeviceId())` — the context carries
 * the id, not the URL.
 */
const DeviceContext = createContext<DeviceContextValue>({
  deviceId: LOCAL_DEVICE_ID,
  hostId: "localhost",
});

export function DeviceIdProvider({
  deviceId,
  hostId = "localhost",
  children,
}: {
  deviceId: string;
  hostId?: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ deviceId, hostId }), [deviceId, hostId]);
  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export function useClientDeviceId(): string {
  return useContext(DeviceContext).deviceId;
}

export function useGatewayHostId(): string {
  return useContext(DeviceContext).hostId;
}
