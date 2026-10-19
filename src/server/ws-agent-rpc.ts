import { WebSocket } from 'ws';
import http from 'node:http';
import url from 'node:url';
import { DeviceRegistry } from '../gateway/device-registry';

export async function handleAgentRPCWS(
  ws: WebSocket,
  req: http.IncomingMessage,
  registry: DeviceRegistry
) {
  const parsed = url.parse(req.url || '', true);
  const deviceId = (parsed.query.deviceId as string) || 'localhost';
  const cwd = parsed.query.cwd as string | undefined;
  const session = parsed.query.session as string | undefined;

  try {
    const driver = registry.getDriver(deviceId);
    const rpcChannel = await driver.spawnPiRpc({ cwd, resumeSession: session });

    const removeMsgListener = rpcChannel.onMessage((msg: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });

    const removeErrListener = rpcChannel.onError((err: Error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stderr', text: err.message }));
      }
    });

    const removeCloseListener = rpcChannel.onClose((code?: number) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'process_exit', code }));
        ws.close();
      }
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const parsedData = JSON.parse(data.toString());
        if (parsedData.type === 'abort') {
          rpcChannel.abort();
        } else {
          rpcChannel.send(parsedData);
        }
      } catch (err: any) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON message' }));
        }
      }
    });

    ws.on('close', () => {
      removeMsgListener();
      removeErrListener();
      removeCloseListener();
      rpcChannel.close();
    });

    ws.on('error', () => {
      rpcChannel.close();
    });
  } catch (err: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', error: err.message || String(err) }));
      ws.close();
    }
  }
}
