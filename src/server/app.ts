import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { DeviceRegistry } from '../gateway/device-registry';
import { SSHClientPool } from '../gateway/ssh-client-pool';
import { SSHServer } from '../gateway/ssh-server';
import { createHttpHandler } from './http-api';
import { handleTerminalWS } from './ws-terminal';
import { handleAgentRPCWS } from './ws-agent-rpc';
import type { ActiveDeviceConfig } from '../types/device';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AppConfig {
  httpPort?: number;
  sshPort?: number;
  host?: string;
  httpHost?: string;
  sshHost?: string;
  staticDir?: string;
  devicesConfigFile?: string;
}

export class PiWebGatewayApp {
  readonly registry: DeviceRegistry;
  readonly clientPool: SSHClientPool;
  readonly sshServer: SSHServer;
  readonly httpServer: http.Server;
  readonly wss: WebSocketServer;

  private httpPort: number;
  private httpHost: string;
  private sshPort: number;
  private devicesConfigFile: string;

  constructor(config: AppConfig = {}) {
    this.httpPort = config.httpPort ?? 9564;
    this.httpHost = config.httpHost ?? config.host ?? '127.0.0.1';
    this.sshPort = config.sshPort ?? 22222;
    this.devicesConfigFile = config.devicesConfigFile ?? path.join(process.cwd(), 'devices.json');

    this.registry = new DeviceRegistry(true);
    this.clientPool = new SSHClientPool(this.registry);
    this.sshServer = new SSHServer(this.registry, this.clientPool, {
      port: this.sshPort,
      host: config.sshHost ?? config.host ?? '0.0.0.0',
    });

    const staticDir = config.staticDir ?? path.join(__dirname, '../client');
    const httpHandler = createHttpHandler(this.registry, this.clientPool, staticDir);

    this.httpServer = http.createServer(httpHandler);
    this.wss = new WebSocketServer({ noServer: true });

    this.setupWebSocketRouting();
  }

  private setupWebSocketRouting(): void {
    this.httpServer.on('upgrade', (request, socket, head) => {
      const parsed = url.parse(request.url || '', true);
      const pathname = parsed.pathname;

      if (pathname === '/ws/terminal' || pathname === '/ws/agent') {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          if (pathname === '/ws/terminal') {
            handleTerminalWS(ws, request, this.registry);
          } else if (pathname === '/ws/agent') {
            handleAgentRPCWS(ws, request, this.registry);
          }
        });
      } else {
        socket.destroy();
      }
    });
  }

  async start(): Promise<{ httpPort: number; sshPort: number; httpHost: string }> {
    const actualSSHPort = await this.sshServer.start();
    const actualHTTPPort = await new Promise<number>((resolve, reject) => {
      this.httpServer.listen(this.httpPort, this.httpHost, () => {
        const addr = this.httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.httpPort;
        resolve(port);
      });
      this.httpServer.on('error', reject);
    });

    // Auto load configured devices from devices.json
    await this.loadConfiguredDevices();

    return {
      httpPort: actualHTTPPort,
      sshPort: actualSSHPort,
      httpHost: this.httpHost,
    };
  }

  private async loadConfiguredDevices(): Promise<void> {
    if (fs.existsSync(this.devicesConfigFile)) {
      try {
        const raw = fs.readFileSync(this.devicesConfigFile, 'utf8');
        const list: ActiveDeviceConfig[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const dev of list) {
            console.log(`[Config] Pre-loading device: ${dev.id} (${dev.host}:${dev.port})`);
            this.clientPool.addDevice(dev).catch((err) => {
              console.warn(`[Config] Device ${dev.id} initial connection: ${err.message}`);
            });
          }
        }
      } catch (err: any) {
        console.error(`[Config] Failed to load ${this.devicesConfigFile}:`, err.message);
      }
    }
  }

  async stop(): Promise<void> {
    this.clientPool.stop();
    await this.sshServer.close();
    await this.registry.closeAll();

    return new Promise((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => resolve());
      });
    });
  }
}
