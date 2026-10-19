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

export interface ActiveDeviceConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKey?: string | Buffer;
  privateKeyPath?: string;
  password?: string;
  defaultCwd?: string;
}
