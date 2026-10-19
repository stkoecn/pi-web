import http from 'node:http';
import url from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DeviceRegistry } from '../gateway/device-registry';
import { SSHClientPool } from '../gateway/ssh-client-pool';

export function createHttpHandler(
  registry: DeviceRegistry,
  clientPool: SSHClientPool,
  staticDir: string
) {
  return async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS headers for independent frontend deployment
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-device-id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname || '';
    const query = parsedUrl.query;

    const sendJson = (statusCode: number, data: any) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    const parseBody = async (): Promise<any> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return {};
      return JSON.parse(text);
    };

    try {
      // 1. Devices API
      if (pathname === '/api/devices' && req.method === 'GET') {
        const list = registry.list();
        return sendJson(200, { devices: list });
      }

      if (pathname === '/api/devices/connect' && req.method === 'POST') {
        const body = await parseBody();
        if (!body.host || !body.username) {
          return sendJson(400, { error: 'host and username are required' });
        }
        const id = body.id || `ssh-${body.host}-${body.port || 22}`;
        await clientPool.addDevice({
          id,
          name: body.name || id,
          host: body.host,
          port: Number(body.port) || 22,
          username: body.username,
          password: body.password,
          privateKey: body.privateKey,
          defaultCwd: body.defaultCwd,
        });
        return sendJson(200, { success: true, id });
      }

      if (pathname.startsWith('/api/devices/') && req.method === 'DELETE') {
        const id = pathname.replace('/api/devices/', '').trim();
        clientPool.removeDevice(id);
        registry.unregister(id);
        return sendJson(200, { success: true });
      }

      // Helper to extract deviceId from URL or header
      const deviceIdMatch = pathname.match(/^\/api\/devices\/([^/]+)/);
      const deviceId = (req.headers['x-device-id'] as string) || (deviceIdMatch ? deviceIdMatch[1] : null);

      if (deviceId) {
        const driver = registry.getDriver(deviceId);

        // 2. File browsing & reading
        if (pathname.includes('/files') && req.method === 'GET') {
          const dirPath = (query.path as string) || '.';
          const entries = await driver.readDir(dirPath);
          return sendJson(200, { path: dirPath, entries });
        }

        if (pathname.includes('/file') && req.method === 'GET') {
          const filePath = (query.path as string) || '';
          if (!filePath) return sendJson(400, { error: 'path is required' });
          const content = await driver.readFile(filePath);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(content);
          return;
        }

        if (pathname.includes('/file') && req.method === 'POST') {
          const filePath = (query.path as string) || '';
          if (!filePath) return sendJson(400, { error: 'path is required' });
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const buf = Buffer.concat(chunks);
          await driver.writeFile(filePath, buf);
          return sendJson(200, { success: true });
        }

        // 3. Git status and diff
        if (pathname.includes('/git/status') && req.method === 'GET') {
          const cwd = (query.cwd as string) || '.';
          const result = await driver.exec('git', ['status', '--porcelain', '-b'], { cwd });
          return sendJson(200, {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
        }

        if (pathname.includes('/git/diff') && req.method === 'GET') {
          const cwd = (query.cwd as string) || '.';
          const result = await driver.exec('git', ['diff'], { cwd });
          return sendJson(200, {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
        }

        // 4. General shell execution
        if (pathname.includes('/exec') && req.method === 'POST') {
          const body = await parseBody();
          const result = await driver.exec(body.cmd, body.args || [], { cwd: body.cwd });
          return sendJson(200, result);
        }
      }

      // 5. Serve static files for the Frontend
      if (req.method === 'GET' || req.method === 'HEAD') {
        const cleanPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const filePath = path.join(staticDir, cleanPath);
        try {
          const stats = await fs.stat(filePath);
          if (stats.isFile()) {
            const ext = path.extname(filePath);
            const mimeTypes: Record<string, string> = {
              '.html': 'text/html; charset=utf-8',
              '.js': 'application/javascript; charset=utf-8',
              '.css': 'text/css; charset=utf-8',
              '.json': 'application/json',
              '.svg': 'image/svg+xml',
            };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
            if (req.method === 'HEAD') {
              res.end();
            } else {
              const data = await fs.readFile(filePath);
              res.end(data);
            }
            return;
          }
        } catch {}
      }

      sendJson(404, { error: 'Not Found' });
    } catch (err: any) {
      sendJson(500, { error: err.message || String(err) });
    }
  };
}
