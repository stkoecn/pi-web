import { EventEmitter } from 'node:events';
import type { DeviceInfo } from './types/device';
import type { IHostDriver } from './types/host-driver';
import { LocalHostDriver } from './drivers/local-host-driver';
import { getCanonicalHostId, isLocalHostId } from './host-identity';

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
      const hostId = getCanonicalHostId();
      const localEntry: DeviceEntry = {
        info: {
          id: 'localhost',
          name: hostId,
          mode: 'active_ssh',
          remoteAddr: '127.0.0.1',
          status: 'online',
          lastSeen: Date.now(),
        },
        driver: localDriver,
      };
      this.devices.set('localhost', localEntry);
      if (hostId && hostId !== 'localhost') {
        this.devices.set(hostId, {
          info: {
            ...localEntry.info,
            id: hostId,
          },
          driver: localDriver,
        });
      }
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
    if (isLocalHostId(deviceId)) {
      return this.devices.get('localhost') ?? this.devices.get(getCanonicalHostId());
    }
    return this.devices.get(deviceId);
  }

  getDriver(deviceId: string): IHostDriver {
    if (isLocalHostId(deviceId)) {
      const entry = this.devices.get('localhost') ?? this.devices.get(getCanonicalHostId());
      if (entry && entry.driver.isAlive()) return entry.driver;
    }
    const entry = this.devices.get(deviceId);
    if (!entry || !entry.driver.isAlive()) {
      throw new Error(`Device '${deviceId}' is not connected or offline`);
    }
    return entry.driver;
  }

  list(): DeviceInfo[] {
    const list: DeviceInfo[] = [];
    for (const [id, entry] of this.devices) {
      if (isLocalHostId(id) && id !== 'localhost') continue;
      list.push({
        ...entry.info,
        status: entry.driver.isAlive() ? entry.info.status : 'offline',
      });
    }
    return list;
  }

  async closeAll(): Promise<void> {
    for (const [, entry] of this.devices) {
      try {
        await entry.driver.close();
      } catch {}
    }
    this.devices.clear();
  }
}
