import ssh2 from 'ssh2';
import type { Server, ServerChannel, Session, Connection, AuthContext } from 'ssh2';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DeviceRegistry } from './device-registry';
import type { DeviceInfo } from './types/device';
import { SSHClientPool } from './ssh-client-pool';
import type { IHostDriver, TerminalOptions, TerminalSession, FileEntry, ExecResult, RPCChannel } from './types/host-driver';
import { SSHHostDriver } from './drivers/ssh-host-driver';

const SSHServerClass = ssh2.Server;

export class ReverseTunnelHostDriver implements IHostDriver {
  readonly deviceId: string;
  readonly boundPort: number;
  private alive = true;
  private sshDriver?: SSHHostDriver;
  private connectingPromise?: Promise<SSHHostDriver>;

  constructor(deviceId: string, boundPort: number) {
    this.deviceId = deviceId;
    this.boundPort = boundPort;
  }

  isAlive(): boolean {
    return this.alive;
  }

  private async getDriver(): Promise<SSHHostDriver> {
    if (this.sshDriver && this.sshDriver.isAlive()) return this.sshDriver;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise<SSHHostDriver>((resolve, reject) => {
      const client = new ssh2.Client();
      client.on('ready', () => {
        this.sshDriver = new SSHHostDriver(this.deviceId, client);
        resolve(this.sshDriver);
      });
      client.on('error', (err) => {
        reject(new Error(`Failed to connect to reverse tunnel on port ${this.boundPort}: ${err.message}`));
      });

      const home = os.homedir();
      let key: Buffer | undefined;
      for (const keyName of ['id_rsa', 'id_ed25519', 'wshome']) {
        const p = path.join(home, '.ssh', keyName);
        if (fs.existsSync(p)) {
          try { key = fs.readFileSync(p); break; } catch {}
        }
      }

      client.connect({
        host: '127.0.0.1',
        port: this.boundPort,
        username: 'root',
        password: 'password', // fallback password
        privateKey: key,
        readyTimeout: 10000,
      });
    }).finally(() => {
      this.connectingPromise = undefined;
    });

    return this.connectingPromise;
  }

  async createTerminal(opts?: TerminalOptions): Promise<TerminalSession> {
    const driver = await this.getDriver();
    return driver.createTerminal(opts);
  }

  async readDir(dirPath: string): Promise<FileEntry[]> {
    const driver = await this.getDriver();
    return driver.readDir(dirPath);
  }

  async readFile(filePath: string): Promise<Buffer> {
    const driver = await this.getDriver();
    return driver.readFile(filePath);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const driver = await this.getDriver();
    return driver.writeFile(filePath, content);
  }

  async stat(targetPath: string): Promise<FileEntry> {
    const driver = await this.getDriver();
    return driver.stat(targetPath);
  }

  async exec(cmd: string, args?: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    const driver = await this.getDriver();
    return driver.exec(cmd, args, opts);
  }

  async spawnPiRpc(opts?: { cwd?: string; sessionDir?: string; resumeSession?: string }): Promise<RPCChannel> {
    const driver = await this.getDriver();
    return driver.spawnPiRpc(opts);
  }

  async close(): Promise<void> {
    this.alive = false;
    if (this.sshDriver) {
      await this.sshDriver.close();
      this.sshDriver = undefined;
    }
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
