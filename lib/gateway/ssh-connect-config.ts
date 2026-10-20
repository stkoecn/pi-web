import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectConfig } from 'ssh2';
import type { ActiveDeviceConfig } from './types/device';

/**
 * Turn a device config into what ssh2 needs to open a connection.
 *
 * Two callers need this: the pool, which dials a host directly, and the reverse
 * tunnel driver, which dials the gateway's own loopback port after the device
 * has dialled in. Both are logging into the *same* machine with the *same*
 * credentials, so they must resolve `~/.ssh/...` and choose between key and
 * password identically — a second copy of this logic is how a tunnel ends up
 * unable to log in even though the device is reachable.
 */
export interface BuiltConnectConfig {
  config: ConnectConfig;
  /** Set when the entry names a key that could not be read; the caller reports it. */
  warning?: string;
}

export function buildConnectConfig(
  device: ActiveDeviceConfig,
  overrides: Partial<ConnectConfig> = {},
): BuiltConnectConfig {
  const config: ConnectConfig = {
    username: device.username,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    readyTimeout: 15000,
    ...overrides,
  };

  let warning: string | undefined;
  if (device.privateKey) {
    config.privateKey = device.privateKey;
  } else if (device.privateKeyPath) {
    let resolved = device.privateKeyPath;
    if (resolved.startsWith('~')) resolved = path.join(os.homedir(), resolved.slice(1));
    try {
      config.privateKey = fs.readFileSync(resolved);
    } catch (error) {
      warning = `cannot read private key for ${device.id} at ${resolved}: ${message(error)}`;
    }
  }
  if (config.privateKey === undefined && device.password) {
    config.password = device.password;
  }

  return warning ? { config, warning } : { config };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
