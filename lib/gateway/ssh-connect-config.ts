import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthenticationType, ConnectConfig } from 'ssh2';
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
    config.tryKeyboard = true;
  }

  // Start authentication at the method the config actually names.
  //
  // ssh2's default handler always offers `none` first (client.js
  // `makeSimpleAuthHandler(['none', ...])`), and a server that requires auth
  // answers USERAUTH_FAILURE — a whole round trip spent learning what we
  // already know. Measured against a 282 ms RTT VPS the auth phase was: none ->
  // FAILURE -> publickey check -> PK_OK -> publickey -> SUCCESS, three round
  // trips; naming the method first makes it two.
  //
  // `none` stays last rather than being dropped: a server that accepts any user
  // (a tunnel endpoint, a container) only answers `none`, and trying it after a
  // rejected key costs nothing on the devices that do have credentials.
  const methods: AuthenticationType[] = [];
  if (config.privateKey !== undefined) methods.push('publickey');
  if (config.password !== undefined) methods.push('password');
  if (config.tryKeyboard) methods.push('keyboard-interactive');
  if (methods.length > 0) config.authHandler = [...methods, 'none'];

  return warning ? { config, warning } : { config };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
