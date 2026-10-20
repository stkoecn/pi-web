import { DeviceRegistry } from './device-registry';
import { SSHClientPool } from './ssh-client-pool';
import { SSHServer } from './ssh-server';
import {
  devicesConfigPath,
  readDevicesFile,
  sameConnection,
  type DeviceFileIssue,
} from './device-config-file';
import type { IHostDriver } from './types/host-driver';
import type { ActiveDeviceConfig } from './types/device';

/**
 * A device that is known to the gateway but not connected right now.
 *
 * Its own class, not a bare Error: routes answer 503 with a code the client can
 * act on ("reconnect the device"), and must not report it as a server fault.
 */
export class DeviceOfflineError extends Error {
  readonly deviceId: string;
  readonly code = 'device-offline';

  constructor(deviceId: string) {
    super(`Device '${deviceId}' is not connected or offline`);
    this.name = 'DeviceOfflineError';
    this.deviceId = deviceId;
  }
}

export class GatewayManager {
  readonly registry = new DeviceRegistry(true); // localhost enabled by default
  readonly clientPool: SSHClientPool;
  readonly sshServer: SSHServer;
  private initialized = false;
  /** The device list the file last gave us, in file order. */
  private configuredDevices: ActiveDeviceConfig[] = [];

  constructor() {
    this.clientPool = new SSHClientPool(this.registry);
    this.sshServer = new SSHServer(this.registry, this.clientPool, {
      port: 22222,
      host: '0.0.0.0',
    });
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Load devices.json if present
    const loaded = readDevicesFile();
    if (loaded.error) console.error('[Gateway] Failed to load devices.json:', loaded.error);
    for (const issue of loaded.issues) {
      console.warn(`[Gateway] Ignoring devices.json entry #${issue.index}: ${issue.reason}`);
    }
    // Connect every configured device in parallel. Each handshake takes 2-3 s
    // on a WAN link, and doing them one after another left the last device
    // unusable for ten seconds after every restart.
    const devices = loaded.configs.filter((dev) => (dev.mode ?? 'active_ssh') === 'active_ssh');
    for (const dev of devices) {
      console.log(`[Gateway] Loading device from config: ${dev.id} (${dev.host}:${dev.port})`);
    }
    this.configuredDevices = loaded.configs;
    await Promise.allSettled(devices.map((dev) => this.clientPool.addDevice(dev)));

    // Start reverse tunnel SSH server
    try {
      await this.sshServer.start();
      console.log('[Gateway] Reverse tunnel SSH server listening on 0.0.0.0:22222');
    } catch (e: any) {
      if (e.code !== 'EADDRINUSE') {
        console.error('[Gateway] Failed to start reverse tunnel SSH server:', e);
      }
    }
  }

  public getDriver(id?: string): IHostDriver {
    return this.registry.getDriver(id || 'localhost');
  }

  /** The device list as the file defines it, in file order (localhost is not in it). */
  public listConfiguredDevices(): ActiveDeviceConfig[] {
    return this.configuredDevices.map((config) => ({ ...config }));
  }

  /**
   * Make the live pool match a list: connect what is new, drop what is gone,
   * and reconnect only what actually changed.
   *
   * Editing a name or a note must not cost a handshake, and neither must the
   * Reload button: an unchanged device keeps its connection, its shell pool and
   * its open sessions. That is why the comparison is field by field instead of
   * "re-add everything".
   */
  public async syncDevices(
    configs: readonly ActiveDeviceConfig[],
  ): Promise<{ connected: string[]; removed: string[]; unchanged: string[] }> {
    const previous = new Map(this.configuredDevices.map((config) => [config.id, config]));
    const next = new Map(configs.map((config) => [config.id, config]));

    const removed: string[] = [];
    for (const id of previous.keys()) {
      if (next.has(id) || id === 'localhost') continue;
      this.clientPool.removeDevice(id);
      removed.push(id);
    }

    const connected: string[] = [];
    const unchanged: string[] = [];
    for (const config of configs) {
      if ((config.mode ?? 'active_ssh') !== 'active_ssh') continue;
      const before = previous.get(config.id);
      if (before && sameConnection(before, config)) {
        // The connection is unchanged, but the label may not be: a rename must
        // show up in the switcher without paying for a new handshake.
        this.registry.updateInfo(config.id, { name: config.name, remoteAddr: config.host });
        unchanged.push(config.id);
        continue;
      }
      // A changed connection replaces the old one: removeDevice ends the client,
      // so a new host or key cannot inherit the previous connection's channels.
      if (before) this.clientPool.removeDevice(config.id);
      await this.clientPool.addDevice({ ...config, mode: 'active_ssh' });
      connected.push(config.id);
    }

    this.configuredDevices = configs.map((config) => ({ ...config }));
    return { connected, removed, unchanged };
  }

  /**
   * Read `devices.json` again and apply it.
   *
   * This is what the Reload button and an add/remove call: the file is the
   * source of truth, so the caller edits it and then asks the gateway to
   * become what it says, instead of keeping the two in step by hand.
   */
  public async reloadDevicesFromFile(
    filePath?: string,
  ): Promise<{ path: string; configs: ActiveDeviceConfig[]; issues: DeviceFileIssue[]; error?: string; sync: { connected: string[]; removed: string[]; unchanged: string[] } }> {
    const loaded = readDevicesFile(filePath);
    const sync = loaded.error
      ? { connected: [], removed: [], unchanged: [] }
      : await this.syncDevices(loaded.configs);
    return { path: loaded.path, configs: loaded.configs, issues: loaded.issues, error: loaded.error, sync };
  }

  /** The file the gateway reads. Kept in one place so a route never guesses it. */
  public configPath(): string {
    return devicesConfigPath();
  }

  public async getOrConnectDriver(id?: string, timeoutMs = 10000): Promise<IHostDriver> {
    const targetId = id || 'localhost';
    if (targetId === 'localhost') return this.registry.getDriver('localhost');

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const entry = this.registry.get(targetId);
      if (entry && entry.driver.isAlive()) {
        return entry.driver;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.registry.getDriver(targetId);
  }

  /**
   * The device's driver only while it is already connected.
   *
   * `getOrConnectDriver` polls for up to ten seconds, which is right for a
   * request that can afford to wait for a first connect (a page load). An
   * action the user is watching cannot: deleting a session on a device that is
   * mid-reconnect sat on a spinner for ten seconds and then failed anyway,
   * because the pool reconnects on its own schedule. Those callers ask here and
   * get an answer at once.
   */
  public getOnlineDriver(id?: string): IHostDriver {
    const targetId = id || 'localhost';
    if (targetId === 'localhost') return this.registry.getDriver('localhost');
    const entry = this.registry.get(targetId);
    if (!entry || !entry.driver.isAlive()) {
      throw new DeviceOfflineError(targetId);
    }
    return entry.driver;
  }

  /**
   * The device's driver, connecting first when it has never connected.
   *
   * Only a device this gateway knows and has not reached yet waits — a first
   * connect legitimately takes seconds. A device whose connection dropped is
   * already being retried by the SSH pool on its own backoff, so waiting here
   * would only add ten seconds to a request that is going to fail anyway.
   */
  public async getDriverForRequest(id?: string, timeoutMs = 10000): Promise<IHostDriver> {
    const targetId = id || 'localhost';
    if (targetId === 'localhost') return this.registry.getDriver('localhost');
    const entry = this.registry.get(targetId);
    // No entry means no device by that id is configured, so there is nothing to
    // wait for. Every configured device has a placeholder entry before the
    // first request is served (SSHClientPool.addDevice registers it), which is
    // what makes this test the same as "unknown to this gateway".
    if (!entry) throw new DeviceOfflineError(targetId);
    if (entry.driver.isAlive()) return entry.driver;
    if (entry.info.status !== 'connecting') throw new DeviceOfflineError(targetId);
    try {
      return await this.getOrConnectDriver(targetId, timeoutMs);
    } catch (error) {
      // getOrConnectDriver ends with registry.getDriver, whose own refusal is a
      // plain Error; normalise it so callers can recognise the state.
      throw error instanceof DeviceOfflineError ? error : new DeviceOfflineError(targetId);
    }
  }
}

declare global {
  var __piWebGateway: GatewayManager | undefined;
}

export function getGateway(): GatewayManager {
  if (!globalThis.__piWebGateway) {
    globalThis.__piWebGateway = new GatewayManager();
    globalThis.__piWebGateway.init().catch(console.error);
  }
  return globalThis.__piWebGateway;
}
