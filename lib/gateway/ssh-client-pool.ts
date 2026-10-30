import ssh2 from 'ssh2';
import type { Client, ConnectConfig } from 'ssh2';
import type { ActiveDeviceConfig } from './types/device';
import { DeviceRegistry } from './device-registry';
import { SSHHostDriver } from './drivers/ssh-host-driver';
import { OfflineHostDriver } from './drivers/offline-host-driver';
import { buildConnectConfig } from './ssh-connect-config';
import { openJumpSocket, type JumpSocket } from './ssh-jump';
import { setupMeshReverseBridge } from './mesh-reverse-bridge';

const SSHClientClass = ssh2.Client;

export class SSHClientPool {
  private registry: DeviceRegistry;
  private configs = new Map<string, ActiveDeviceConfig>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private activeClients = new Map<string, Client>();
  private connectingClients = new Map<string, Client>();
  /**
   * The jump sockets a device is currently dialled through, if any.
   *
   * A hop is a client of its own, and the target's connection only lives while
   * its socket does. Ending it with the target keeps a re-dial from stacking
   * tunnels on the same jump host.
   */
  private jumpSockets = new Map<string, JumpSocket>();
  /**
   * Which connect attempt currently owns each device.
   *
   * Replacing a device (a changed host, or a remove followed by an add) ends
   * the old client, whose `close` event arrives later. Without this token that
   * late event would mark the *new* connection offline and reconnect it with the
   * old host and key — the device would flap and then quietly go back to where
   * it was configured to be.
   */
  private generations = new Map<string, number>();
  private stopped = false;

  constructor(registry: DeviceRegistry) {
    this.registry = registry;
  }

  /**
   * Register a device, and dial it unless told not to.
   *
   * `connect: false` is how a host discovered in `~/.ssh/config` becomes a
   * device without opening a connection: the user asked to *see* their hosts,
   * not to hold a session on every one of them. The placeholder still lands in
   * the registry, so the switcher lists it as offline and a click can dial it.
   */
  async addDevice(config: ActiveDeviceConfig, options: { connect?: boolean } = {}): Promise<void> {
    this.configs.set(config.id, config);
    const shouldConnect = options.connect ?? true;

    // Initial placeholder registration so device appears in list
    const existing = this.registry.get(config.id);
    if (!existing) {
      this.registry.register(
        {
          id: config.id,
          name: config.name,
          mode: config.mode ?? 'active_ssh',
          remoteAddr: `${config.host}:${config.port}`,
          status: shouldConnect ? 'connecting' : 'offline',
          lastSeen: Date.now(),
        },
        new OfflineHostDriver(
          config.id,
          shouldConnect
            ? `Connecting to ${config.host}:${config.port}...`
            : `Not connected yet: pick ${config.name} to dial ${config.host}:${config.port}`,
        )
      );
    }

    if (!shouldConnect) return;
    await this.connectDevice(config);
  }

  /** The config this pool currently holds for a device, or undefined when it is gone. */
  getDeviceConfig(deviceId: string): ActiveDeviceConfig | undefined {
    return this.configs.get(deviceId);
  }

  removeDevice(deviceId: string): void {
    this.jumpSockets.get(deviceId)?.close();
    this.jumpSockets.delete(deviceId);
    this.configs.delete(deviceId);
    // Bumping the generation makes every event from the closing client a no-op.
    this.generations.set(deviceId, (this.generations.get(deviceId) ?? 0) + 1);
    const timer = this.reconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(deviceId);
    }
    const client = this.activeClients.get(deviceId);
    if (client) {
      try { client.end(); } catch {}
      this.activeClients.delete(deviceId);
    }
    const connecting = this.connectingClients.get(deviceId);
    if (connecting) {
      try { connecting.destroy(); } catch {}
      this.connectingClients.delete(deviceId);
    }
    this.registry.unregister(deviceId);
  }

  private async connectDevice(config: ActiveDeviceConfig, retryCount = 0): Promise<void> {
    if (this.stopped || !this.configs.has(config.id)) return;

    // Reconnects and replacements must use what the pool holds now, never the
    // config object a timer captured minutes ago.
    const live = this.configs.get(config.id) ?? config;
    const generation = (this.generations.get(config.id) ?? 0) + 1;
    this.generations.set(config.id, generation);
    const superseded = () => this.generations.get(config.id) !== generation;

    const client = new SSHClientClass();
    this.connectingClients.set(config.id, client);

    const built = buildConnectConfig(live);
    const connectConfig: ConnectConfig = {
      ...built.config,
      host: live.host,
      port: live.port,
    };

    // A `ProxyJump` host is not dialled: its socket comes from the hop. The
    // target client cannot tell the difference — it reads SSH bytes off the
    // forwarded channel exactly as it would off a TCP connection.
    if (live.jump && live.jump.length > 0) {
      try {
        const jump = await openJumpSocket(live.jump, { host: live.host, port: live.port }, {
          onWarning: (message) => console.warn(`[Gateway] ${message}`),
        });
        if (superseded()) {
          jump.close();
          return;
        }
        this.jumpSockets.get(live.id)?.close();
        this.jumpSockets.set(live.id, jump);
        connectConfig.sock = jump.sock as unknown as ConnectConfig['sock'];
      } catch (error) {
        if (superseded()) return;
        this.connectingClients.delete(config.id);
        const existing = this.registry.get(config.id);
        if (existing && existing.info.mode === 'active_ssh') {
          this.registry.register(
            {
              ...existing.info,
              status: 'offline',
              lastSeen: Date.now(),
            },
            new OfflineHostDriver(config.id, message(error)),
          );
        }
        this.scheduleReconnect(config, retryCount);
        return;
      }
    }

    client.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
      if (live.password) {
        finish(prompts.map(() => live.password!));
      } else {
        finish([]);
      }
    });

    client.on('ready', () => {
      if (superseded()) {
        // The device was removed or reconfigured while this handshake was in
        // flight: this connection belongs to nobody now.
        try { client.end(); } catch {}
        return;
      }
      this.connectingClients.delete(config.id);
      this.activeClients.set(config.id, client);
      // Nagle + delayed ACK turn one round trip into two on a high-latency link:
      // the kernel holds a small write until the peer's ACK arrives, which on a
      // 250 ms path means every command can cost 500 ms instead of 250 ms. The
      // gateway's traffic is request/response command lines, exactly the pattern
      // Nagle hurts. Measured against a 257 ms-RTT VPS, single-command latency
      // went from 274/592/272/809/326 ms to a steady 245-285 ms.
      try { client.setNoDelay(true); } catch { /* not supported: harmless */ }
      const driver = new SSHHostDriver(config.id, client);
      // Open the command channel now: a channel open is a full round trip and the
      // first request after any page load needs one, so paying it here (while the
      // page is still loading) is free.
      void driver.warmUp();

      // Establish reverse bridge over the existing SSH tunnel for native mesh communication
      void setupMeshReverseBridge(config.id, client).catch(() => {});

      const existing = this.registry.get(config.id);
      const mode = existing ? existing.info.mode : 'active_ssh';
      const boundPort = existing ? existing.info.boundPort : undefined;
      this.registry.register(
        {
          id: config.id,
          name: live.name,
          mode,
          boundPort,
          remoteAddr: `${live.host}:${live.port}`,
          status: 'online',
          lastSeen: Date.now(),
        },
        driver
      );
    });

    client.on('error', (err) => {
      this.jumpSockets.get(config.id)?.close();
      this.jumpSockets.delete(config.id);
      if (superseded()) return;
      this.connectingClients.delete(config.id);
      const existing = this.registry.get(config.id);
      if (existing && existing.info.mode === 'active_ssh') {
        this.registry.register(
          {
            ...existing.info,
            status: 'offline',
            lastSeen: Date.now(),
          },
          new OfflineHostDriver(config.id, `Connection error: ${err.message}`)
        );
      }
      this.scheduleReconnect(config, retryCount);
    });

    client.on('close', () => {
      // The hop belongs to this connection: ending it with the target keeps a
      // reconnect from leaving the old tunnel open on the jump host.
      this.jumpSockets.get(config.id)?.close();
      this.jumpSockets.delete(config.id);
      if (superseded()) return;
      this.connectingClients.delete(config.id);
      this.activeClients.delete(config.id);
      const existing = this.registry.get(config.id);
      if (existing && existing.info.mode === 'active_ssh') {
        this.registry.register(
          {
            ...existing.info,
            status: 'offline',
            lastSeen: Date.now(),
          },
          new OfflineHostDriver(config.id, 'Connection closed. Reconnecting...')
        );
        this.scheduleReconnect(config, retryCount);
      }
    });

    try {
      client.connect(connectConfig);
    } catch {
      this.scheduleReconnect(config, retryCount);
    }
  }

  private scheduleReconnect(config: ActiveDeviceConfig, retryCount: number): void {
    if (this.stopped || !this.configs.has(config.id)) return;
    if (this.reconnectTimers.has(config.id)) return;

    const delay = Math.min(30000, 2000 * Math.pow(1.5, retryCount));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(config.id);
      // The pool may have a newer config by now (an edit landed while this timer
      // was pending), and connectDevice reads it from the map itself.
      this.connectDevice(this.configs.get(config.id) ?? config, retryCount + 1);
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(config.id, timer);
  }

  /**
   * Manually disconnect a device, cancelling any pending reconnects
   * and updating the registry status to offline.
   */
  manualDisconnect(deviceId: string): void {
    const timer = this.reconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(deviceId);
    }
    this.generations.set(deviceId, (this.generations.get(deviceId) ?? 0) + 1);

    const client = this.activeClients.get(deviceId);
    if (client) {
      this.activeClients.delete(deviceId);
      try { client.end(); } catch {}
    }
    const connecting = this.connectingClients.get(deviceId);
    if (connecting) {
      this.connectingClients.delete(deviceId);
      try { connecting.destroy(); } catch {}
    }

    const existing = this.registry.get(deviceId);
    if (existing) {
      this.registry.register(
        {
          ...existing.info,
          status: 'offline',
          lastSeen: Date.now(),
        },
        new OfflineHostDriver(deviceId, 'Manually disconnected by user')
      );
    }
  }

  /**
   * Manually initiate connection to a device right now.
   */
  async manualConnect(deviceId: string): Promise<{ success: boolean; status: string; error?: string }> {
    const config = this.configs.get(deviceId);
    if (!config) {
      return { success: false, status: 'offline', error: `Device ${deviceId} not found in pool` };
    }

    // A device that was never dialled (discovered from ~/.ssh/config) has no
    // client and no pending reconnect, so manualDisconnect has nothing to end;
    // it still marks the entry offline, which is the state this connect leaves.
    this.manualDisconnect(deviceId);

    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ success: false, status: 'offline', error: 'Connection timed out' });
        }
      }, 15000);
      timeout.unref?.();

      const checkTimer = setInterval(() => {
        const entry = this.registry.get(deviceId);
        if (entry && entry.info.status === 'online') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            clearInterval(checkTimer);
            resolve({ success: true, status: 'online' });
          }
        }
      }, 300);
      checkTimer.unref?.();

      void this.connectDevice(config, 0).catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          clearInterval(checkTimer);
          resolve({ success: false, status: 'offline', error: err?.message || String(err) });
        }
      });
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const client of this.connectingClients.values()) {
      try { client.destroy(); } catch {}
    }
    this.connectingClients.clear();

    for (const client of this.activeClients.values()) {
      try { client.destroy(); } catch {}
    }
    this.activeClients.clear();

    for (const jump of this.jumpSockets.values()) jump.close();
    this.jumpSockets.clear();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
