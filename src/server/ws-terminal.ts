import { WebSocket } from 'ws';
import http from 'node:http';
import url from 'node:url';
import { DeviceRegistry } from '../gateway/device-registry';

export async function handleTerminalWS(
  ws: WebSocket,
  req: http.IncomingMessage,
  registry: DeviceRegistry
) {
  const parsed = url.parse(req.url || '', true);
  const deviceId = (parsed.query.deviceId as string) || 'localhost';
  const cols = Number(parsed.query.cols) || 80;
  const rows = Number(parsed.query.rows) || 24;
  const cwd = parsed.query.cwd as string | undefined;
  const cmd = parsed.query.cmd as string | undefined;

  try {
    const driver = registry.getDriver(deviceId);
    const session = await driver.createTerminal({ cols, rows, cwd, initialCmd: cmd });

    const removeDataListener = session.onData((data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const removeExitListener = session.onExit((code: number) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code }));
        ws.close();
      }
    });

    ws.on('message', (message: Buffer | string) => {
      const str = message.toString();
      try {
        if (str.startsWith('{') && str.endsWith('}')) {
          const parsedMsg = JSON.parse(str);
          if (parsedMsg.type === 'resize') {
            session.resize(Number(parsedMsg.cols) || 80, Number(parsedMsg.rows) || 24);
            return;
          }
        }
      } catch {}

      session.write(message);
    });

    ws.on('close', () => {
      removeDataListener();
      removeExitListener();
      session.close();
    });

    ws.on('error', () => {
      session.close();
    });
  } catch (err: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\n\x1b[31m[Gateway Error]\x1b[0m ${err.message || String(err)}\r\n`);
      ws.close();
    }
  }
}
