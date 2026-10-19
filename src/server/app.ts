import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import { WebSocketServer } from 'ws';
import { DeviceRegistry } from '../gateway/device-registry';
import { SSHClientPool } from '../gateway/ssh-client-pool';
import { SSHServer } from '../gateway/ssh-server';
import { createHttpHandler } from './http-api';
import { handleTerminalWS } from './ws-terminal';
import { handleAgentRPCWS } from './ws-agent-rpc';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AppConfig {
  httpPort?: number;
  sshPort?: number;
  host?: string;
  staticDir?: string;
}

export class PiWebGatewayApp {
  readonly registry: DeviceRegistry;
  readonly clientPool: SSHClientPool;
  readonly sshServer: SSHServer;
  readonly httpServer: http.Server;
  readonly wss: WebSocketServer;

  private httpPort: number;
  private sshPort: number;

  constructor(config: AppConfig = {}) {
    this.httpPort = config.httpPort ?? 30150;
    this.sshPort = config.sshPort ?? 22222;

    this.registry = new DeviceRegistry(true);
    this.clientPool = new SSHClientPool(this.registry);
    this.sshServer = new SSHServer(this.registry, this.clientPool, {
      port: this.sshPort,
      host: config.host ?? '0.0.0.0',
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

  async start(): Promise<{ httpPort: number; sshPort: number }> {
    const actualSSHPort = await this.sshServer.start();
    const actualHTTPPort = await new Promise<number>((resolve, reject) => {
      this.httpServer.listen(this.httpPort, () => {
        const addr = this.httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.httpPort;
        resolve(port);
      });
      this.httpServer.on('error', reject);
    });

    return {
      httpPort: actualHTTPPort,
      sshPort: actualSSHPort,
    };
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
