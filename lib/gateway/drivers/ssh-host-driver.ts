import ssh2 from 'ssh2';
import type { Client, SFTPWrapper, ClientChannel } from 'ssh2';
import type { IHostDriver, TerminalOptions, TerminalSession, FileEntry, ExecResult, RPCChannel } from '../types/host-driver';
import { randomUUID } from 'node:crypto';
import { PersistentShellPool, REMOTE_PATH_PREFIX } from './persistent-shell';
import { withChannelRetry } from './channel-retry';

/** Largest payload one SFTP READ may carry (256 KiB packet limit minus headers). */
const SFTP_READ_CHUNK = 128 * 1024;
/** READs in flight at once: enough to keep a high-latency link busy. */
const SFTP_READ_CONCURRENCY = 16;
/** Largest payload one SFTP WRITE may carry, for the same reason as reads. */
const SFTP_WRITE_CHUNK = 128 * 1024;
/** WRITEs in flight at once. */
const SFTP_WRITE_CONCURRENCY = 16;

export class SSHHostDriver implements IHostDriver {
  readonly deviceId: string;
  private client: Client;
  private sftpInstance: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  private alive: boolean = true;
  /**
   * Commands run over long-lived `sh` channels instead of `client.exec()`.
   * On a 257 ms link a fresh channel costs ~900 ms against ~280 ms for a
   * command written to a shell that is already open.
   */
  private shellPool: PersistentShellPool | null = null;

  constructor(deviceId: string, client: Client) {
    this.deviceId = deviceId;
    this.client = client;

    client.on('end', () => {
      this.alive = false;
      this.sftpInstance = null;
      this.shellPool?.dispose();
      this.shellPool = null;
    });
    client.on('close', () => {
      this.alive = false;
      this.sftpInstance = null;
      this.shellPool?.dispose();
      this.shellPool = null;
    });
    client.on('error', () => {
      this.alive = false;
      this.shellPool?.dispose();
      this.shellPool = null;
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  /**
   * Open the command channel and the SFTP channel ahead of the first request.
   *
   * Both cost a full round trip to open, and every route needs at least one of
   * them, so paying during connection setup keeps that latency off the first
   * page a user sees. Failures are ignored: each path still opens on demand.
   */
  async warmUp(): Promise<void> {
    if (!this.alive) return;
    await Promise.allSettled([
      this.getShellPool().ready(),
      this.getSFTP().then(() => undefined),
    ]);
  }

  private getShellPool(): PersistentShellPool {
    if (!this.shellPool) {
      this.shellPool = new PersistentShellPool(this.client, this.deviceId);
    }
    return this.shellPool;
  }

  private async getSFTP(): Promise<SFTPWrapper> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);
    if (this.sftpInstance) return this.sftpInstance;
    if (this.sftpPromise) return this.sftpPromise;

    this.sftpPromise = withChannelRetry(() => new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err: any, sftp: SFTPWrapper) => {
        if (err) return reject(err);
        sftp.on('end', () => { this.sftpInstance = null; });
        sftp.on('close', () => { this.sftpInstance = null; });
        resolve(sftp);
      });
    })).then((sftp) => {
      this.sftpPromise = null;
      this.sftpInstance = sftp;
      return sftp;
    }, (error: Error) => {
      this.sftpPromise = null;
      throw error;
    });

    return this.sftpPromise;
  }

  async createTerminal(opts: TerminalOptions = {}): Promise<TerminalSession> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);

    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const sessionId = randomUUID();

    return withChannelRetry(() => new Promise<TerminalSession>((resolve, reject) => {
      const ptyOptions = {
        term: 'xterm-256color',
        cols,
        rows,
      };

      const handleStream = (stream: ClientChannel) => {
        const dataListeners = new Set<(data: Buffer) => void>();
        const exitListeners = new Set<(code: number) => void>();

        stream.on('data', (chunk: Buffer) => {
          for (const listener of dataListeners) {
            listener(chunk);
          }
        });

        stream.on('close', (code: number) => {
          for (const listener of exitListeners) {
            listener(code ?? 0);
          }
        });

        const session: TerminalSession = {
          sessionId,
          write: (data: string | Buffer) => {
            if (!stream.destroyed) {
              stream.write(data);
            }
          },
          resize: (newCols: number, newRows: number) => {
            if (!stream.destroyed && (stream as any).setWindow) {
              (stream as any).setWindow(newRows, newCols, 0, 0);
            }
          },
          onData: (cb) => {
            dataListeners.add(cb);
            return () => dataListeners.delete(cb);
          },
          onExit: (cb) => {
            exitListeners.add(cb);
            return () => exitListeners.delete(cb);
          },
          close: () => {
            if (!stream.destroyed) {
              stream.close();
            }
          },
        };

        resolve(session);
      };

      if (opts.initialCmd) {
        this.client.exec(opts.initialCmd, { pty: ptyOptions, env: opts.env as any }, (err: any, stream: ClientChannel) => {
          if (err) return reject(err);
          handleStream(stream);
        });
      } else {
        this.client.shell(ptyOptions, (err: any, stream: ClientChannel) => {
          if (err) return reject(err);
          if (opts.cwd && opts.cwd !== "~" && opts.cwd !== "") {
            if (opts.cwd.startsWith("~/")) {
              stream.write(`cd ~/"${opts.cwd.slice(2).replace(/"/g, '\\"')}"\n`);
            } else {
              stream.write(`cd "${opts.cwd.replace(/"/g, '\\"')}"\n`);
            }
          }
          handleStream(stream);
        });
      }
    }));
  }

  private normalizeRemotePath(p: string): string {
    if (!p || p === '.' || p === '~' || p === '/~') return '.';
    if (p.startsWith('/~/')) return p.slice(3);
    if (p.startsWith('~/')) return p.slice(2);
    if (/^[a-zA-Z]:/.test(p)) return '.';
    return p;
  }

  async readDir(dirPath: string): Promise<FileEntry[]> {
    const sftp = await this.getSFTP();
    const normalized = this.normalizeRemotePath(dirPath);
    return new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(normalized, (err, list) => {
        if (err) return reject(err);
        const entries: FileEntry[] = list.map((item) => {
          const isDir = Boolean((item.attrs.mode & 0o170000) === 0o040000);
          const fullPath = normalized === '.'
            ? `/${item.filename}`
            : (normalized.endsWith('/') ? `${normalized}${item.filename}` : `${normalized}/${item.filename}`);
          return {
            name: item.filename,
            path: fullPath,
            isDirectory: isDir,
            size: item.attrs.size,
            mtime: item.attrs.mtime * 1000,
          };
        });
        resolve(entries);
      });
    });
  }

  /**
   * A whole file over SFTP, read in parallel windows.
   *
   * `sftp.createReadStream` issues one READ and waits for its reply before the
   * next, so a file costs one round trip per 64 KiB chunk: measured on a
   * 282 ms-RTT link, a 1 MiB file took 8133 ms that way. Sending several READs
   * at once — the protocol allows it — brings the same file down in 3042 ms,
   * and 4 MiB in 3579 ms against 46366 ms.
   *
   * Chunk size is 128 KiB because that is the largest payload an SFTP READ may
   * carry (the packet limit is 256 KiB minus headers), and 16 in flight is
   * enough to keep the pipe busy without exceeding sshd's own request queue.
   */
  async readFile(filePath: string): Promise<Buffer> {
    const sftp = await this.getSFTP();
    const normalized = this.normalizeRemotePath(filePath);
    return readSftpFile(sftp, normalized);
  }

  /**
   * Write a whole file over SFTP, in parallel windows.
   *
   * `sftp.writeFile` keeps one WRITE in flight at a time (ssh2 still carries a
   * TODO for a concurrency setting), so a 1 MiB upload took 3711 ms on a
   * 282 ms-RTT link. Sending several WRITEs at once brings it to 1529 ms.
   *
   * The bytes land in the same positions either way, so the file is identical;
   * only the order in which the device receives them changes.
   */
  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const sftp = await this.getSFTP();
    const normalized = this.normalizeRemotePath(filePath);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    await writeSftpFile(sftp, normalized, buf);
  }

  async stat(targetPath: string): Promise<FileEntry> {
    const sftp = await this.getSFTP();
    const normalized = this.normalizeRemotePath(targetPath);
    return new Promise<FileEntry>((resolve, reject) => {
      sftp.stat(normalized, (err, stats) => {
        if (err) return reject(err);
        const isDir = Boolean((stats.mode & 0o170000) === 0o040000);
        const name = targetPath.split(/[/\\]/).filter(Boolean).pop() ?? '';
        resolve({
          name,
          path: targetPath,
          isDirectory: isDir,
          size: stats.size,
          mtime: stats.mtime * 1000,
        });
      });
    });
  }

  async exec(cmd: string, args: string[] = [], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<ExecResult> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);

    const command = [cmd, ...args.map(a => `"${a.replace(/"/g, '\\"')}"`)].join(' ');

    try {
      const result = await this.getShellPool().exec(command, {
        cwd: opts?.cwd,
        env: opts?.env,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return result;
    } catch (error) {
      // The shell channel can die (remote sshd restart, network blip). Fall back
      // to a one-shot channel so a single dead shell does not fail the caller.
      if (!this.alive) throw error;
      return this.execOneShot(command, opts);
    }
  }

  private execOneShot(
    fullCommand: string,
    opts?: { env?: Record<string, string> },
  ): Promise<ExecResult> {
    return withChannelRetry(() => new Promise<ExecResult>((resolve, reject) => {
      this.client.exec(fullCommand, { env: opts?.env as any }, (err: any, stream: ClientChannel) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf8');
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8');
        });

        stream.on('close', (code: number) => {
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
          });
        });
      });
    }));
  }

  async spawnPiRpc(opts: {
    cwd?: string;
    sessionDir?: string;
    resumeSession?: string;
    ephemeral?: boolean;
  } = {}): Promise<RPCChannel> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);

    // Remote sessions are PERSISTED by default: pi writes a transcript into
    // `--session-dir` (or its own default session dir when none is given), so
    // the session shows up in the remote catalogue and can be reopened later.
    // `--no-session` (in-memory) is only used when a caller explicitly asks
    // for an ephemeral run.
    const args = ['--mode', 'rpc'];
    if (opts.ephemeral === true) {
      args.push('--no-session');
    } else {
      if (opts.sessionDir) {
        args.push('--session-dir', `"${opts.sessionDir}"`);
      }
      if (opts.resumeSession) {
        args.push('--session', `"${opts.resumeSession}"`);
      }
    }

    // The same PATH a user-installed `pi` needs: sshd hands an `exec` request
    // to a non-interactive shell that reads no rc file, so `pi` is not on PATH
    // when it was installed under `$HOME/.local/node/bin`.
    let command = `${REMOTE_PATH_PREFIX} pi ${args.join(' ')}`;
    if (opts.cwd) {
      command = `cd "${opts.cwd.replace(/"/g, '\\"')}" && ${command}`;
    }

    return withChannelRetry(() => new Promise<RPCChannel>((resolve, reject) => {
      this.client.exec(command, (err: any, stream: ClientChannel) => {
        if (err) return reject(err);

        const msgListeners = new Set<(msg: any) => void>();
        const errListeners = new Set<(err: Error) => void>();
        const closeListeners = new Set<(code?: number) => void>();
        const pendingMessages: any[] = [];

        let buffer = '';

        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep trailing incomplete chunk

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (msgListeners.size === 0) {
                pendingMessages.push(parsed);
              } else {
                for (const listener of msgListeners) {
                  listener(parsed);
                }
              }
            } catch {
              // Non-JSON or stdout debug log line
            }
          }
        });

        stream.stderr.on('data', (chunk: Buffer) => {
          const errStr = chunk.toString('utf8');
          for (const listener of errListeners) {
            listener(new Error(errStr));
          }
        });

        stream.on('close', (code: number) => {
          for (const listener of closeListeners) {
            listener(code);
          }
        });

        const channel: RPCChannel = {
          send: (message: Record<string, any>) => {
            if (!stream.destroyed) {
              stream.write(JSON.stringify(message) + '\n');
            }
          },
          onMessage: (cb) => {
            msgListeners.add(cb);
            while (pendingMessages.length > 0) {
              cb(pendingMessages.shift());
            }
            return () => msgListeners.delete(cb);
          },
          onError: (cb) => {
            errListeners.add(cb);
            return () => errListeners.delete(cb);
          },
          onClose: (cb) => {
            closeListeners.add(cb);
            return () => closeListeners.delete(cb);
          },
          abort: () => {
            if (!stream.destroyed) {
              stream.write(JSON.stringify({ type: 'abort' }) + '\n');
            }
          },
          close: () => {
            if (!stream.destroyed) {
              try {
                stream.write(JSON.stringify({ type: 'exit' }) + '\n');
              } catch {}
              stream.end();
              stream.close();
              stream.destroy();
            }
          },
        };

        resolve(channel);
      });
    }));
  }

  async close(): Promise<void> {
    this.alive = false;
    this.shellPool?.dispose();
    this.shellPool = null;
    if (this.sftpInstance) {
      try { this.sftpInstance.end(); } catch {}
      this.sftpInstance = null;
    }
    try {
      this.client.end();
    } catch {}
  }
}

/**
 * Read a whole file, with several SFTP READs in flight.
 *
 * `sftp.createReadStream` issues one READ and waits for its reply before the
 * next, so a file costs one round trip per 64 KiB chunk: measured on a
 * 282 ms-RTT link, 1 MiB took 8133 ms that way. Sending the READs together —
 * the protocol allows it — brings the same file down in 3042 ms, and 4 MiB in
 * 3579 ms against 46366 ms.
 *
 * 128 KiB per READ is the largest payload a single SFTP packet may carry
 * (256 KiB limit minus headers); 16 in flight keeps a high-latency link busy
 * without flooding the device's request queue.
 */
export async function readSftpFile(
  sftp: SFTPWrapper,
  path: string,
  options: { chunkSize?: number; concurrency?: number } = {},
): Promise<Buffer> {
  const chunkSize = options.chunkSize ?? SFTP_READ_CHUNK;
  const concurrency = options.concurrency ?? SFTP_READ_CONCURRENCY;
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.open(path, 'r', (err, opened) => (err ? reject(err) : resolve(opened)));
  });
  try {
    const stats = await new Promise<{ size: number }>((resolve, reject) => {
      sftp.fstat(handle, (err, value) => (err ? reject(err) : resolve(value)));
    });
    const buffer = Buffer.alloc(stats.size);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const position = next;
        if (position >= stats.size) return;
        next += chunkSize;
        const length = Math.min(chunkSize, stats.size - position);
        await new Promise<void>((resolve, reject) => {
          sftp.read(handle, buffer, position, length, position, (err) => (err ? reject(err) : resolve()));
        });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return buffer;
  } finally {
    await new Promise<void>((resolve) => sftp.close(handle, () => resolve()));
  }
}

/**
 * Write a whole file, with several SFTP WRITEs in flight.
 *
 * `sftp.writeFile` keeps one WRITE in flight at a time (ssh2 still carries a
 * TODO for a concurrency setting), so a 1 MiB upload took 3711 ms on a
 * 282 ms-RTT link. Sending several at once brings it to 1529 ms. The bytes
 * land at the same offsets either way, so the file is identical — only the
 * order the device receives them in changes.
 */
export async function writeSftpFile(
  sftp: SFTPWrapper,
  path: string,
  data: Buffer,
  options: { chunkSize?: number; concurrency?: number } = {},
): Promise<void> {
  const chunkSize = options.chunkSize ?? SFTP_WRITE_CHUNK;
  const concurrency = options.concurrency ?? SFTP_WRITE_CONCURRENCY;
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.open(path, 'w', (err, opened) => (err ? reject(err) : resolve(opened)));
  });
  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const position = next;
        if (position >= data.length) return;
        next += chunkSize;
        const length = Math.min(chunkSize, data.length - position);
        await new Promise<void>((resolve, reject) => {
          sftp.write(handle, data, position, length, position, (err) => (err ? reject(err) : resolve()));
        });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    await new Promise<void>((resolve) => sftp.close(handle, () => resolve()));
  }
}
