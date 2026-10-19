import ssh2 from 'ssh2';
import type { Client, ConnectConfig } from 'ssh2';
import type { ActiveDeviceConfig } from '../types/device';
import { DeviceRegistry } from './device-registry';
import { SSHHostDriver } from './drivers/ssh-host-driver';

const SSHClientClass = ssh2.Client;

export class SSHClientPool {
  private registry: DeviceRegistry;
  private configs = new Map<string, ActiveDeviceConfig>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private activeClients = new Map<string, Client>();
  private stopped = false;

  constructor(registry: DeviceRegistry) {
    this.registry = registry;
  }

  async addDevice(config: ActiveDeviceConfig): Promise<void> {
    this.configs.set(config.id, config);
    await this.connectDevice(config);
  }

  removeDevice(deviceId: string): void {
    this.configs.delete(deviceId);
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
    this.registry.unregister(deviceId);
  }

  private async connectDevice(config: ActiveDeviceConfig, retryCount = 0): Promise<void> {
    if (this.stopped || !this.configs.has(config.id)) return;

    const client = new SSHClientClass();

    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      readyTimeout: 15000,
    };

    if (config.privateKey) {
      connectConfig.privateKey = config.privateKey;
    } else if (config.password) {
      connectConfig.password = config.password;
    }

    client.on('ready', () => {
      this.activeClients.set(config.id, client);
      const driver = new SSHHostDriver(config.id, client);

      const existing = this.registry.get(config.id);
      const mode = existing ? existing.info.mode : 'active_ssh';
      const boundPort = existing ? existing.info.boundPort : undefined;

      this.registry.register(
        {
          id: config.id,
          name: config.name,
          mode,
          boundPort,
          remoteAddr: `${config.host}:${config.port}`,
          status: 'online',
          lastSeen: Date.now(),
        },
        driver
      );
    });

    client.on('error', () => {
      this.scheduleReconnect(config, retryCount);
    });

    client.on('close', () => {
      this.activeClients.delete(config.id);
      const existing = this.registry.get(config.id);
      if (existing && existing.info.mode === 'active_ssh') {
        this.registry.unregister(config.id);
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
      this.connectDevice(config, retryCount + 1);
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(config.id, timer);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const client of this.activeClients.values()) {
      try { client.end(); } catch {}
    }
    this.activeClients.clear();
  }
}
