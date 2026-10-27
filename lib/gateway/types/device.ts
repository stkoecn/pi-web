export type DeviceMode = 'active_ssh' | 'reverse_tunnel';
export type DeviceStatus = 'online' | 'connecting' | 'offline';

export interface DeviceInfo {
  id: string;
  name: string;
  mode: DeviceMode;
  remoteAddr: string;
  status: DeviceStatus;
  lastSeen: number;
  boundPort?: number; // Port dynamically allocated for reverse tunnel
  osInfo?: string;
}

/**
 * One host on the way to a device, for `ProxyJump`.
 *
 * ssh2 has no `ProxyJump` option, so the pool opens the hop itself and hands
 * the resulting channel to the next client as its socket — the same trick
 * OpenSSH's `-W` uses. Credentials live here because a hop is a login of its
 * own: it may use a different user and key than the machine behind it.
 */
export interface JumpHost {
  /** The `~/.ssh/config` alias, for messages. */
  alias: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
}

export interface ActiveDeviceConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  mode?: DeviceMode;
  privateKey?: string | Buffer;
  privateKeyPath?: string;
  password?: string;
  defaultCwd?: string;
  /** Hops to dial through, in order; empty or absent means a direct connection. */
  jump?: JumpHost[];
}
