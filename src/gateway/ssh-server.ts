import ssh2 from 'ssh2';
import type { Server, ServerChannel, Session, Connection, AuthContext } from 'ssh2';
import net from 'node:net';
import crypto from 'node:crypto';
import { DeviceRegistry } from './device-registry';
import type { DeviceInfo } from '../types/device';
import { SSHClientPool } from './ssh-client-pool';
import type { IHostDriver, TerminalOptions, TerminalSession, FileEntry, ExecResult, RPCChannel } from '../types/host-driver';

const SSHServerClass = ssh2.Server;

export class ReverseTunnelHostDriver implements IHostDriver {
  readonly deviceId: string;
  readonly boundPort: number;
  private alive = true;

  constructor(deviceId: string, boundPort: number) {
    this.deviceId = deviceId;
    this.boundPort = boundPort;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async createTerminal(opts?: TerminalOptions): Promise<TerminalSession> {
    throw new Error(`Device ${this.deviceId} is connected via reverse port-forwarding (bound port ${this.boundPort}). Direct SSH shell requires SSH service on the target port.`);
  }

  async readDir(dirPath: string): Promise<FileEntry[]> {
    throw new Error(`Device ${this.deviceId} does not expose SFTP on tunnel port`);
  }

  async readFile(filePath: string): Promise<Buffer> {
    throw new Error(`Device ${this.deviceId} does not expose SFTP on tunnel port`);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    throw new Error(`Device ${this.deviceId} does not expose SFTP on tunnel port`);
  }

  async stat(targetPath: string): Promise<FileEntry> {
    throw new Error(`Device ${this.deviceId} does not expose SFTP on tunnel port`);
  }

  async exec(cmd: string, args?: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    throw new Error(`Device ${this.deviceId} does not expose exec on tunnel port`);
  }

  async spawnPiRpc(opts?: { cwd?: string; sessionDir?: string; resumeSession?: string }): Promise<RPCChannel> {
    throw new Error(`Device ${this.deviceId} does not expose RPC on tunnel port`);
  }

  async close(): Promise<void> {
    this.alive = false;
  }
}

export interface SSHServerOptions {
  port?: number;
  host?: string;
  hostKey?: string;
}

export class SSHServer {
  private server: Server;
  private port: number;
  private host: string;
  private registry: DeviceRegistry;
  private clientPool: SSHClientPool;
  private forwarders = new Map<string, net.Server>();
  private activeClients = new Set<Connection>();

  constructor(registry: DeviceRegistry, clientPool: SSHClientPool, opts: SSHServerOptions = {}) {
    this.registry = registry;
    this.clientPool = clientPool;
    this.port = opts.port ?? 22222;
    this.host = opts.host ?? '0.0.0.0';

    const hostKey = opts.hostKey || this.generateHostKey();

    this.server = new SSHServerClass({ hostKeys: [hostKey] });
    this.setupHandlers();
  }

  private generateHostKey(): string {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    return privateKey;
  }

  private setupHandlers(): void {
    this.server.on('connection', (client: Connection, info: any) => {
      this.activeClients.add(client);
      let authenticatedDeviceId: string | null = null;
      let authenticatedDeviceName: string = '';

      client.on('authentication', (ctx: any) => {
        if (ctx.method === 'publickey') {
          const fingerprint = crypto.createHash('sha256').update(ctx.key.data).digest('hex').slice(0, 12);
          authenticatedDeviceId = `device-${fingerprint}`;
          authenticatedDeviceName = ctx.username || authenticatedDeviceId;
          ctx.accept();
        } else if (ctx.method === 'password' || ctx.method === 'none') {
          authenticatedDeviceId = ctx.username || `device-${info.ip}-${info.port}`;
          authenticatedDeviceName = ctx.username || authenticatedDeviceId;
          ctx.accept();
        } else {
          ctx.reject(['publickey', 'password']);
        }
      });

      client.on('request', (accept: any, reject: any, name: string, reqInfo: any) => {
        if (name === 'tcpip-forward') {
          const deviceId = authenticatedDeviceId || `device-${info.ip}`;
          const deviceName = authenticatedDeviceName || deviceId;

          const forwarder = net.createServer((sock) => {
            client.forwardOut(
              reqInfo.bindAddr,
              reqInfo.bindPort,
              sock.remoteAddress || '127.0.0.1',
              sock.remotePort || 0,
              (err: any, ch: any) => {
                if (err) {
                  sock.destroy();
                  return;
                }
                sock.pipe(ch);
                ch.pipe(sock);
              }
            );
          });

          forwarder.listen(0, '127.0.0.1', () => {
            const boundPort = (forwarder.address() as net.AddressInfo).port;
            this.forwarders.set(deviceId, forwarder);

            if (accept) {
              accept(boundPort);
            }

            const deviceInfo: DeviceInfo = {
              id: deviceId,
              name: deviceName,
              mode: 'reverse_tunnel',
              remoteAddr: `${info.ip}:${info.port}`,
              boundPort,
              status: 'online',
              lastSeen: Date.now(),
            };

            // Register immediately in the unified routing table
            const tunnelDriver = new ReverseTunnelHostDriver(deviceId, boundPort);
            this.registry.register(deviceInfo, tunnelDriver);
          });
        } else if (name === 'cancel-tcpip-forward') {
          const deviceId = authenticatedDeviceId || `device-${info.ip}`;
          const forwarder = this.forwarders.get(deviceId);
          if (forwarder) {
            forwarder.close();
            this.forwarders.delete(deviceId);
          }
          if (accept) accept();
        } else {
          if (reject) reject();
        }
      });

      client.on('session', (accept: any) => {
        const session: Session = accept();
        session.on('shell', (acceptShell) => {
          const stream: ServerChannel = acceptShell();
          stream.write('SSH Reverse Tunnel Gateway: Port forwarding active.\r\n');
        });
      });

      client.on('close', () => {
        this.activeClients.delete(client);
        if (authenticatedDeviceId) {
          const forwarder = this.forwarders.get(authenticatedDeviceId);
          if (forwarder) {
            forwarder.close();
            this.forwarders.delete(authenticatedDeviceId);
          }
          this.registry.unregister(authenticatedDeviceId);
        }
      });
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve(actualPort);
      });
      this.server.on('error', reject);
    });
  }

  async close(): Promise<void> {
    for (const client of this.activeClients) {
      try { (client as any).end?.(); } catch {}
    }
    this.activeClients.clear();

    for (const forwarder of this.forwarders.values()) {
      try { forwarder.close(); } catch {}
    }
    this.forwarders.clear();

    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
