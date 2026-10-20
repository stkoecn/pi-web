import { EventEmitter } from 'node:events';
import type { DeviceInfo } from './types/device';
import type { IHostDriver } from './types/host-driver';
import { LocalHostDriver } from './drivers/local-host-driver';

export interface DeviceEntry {
  info: DeviceInfo;
  driver: IHostDriver;
}

export class DeviceRegistry extends EventEmitter {
  private devices = new Map<string, DeviceEntry>();

  constructor(enableLocalhost: boolean = true) {
    super();
    if (enableLocalhost) {
      const localDriver = new LocalHostDriver();
      this.devices.set('localhost', {
        info: {
          id: 'localhost',
          name: 'Local Host',
          mode: 'active_ssh',
          remoteAddr: '127.0.0.1',
          status: 'online',
          lastSeen: Date.now(),
        },
        driver: localDriver,
      });
    }
  }

  register(info: DeviceInfo, driver: IHostDriver): void {
    this.devices.set(info.id, { info, driver });
    this.emit('device_connected', info);
  }

  unregister(deviceId: string): void {
    const entry = this.devices.get(deviceId);
    if (entry) {
      entry.info.status = 'offline';
      this.emit('device_disconnected', entry.info);
      this.devices.delete(deviceId);
    }
  }

  updateStatus(deviceId: string, status: DeviceInfo['status']): void {
    const entry = this.devices.get(deviceId);
    if (entry) {
      entry.info.status = status;
      entry.info.lastSeen = Date.now();
      this.emit('device_updated', entry.info);
    }
  }

  /**
   * Change what a device is called without touching its connection.
   *
   * A rename in `devices.json` must not cost a handshake: the driver, its shell
   * pool and every open session belong to the connection, not to the label.
   */
  updateInfo(deviceId: string, patch: Partial<Pick<DeviceInfo, 'name' | 'remoteAddr'>>): void {
    const entry = this.devices.get(deviceId);
    if (!entry) return;
    if (patch.name !== undefined) entry.info.name = patch.name;
    if (patch.remoteAddr !== undefined) entry.info.remoteAddr = patch.remoteAddr;
    this.emit('device_updated', entry.info);
  }

  get(deviceId: string): DeviceEntry | undefined {
    return this.devices.get(deviceId);
  }

  getDriver(deviceId: string): IHostDriver {
    const entry = this.devices.get(deviceId);
    if (!entry || !entry.driver.isAlive()) {
      throw new Error(`Device '${deviceId}' is not connected or offline`);
    }
    return entry.driver;
  }

  list(): DeviceInfo[] {
    return Array.from(this.devices.values()).map(e => ({
      ...e.info,
      status: e.driver.isAlive() ? e.info.status : 'offline',
    }));
  }

  async closeAll(): Promise<void> {
    for (const [id, entry] of this.devices) {
      try {
        await entry.driver.close();
      } catch {}
    }
    this.devices.clear();
  }
}
