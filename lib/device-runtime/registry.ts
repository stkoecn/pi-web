import { LOCAL_DEVICE_ID } from "../device-context";
import { isLocalHostId } from "../gateway/host-identity";
import { readDevicesFile } from "../gateway/device-config-file";
import { LocalDeviceRuntime } from "./local-runtime";
// SshRemoteDeviceRuntime imports remote-session-delete and remote-settings,
// which are server-side SSH drivers. Dynamically imported so importing registry
// does not eagerly require server-only files in test runners.
type SshRemoteDeviceRuntime = import("./ssh-remote-runtime").SshRemoteDeviceRuntime;
import type { IDeviceRuntime } from "./types";

export type RemoteRuntimeResolver = (deviceId: string) => Promise<IDeviceRuntime>;

/**
 * Registry and factory for IDeviceRuntime instances across local and remote devices.
 */
export class DeviceRuntimeRegistry {
  private static instance: DeviceRuntimeRegistry | null = null;
  private localRuntime: IDeviceRuntime | null = null;
  private remoteRuntimeResolver: RemoteRuntimeResolver | null = null;
  private readonly customRuntimes = new Map<string, IDeviceRuntime>();
  private readonly remoteRuntimes = new Map<string, SshRemoteDeviceRuntime>();

  /**
   * Returns the singleton registry instance.
   */
  static getInstance(): DeviceRuntimeRegistry {
    if (!DeviceRuntimeRegistry.instance) {
      DeviceRuntimeRegistry.instance = new DeviceRuntimeRegistry();
    }
    return DeviceRuntimeRegistry.instance;
  }

  /**
   * Resets the singleton instance (mainly for unit tests).
   */
  static resetInstance(): void {
    DeviceRuntimeRegistry.instance = null;
  }

  /**
   * Registers a specific IDeviceRuntime instance for a deviceId.
   */
  registerRuntime(deviceId: string, runtime: IDeviceRuntime): void {
    this.customRuntimes.set(deviceId.trim().toLowerCase(), runtime);
  }

  /**
   * Unregisters a runtime instance for a deviceId.
   */
  unregisterRuntime(deviceId: string): boolean {
    return this.customRuntimes.delete(deviceId.trim().toLowerCase());
  }

  /**
   * Configures a dynamic hook/resolver for remote device runtimes (e.g. SshRemoteDeviceRuntime).
   */
  setRemoteRuntimeResolver(resolver: RemoteRuntimeResolver | null): void {
    this.remoteRuntimeResolver = resolver;
  }

  /**
   * Resolves IDeviceRuntime for a given deviceId.
   * - If deviceId is omitted, empty, LOCAL_DEVICE_ID, or matches local host identity, returns LocalDeviceRuntime singleton.
   * - If an explicit runtime was registered, returns that runtime.
   * - If remoteRuntimeResolver is set, delegates resolution to it.
   * - If deviceId is configured in devices.json (enabled SSH device), automatically creates and caches SshRemoteDeviceRuntime.
   * - Otherwise throws an error.
   */
  async getDeviceRuntime(deviceId?: string): Promise<IDeviceRuntime> {
    const normalizedId = deviceId ? deviceId.trim().toLowerCase() : undefined;
    if (normalizedId) {
      const custom = this.customRuntimes.get(normalizedId);
      if (custom) {
        return custom;
      }
    }

    if (!deviceId || deviceId === LOCAL_DEVICE_ID || isLocalHostId(deviceId)) {
      if (!this.localRuntime) {
        this.localRuntime = new LocalDeviceRuntime();
      }
      return this.localRuntime;
    }

    if (this.remoteRuntimeResolver) {
      const resolved = await this.remoteRuntimeResolver(deviceId);
      if (resolved) {
        return resolved;
      }
    }

    // Default resolver: check cached remote runtimes or match against devices.json
    const cachedRemote = normalizedId ? this.remoteRuntimes.get(normalizedId) : undefined;
    if (cachedRemote) {
      return cachedRemote;
    }

    const devices = readDevicesFile();
    const matched = normalizedId ? devices.configs.find((c) => c.id.toLowerCase() === normalizedId) : undefined;
    if (matched && normalizedId) {
      const { SshRemoteDeviceRuntime } = await import("./ssh-remote-runtime");
      const remoteRuntime = new SshRemoteDeviceRuntime(matched.id);
      this.remoteRuntimes.set(normalizedId, remoteRuntime);
      return remoteRuntime;
    }

    // Check if the device is known to gateway (active in registry, reverse tunnel, or discovered in ~/.ssh/config)
    try {
      const { getGateway } = await import("../gateway/singleton");
      const gateway = getGateway();
      const inRegistry = normalizedId ? gateway.registry.get(normalizedId) : undefined;
      const inTunnels = normalizedId ? gateway.listTunnels().find((t) => t.deviceId.toLowerCase() === normalizedId) : undefined;
      const inDiscovered = normalizedId ? gateway.discoverSshHosts().find((c) => c.id.toLowerCase() === normalizedId) : undefined;
      const resolvedId = inRegistry ? normalizedId : (inTunnels?.deviceId || inDiscovered?.id);

      if (resolvedId && normalizedId) {
        const { SshRemoteDeviceRuntime } = await import("./ssh-remote-runtime");
        const remoteRuntime = new SshRemoteDeviceRuntime(resolvedId);
        this.remoteRuntimes.set(normalizedId, remoteRuntime);
        return remoteRuntime;
      }
    } catch (_) {}

    throw new Error(`Device runtime not found for device: ${deviceId}`);
  }
}

/**
 * Convenience helper to resolve IDeviceRuntime for a given deviceId.
 */
export async function getDeviceRuntime(deviceId?: string): Promise<IDeviceRuntime> {
  return DeviceRuntimeRegistry.getInstance().getDeviceRuntime(deviceId);
}
