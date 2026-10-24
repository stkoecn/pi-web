import ssh2 from 'ssh2';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import type { JumpHost } from './types/device';
import { buildConnectConfig } from './ssh-connect-config';

const SSHClientClass = ssh2.Client;

/**
 * A forwarded channel, which ssh2's types describe as a plain `Readable` for
 * `ConnectConfig.sock` even though it is a full duplex stream. The cast happens
 * where the client is configured; here the channel keeps its real type so it can
 * be closed.
 */
export interface JumpSocket {
  /** The channel carrying the target's TCP stream, once every hop is up. */
  sock: ClientChannel;
  /** End every hop, newest first. Safe to call more than once. */
  close(): void;
}

/**
 * Dial a host through one or more hops.
 *
 * ssh2 has no `ProxyJump`, but it has `ConnectConfig.sock`: a client given a
 * socket reads and writes SSH bytes on it instead of opening a TCP connection.
 * So a jump is the same move OpenSSH's `-W` makes — log in to the hop, ask it
 * to forward a TCP stream to the next address, and hand that stream to the next
 * client. The last stream is the target's socket, and from there every feature
 * (exec, SFTP, PTY, and the `forwardOut` the reverse tunnel needs) works
 * unchanged, because the target client only ever sees one byte stream.
 *
 * Hops are dialled in order. Each one is a login of its own, so it carries its
 * own user and key.
 */
export async function openJumpSocket(
  hops: readonly JumpHost[],
  target: { host: string; port: number },
  options: { readyTimeout?: number; onWarning?: (message: string) => void } = {},
): Promise<JumpSocket> {
  const readyTimeout = options.readyTimeout ?? 15000;
  /** Newest last, so `close()` walks it backwards. */
  const opened: Client[] = [];

  const close = () => {
    while (opened.length > 0) {
      const client = opened.pop();
      if (!client) continue;
      try { client.end(); } catch { /* already gone */ }
    }
  };

  try {
    let sock: ClientChannel | undefined;
    for (let index = 0; index < hops.length; index += 1) {
      const hop = hops[index];
      const next = index + 1 < hops.length ? hops[index + 1] : target;
      const client = await connectHop(hop, sock, readyTimeout, options.onWarning);
      opened.push(client);
      sock = await forwardThrough(client, next.host, next.port, hop.alias, readyTimeout);
    }
    if (!sock) throw new Error('no hop to dial through');
    return { sock, close };
  } catch (error) {
    close();
    throw error;
  }
}

function connectHop(
  hop: JumpHost,
  sock: ClientChannel | undefined,
  readyTimeout: number,
  onWarning?: (message: string) => void,
): Promise<Client> {
  const built = buildConnectConfig(
    {
      id: hop.alias,
      name: hop.alias,
      host: hop.host,
      port: hop.port,
      username: hop.username,
      privateKeyPath: hop.privateKeyPath,
    },
    { readyTimeout },
  );
  if (built.warning) onWarning?.(built.warning);

  const config: ConnectConfig = { ...built.config, host: hop.host, port: hop.port };
  if (sock) config.sock = sock as unknown as ConnectConfig['sock'];

  return new Promise<Client>((resolve, reject) => {
    const client = new SSHClientClass();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* nothing to end */ }
      reject(new Error(`cannot reach ${hop.alias} (${hop.host}:${hop.port}): ${error.message}`));
    };

    client.on('ready', () => {
      if (settled) {
        try { client.end(); } catch { /* nothing to end */ }
        return;
      }
      settled = true;
      try { client.setNoDelay(true); } catch { /* not supported: harmless */ }
      resolve(client);
    });
    client.on('error', fail);
    client.on('close', () => {
      // A close before `ready` is a refusal, not a shutdown: the message would
      // otherwise be an empty "closed" with no address in it.
      if (!settled) fail(new Error('the connection closed during the handshake'));
    });

    try {
      client.connect(config);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function forwardThrough(
  client: Client,
  host: string,
  port: number,
  alias: string,
  timeoutMs: number,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${alias} did not open a stream to ${host}:${port} within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();

    client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
      if (settled) {
        // The timeout already answered; the stream that arrives late belongs to
        // nobody, so it is closed rather than leaked.
        if (!error) {
          try { channel.close(); } catch { /* already gone */ }
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(new Error(`${alias} cannot reach ${host}:${port}: ${error.message}`));
        return;
      }
      resolve(channel);
    });
  });
}
