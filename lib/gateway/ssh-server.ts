import ssh2 from 'ssh2';
import type { Server, Session, Connection } from 'ssh2';
import net from 'node:net';
import crypto from 'node:crypto';
import { DeviceRegistry } from './device-registry';
import type { DeviceInfo, ActiveDeviceConfig } from './types/device';
import { SSHClientPool } from './ssh-client-pool';
import type { IHostDriver, TerminalOptions, TerminalSession, FileEntry, ExecResult, RPCChannel } from './types/host-driver';
import { SSHHostDriver } from './drivers/ssh-host-driver';
import { buildConnectConfig } from './ssh-connect-config';

const SSHServerClass = ssh2.Server;

/**
 * A device that dialled in and asked the gateway to hold a port for it.
 *
 * The tunnel is only the *carrier*: it forwards a gateway-local port to the
 * device's own sshd, and everything else — sessions, files, terminals — is a
 * normal SSH connection to that port. Keeping the two hops separate is what
 * lets a device behind NAT be used exactly like one the gateway can dial.
 */
export class ReverseTunnelHostDriver implements IHostDriver {
  readonly deviceId: string;
  readonly boundPort: number;
  private config: ActiveDeviceConfig;
  private alive = true;
  private sshDriver?: SSHHostDriver;
  private connectingPromise?: Promise<SSHHostDriver>;
  /**
   * Set when logging in through the tunnel failed, cleared on the next attempt.
   *
   * The tunnel being up is not the same as the device being usable: a wrong key
   * in `devices.json` leaves a live forwarder and a host that answers every
   * request with an error. Reporting it offline is the only honest state the
   * registry can show, and the next request clears it if the login now works.
   */
  private lastFailure = false;

  constructor(config: ActiveDeviceConfig, boundPort: number) {
    this.config = config;
    this.deviceId = config.id;
    this.boundPort = boundPort;
  }

  /**
   * Adopt a new config after `devices.json` changed.
   *
   * The tunnel itself is untouched — the device is still dialled in and still
   * holds the same port — so only the inner connection is dropped when its
   * credentials actually changed. Restarting the tunnel would make the device
   * dial in again for something it cannot see.
   */
  async updateConfig(config: ActiveDeviceConfig): Promise<void> {
    const credentialsChanged = this.config.username !== config.username
      || (this.config.privateKeyPath ?? '') !== (config.privateKeyPath ?? '')
      || (this.config.password ?? '') !== (config.password ?? '')
      || String(this.config.privateKey ?? '') !== String(config.privateKey ?? '');
    this.config = config;
    if (credentialsChanged && this.sshDriver) {
      const driver = this.sshDriver;
      this.sshDriver = undefined;
      await driver.close().catch(() => undefined);
    }
  }

  isAlive(): boolean {
    if (!this.alive) return false;
    if (this.sshDriver) return this.sshDriver.isAlive();
    return !this.lastFailure;
  }

  /**
   * Log in to the device through the tunnel.
   *
   * The credentials are the device's own, from `devices.json` — the tunnel's
   * SSH username only identifies *which* configured device is calling in, it is
   * not the account we use on that machine. The remote side of the tunnel is
   * the device's sshd, so `host`/`port` here are the gateway's loopback and the
   * port the device was granted.
   */
  private async getDriver(): Promise<SSHHostDriver> {
    if (this.sshDriver && this.sshDriver.isAlive()) return this.sshDriver;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise<SSHHostDriver>((resolve, reject) => {
      const client = new ssh2.Client();
      const { config, warning } = buildConnectConfig(this.config, {
        host: '127.0.0.1',
        port: this.boundPort,
        readyTimeout: 15000,
      });
      if (warning) console.warn(`[ReverseTunnel] ${warning}`);

      client.on('ready', () => {
        client.setNoDelay(true);
        this.lastFailure = false;
        this.sshDriver = new SSHHostDriver(this.deviceId, client);
        void this.sshDriver.warmUp();
        resolve(this.sshDriver);
      });
      client.on('error', (err: Error) => {
        this.lastFailure = true;
        // A refused login is the interesting case: the tunnel exists but the
        // credentials in devices.json do not work on the device itself.
        reject(new Error(
          `cannot log in to ${this.deviceId} through its reverse tunnel on port ${this.boundPort}: ${err.message}`,
        ));
      });
      client.connect(config);
    }).finally(() => {
      this.connectingPromise = undefined;
    });

    return this.connectingPromise;
  }

  async createTerminal(opts?: TerminalOptions): Promise<TerminalSession> {
    return (await this.getDriver()).createTerminal(opts);
  }

  async readDir(dirPath: string): Promise<FileEntry[]> {
    return (await this.getDriver()).readDir(dirPath);
  }

  async readFile(filePath: string): Promise<Buffer> {
    return (await this.getDriver()).readFile(filePath);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    return (await this.getDriver()).writeFile(filePath, content);
  }

  async stat(targetPath: string): Promise<FileEntry> {
    return (await this.getDriver()).stat(targetPath);
  }

  async exec(cmd: string, args?: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    return (await this.getDriver()).exec(cmd, args, opts);
  }

  async spawnPiRpc(opts?: { cwd?: string; sessionDir?: string; resumeSession?: string }): Promise<RPCChannel> {
    return (await this.getDriver()).spawnPiRpc(opts);
  }

  async close(): Promise<void> {
    this.alive = false;
    if (this.sshDriver) {
      await this.sshDriver.close().catch(() => undefined);
      this.sshDriver = undefined;
    }
  }
}

export interface SSHServerOptions {
  port?: number;
  host?: string;
  hostKey?: string;
  /**
   * Which configured device a tunnel belongs to, by the SSH username it
   * authenticates with. Returning `undefined` rejects the forward: a tunnel
   * nobody can log into is not a device, and accepting it would list a host
   * that fails every single request.
   */
  resolveTunnelDevice?: (tunnelUsername: string) => ActiveDeviceConfig | undefined;
}

interface TunnelState {
  forwarder: net.Server;
  client: Connection;
  deviceId: string;
  boundPort: number;
  driver: ReverseTunnelHostDriver;
  /** The bind address the device asked for; the channel open must echo it. */
  bindAddr: string;
}

export class SSHServer {
  private server: Server;
  private port: number;
  private host: string;
  private registry: DeviceRegistry;
  private clientPool: SSHClientPool;
  private resolveTunnelDevice: (tunnelUsername: string) => ActiveDeviceConfig | undefined;
  /** Keyed by device id, so a second tunnel from the same device replaces the first. */
  private tunnels = new Map<string, TunnelState>();
  private activeClients = new Set<Connection>();

  constructor(registry: DeviceRegistry, clientPool: SSHClientPool, opts: SSHServerOptions = {}) {
    this.registry = registry;
    this.clientPool = clientPool;
    this.port = opts.port ?? 22222;
    this.host = opts.host ?? '0.0.0.0';
    this.resolveTunnelDevice = opts.resolveTunnelDevice ?? (() => undefined);

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
    this.server.on('connection', (client: Connection, info: { ip: string; port: number }) => {
      this.activeClients.add(client);
      let tunnelUsername: string | null = null;

      client.on('authentication', (ctx) => {
        // The device authenticates as itself; the gateway's own authorisation is
        // the network and the tunnel's SSH username, since this port is meant to
        // be reachable from the devices it serves.
        tunnelUsername = ctx.username || null;
        ctx.accept();
      });

      client.on('request', (accept, reject, name, reqInfo: { bindAddr?: string; bindPort?: number }) => {
        if (name === 'tcpip-forward') {
          const wanted = tunnelUsername ?? '';
          const config = this.resolveTunnelDevice(wanted);
          if (!config) {
            console.warn(
              `[ReverseTunnel] Refusing forward for unknown device "${wanted}": `
              + 'add it to devices.json with "mode": "reverse_tunnel" and this exact id',
            );
            reject?.();
            return;
          }

          const bindAddr = reqInfo.bindAddr ?? 'localhost';
          const forwarder = net.createServer((sock) => this.bridge(client, config.id, sock));
          forwarder.on('error', (error) => {
            console.warn(`[ReverseTunnel] forwarder for ${config.id} failed: ${error.message}`);
          });

          forwarder.listen(0, '127.0.0.1', () => {
            const boundPort = (forwarder.address() as net.AddressInfo).port;
            // `accept(port)` is how ssh2 tells the client which port it got when
            // it asked for 0. The client files that port in its forward table.
            accept?.(boundPort);

            const previous = this.tunnels.get(config.id);
            if (previous) void this.closeTunnel(config.id);

            const driver = new ReverseTunnelHostDriver(config, boundPort);
            this.tunnels.set(config.id, { forwarder, client, deviceId: config.id, boundPort, driver, bindAddr });

            const deviceInfo: DeviceInfo = {
              id: config.id,
              name: config.name,
              mode: 'reverse_tunnel',
              remoteAddr: `${info.ip}:${info.port}`,
              boundPort,
              status: 'online',
              lastSeen: Date.now(),
            };
            this.registry.register(deviceInfo, driver);
            console.log(`[ReverseTunnel] ${config.id} dialled in from ${info.ip}:${info.port}, bound to 127.0.0.1:${boundPort}`);
          });
          return;
        }

        if (name === 'cancel-tcpip-forward') {
          const config = this.resolveTunnelDevice(tunnelUsername ?? '');
          if (config) void this.closeTunnel(config.id);
          accept?.();
          return;
        }

        reject?.();
      });

      client.on('session', (accept) => {
        const session: Session = accept();
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('pi-web reverse tunnel gateway. Forwarding only — use `ssh -N`.\r\n');
          stream.exit(0);
          stream.end();
        });
      });

      client.on('close', () => {
        this.activeClients.delete(client);
        for (const [deviceId, tunnel] of this.tunnels) {
          if (tunnel.client === client) void this.closeTunnel(deviceId);
        }
      });
    });
  }

  /**
   * Pipe one incoming gateway-side connection into the device.
   *
   * The channel open must name the port the device was *given*, not the port it
   * asked for. A device asking `-R 0:...` requests port 0, and the ssh2 client
   * files its forwarding under the granted port, so echoing 0 back opens a
   * channel the client does not recognise and it answers "open failed" — which
   * the gateway only sees as a dropped connection at the SSH banner.
   */
  private bridge(client: Connection, deviceId: string, sock: net.Socket): void {
    const tunnel = this.tunnels.get(deviceId);
    if (!tunnel) {
      sock.destroy();
      return;
    }
    const remoteAddr = sock.remoteAddress ?? '127.0.0.1';
    const remotePort = sock.remotePort ?? 0;
    client.forwardOut(tunnel.bindAddr, tunnel.boundPort, remoteAddr, remotePort, (error, channel) => {
      if (error) {
        console.warn(`[ReverseTunnel] channel to ${deviceId} failed: ${error.message}`);
        sock.destroy();
        return;
      }
      sock.on('error', () => channel.destroy());
      channel.on('error', () => sock.destroy());
      sock.pipe(channel).pipe(sock);
    });
  }

  /** Forget a tunnel and everything built on it. Used on close and on a file edit. */
  async closeTunnel(deviceId: string): Promise<void> {
    const tunnel = this.tunnels.get(deviceId);
    if (!tunnel) return;
    this.tunnels.delete(deviceId);
    try { tunnel.forwarder.close(); } catch { /* already closed */ }
    await tunnel.driver.close().catch(() => undefined);
    const entry = this.registry.get(deviceId);
    if (entry && entry.info.mode === 'reverse_tunnel') this.registry.unregister(deviceId);
  }

  /** Devices currently dialled in, for the API and for a reload to compare against. */
  listTunnels(): { deviceId: string; boundPort: number }[] {
    return Array.from(this.tunnels.values()).map(({ deviceId, boundPort }) => ({ deviceId, boundPort }));
  }

  /** Apply an edited config to a tunnel that is already dialled in. */
  async updateTunnelConfig(config: ActiveDeviceConfig): Promise<boolean> {
    const tunnel = this.tunnels.get(config.id);
    if (!tunnel) return false;
    await tunnel.driver.updateConfig(config);
    this.registry.updateInfo(config.id, { name: config.name });
    return true;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.port);
      });
      this.server.on('error', reject);
    });
  }

  async close(): Promise<void> {
    for (const deviceId of Array.from(this.tunnels.keys())) {
      await this.closeTunnel(deviceId);
    }
    for (const client of this.activeClients) {
      try { client.end(); } catch { /* already gone */ }
    }
    this.activeClients.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
