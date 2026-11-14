import { DeviceRegistry } from './device-registry';
import { isLocalHostId } from './host-identity';
import { SSHClientPool } from './ssh-client-pool';
import {
  devicesConfigPath,
  readDevicesFile,
  sameConnection,
  type DeviceFileIssue,
} from './device-config-file';
import { readSshConfig, sshHostToDevice, type SshConfigRead } from './ssh-config';
import { isHostEnabled, readEnabledHosts, setHostEnabled } from './enabled-hosts';
import type { IHostDriver } from './types/host-driver';
import type { ActiveDeviceConfig, DeviceInfo } from './types/device';

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
  private initialized = false;
  /** The device list the file last gave us, in file order. */
  private configuredDevices: ActiveDeviceConfig[] = [];

  constructor() {
    this.clientPool = new SSHClientPool(this.registry);
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
    for (const dev of loaded.configs) {
      console.log(`[Gateway] Loading device from config: ${dev.id} (${dev.host}:${dev.port})`);
    }
    this.configuredDevices = loaded.configs;

    // The hosts `ssh` already knows about are listed too, but not dialled: the
    // user asked to see their machines, not to hold a connection on each. A
    // `devices.json` entry always wins for the same id, because that is where a
    // password-only host or a renamed display name lives.
    const discovered = this.discoverSshHosts(loaded.configs, { enabledOnly: true });
    for (const config of discovered) {
      console.log(`[Gateway] Offering ssh host ${config.id} (${config.host}:${config.port}), not dialled`);
    }
    await Promise.allSettled(discovered.map((dev) => this.clientPool.addDevice(dev, { connect: false })));

    await Promise.allSettled(loaded.configs.map((dev) => this.clientPool.addDevice(dev)));
  }

  public getDriver(id?: string): IHostDriver {
    return this.registry.getDriver(id || 'localhost');
  }

  /** The device list as the file defines it, in file order (localhost is not in it). */
  public listConfiguredDevices(): ActiveDeviceConfig[] {
    return this.configuredDevices.map((config) => ({ ...config }));
  }

  /** Every device the user can pick, as the registry currently sees it. */
  public listDevices(): DeviceInfo[] {
    // A host the user switched off is not offered: the switcher is the list
    // of hosts this gateway serves, and the switch exists to keep a machine
    // out of it. `devices.json` entries and localhost are always in.
    return this.registry.list().filter((device) => this.isDeviceEnabled(device.id));
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
      await this.clientPool.addDevice(config);
      connected.push(config.id);
    }

    this.configuredDevices = configs.map((config) => ({ ...config }));

    // Discovered hosts come and go with `~/.ssh/config`, which a reload may not
    // have touched. Re-offering them keeps a host that is not in devices.json
    // from disappearing from the switcher the first time someone edits the file.
    for (const config of this.discoverSshHosts(configs, { enabledOnly: true })) {
      const entry = this.registry.get(config.id);
      if (entry) continue;
      await this.clientPool.addDevice(config, { connect: false });
    }

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

  /**
   * The hosts `~/.ssh/config` names, minus the ones `devices.json` already
   * describes.
   *
   * A configured device is the user's explicit statement about a machine: its
   * id, its display name, its credential. Discovery must never overwrite that,
   * so the file wins by id.
   */
  public discoverSshHosts(
    configured: readonly ActiveDeviceConfig[] = this.configuredDevices,
    options: { enabledOnly?: boolean } = {},
  ): ActiveDeviceConfig[] {
    const taken = new Set(configured.map((config) => config.id));
    const read = this.readSshHosts();
    if (read.error) {
      console.warn(`[Gateway] Cannot read ${read.path}: ${read.error}`);
      return [];
    }
    for (const problem of read.problems) {
      const alias = problem.alias ? ` ${problem.alias}` : '';
      console.warn(`[Gateway] ssh config ${problem.where}:${alias} ${problem.reason}`);
    }
    // A host ssh knows about is not a host this gateway serves. `~/.ssh/config`
    // is the user's whole address book; the switcher should hold the few they
    // turned on, so an untouched config does not mean twenty idle devices.
    const enabled = options.enabledOnly === true ? readEnabledHosts() : undefined;
    const offered = (id: string): boolean => {
      if (!enabled) return true;
      if (enabled.enabled.includes(id)) return true;
      if (enabled.disabled.includes(id)) return false;
      return enabled.defaultEnabled;
    };
    const hosts: ActiveDeviceConfig[] = [];
    for (const host of read.hosts) {
      const config = sshHostToDevice(host);
      if (taken.has(config.id)) continue;
      if (!offered(config.id)) continue;
      taken.add(config.id);
      hosts.push(config);
    }
    return hosts;
  }

  /** What `~/.ssh/config` said, for the settings pane and for diagnostics. */
  public readSshHosts(): SshConfigRead {
    return readSshConfig();
  }

  /**
   * Dial a device the user just picked, and answer whether it worked.
   *
   * The switcher calls this before it moves: a host that cannot be reached must
   * leave the current view alone instead of replacing it with an error page.
   * `localhost` and an already-online device succeed without a handshake.
   */
  public async connectForSelection(
    deviceId: string,
  ): Promise<{ success: boolean; status: string; error?: string }> {
    if (deviceId === 'localhost') return { success: true, status: 'online' };
    const entry = this.registry.get(deviceId);
    if (entry?.driver.isAlive()) return { success: true, status: 'online' };

    const config = this.configuredDevices.find((c) => c.id === deviceId);
    const discovered = config ? undefined : this.discoverSshHosts().find((c) => c.id === deviceId);
    const target = config ?? discovered;
    if (!target) {
      return { success: false, status: 'offline', error: `Unknown device ${deviceId}` };
    }
    // A host ssh knows about but the user switched off is not dialled: the whole
    // point of the switch is that nothing is opened until it is on.
    if (!config && !isHostEnabled(deviceId)) {
      return {
        success: false,
        status: 'offline',
        error: `${deviceId} is switched off: turn it on in Settings > Devices first`,
      };
    }

    if (!config) {
      // A discovered host is not in the pool until someone asks for it.
      await this.clientPool.addDevice(target, { connect: false });
    }
    return this.clientPool.manualConnect(deviceId);
  }

  /**
   * Switch a discovered host on or off.
   *
   * Off also drops it from the pool: a host the user turned off must not keep
   * a live connection and an entry in the switcher, and leaving the driver in
   * place would do both. `devices.json` entries are not in this set — they are
   * the request itself, so they have no switch to flip.
   */
  public async setDeviceEnabled(deviceId: string, enabled: boolean): Promise<void> {
    if (deviceId === 'localhost') return;
    const configured = this.configuredDevices.some((config) => config.id === deviceId);
    if (configured) return;
    await setHostEnabled(deviceId, enabled);
    if (!enabled) {
      this.clientPool.removeDevice(deviceId);
      return;
    }
    // Switching on is what puts the host in the switcher: an entry that is not
    // in the pool is not listed at all, so without this the switch would only
    // take effect after a restart.
    if (this.registry.get(deviceId)) return;
    const config = this.discoverSshHosts().find((candidate) => candidate.id === deviceId);
    if (config) await this.clientPool.addDevice(config, { connect: false });
  }

  /** Whether a discovered host is switched on; a `devices.json` entry always is. */
  public isDeviceEnabled(deviceId: string): boolean {
    if (deviceId === 'localhost') return true;
    if (this.configuredDevices.some((config) => config.id === deviceId)) return true;
    return isHostEnabled(deviceId);
  }

  /** The default for a host the switch file has never mentioned. */
  public readEnabledDefault(): boolean {
    return readEnabledHosts().defaultEnabled;
  }

  /** The file the gateway reads. Kept in one place so a route never guesses it. */
  public configPath(): string {
    return devicesConfigPath();
  }

  public async getOrConnectDriver(id?: string, timeoutMs = 10000): Promise<IHostDriver> {
    const targetId = id || 'localhost';
    if (targetId === 'localhost' || isLocalHostId(targetId)) return this.registry.getDriver('localhost');

    const entry = this.registry.get(targetId);
    if (entry && entry.driver.isAlive()) {
      return entry.driver;
    }

    // Trigger connection if device is not currently alive or in-flight
    void this.connectForSelection(targetId).catch(() => {});

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = this.registry.get(targetId);
      if (current && current.driver.isAlive()) {
        return current.driver;
      }
      await new Promise((r) => setTimeout(r, 100));
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
    if (targetId === 'localhost' || isLocalHostId(targetId)) return this.registry.getDriver('localhost');
    const entry = this.registry.get(targetId);
    if (!entry || !entry.driver.isAlive()) {
      throw new DeviceOfflineError(targetId);
    }
    return entry.driver;
  }

  /**
   * Manually connect a configured device.
   */
  public async connectDevice(deviceId: string): Promise<{ success: boolean; status: string; error?: string }> {
    const config = this.configuredDevices.find((c) => c.id === deviceId);
    if (!config) {
      return { success: false, status: 'offline', error: `Device ${deviceId} not found in configured devices` };
    }
    return this.clientPool.manualConnect(deviceId);
  }

  /**
   * Manually disconnect a device.
   */
  public async disconnectDevice(deviceId: string): Promise<{ success: boolean; status: string }> {
    this.clientPool.manualDisconnect(deviceId);
    return { success: true, status: 'offline' };
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
    if (targetId === 'localhost' || isLocalHostId(targetId)) return this.registry.getDriver('localhost');
    let entry = this.registry.get(targetId);
    // No entry means no device by that id is configured, so there is nothing to
    // wait for. Every configured device has a placeholder entry before the
    // first request is served (SSHClientPool.addDevice registers it), which is
    // what makes this test the same as "unknown to this gateway".
    if (!entry) throw new DeviceOfflineError(targetId);
    if (entry.driver.isAlive()) return entry.driver;
    if (entry.info.status !== 'connecting') {
      const res = await this.connectForSelection(targetId).catch(() => null);
      if (!res || !res.success) {
        throw new DeviceOfflineError(targetId);
      }
      entry = this.registry.get(targetId);
      if (entry?.driver.isAlive()) return entry.driver;
    }
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
