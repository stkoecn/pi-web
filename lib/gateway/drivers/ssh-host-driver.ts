import ssh2 from 'ssh2';
import type { Client, SFTPWrapper, ClientChannel } from 'ssh2';
import type { IHostDriver, TerminalOptions, TerminalSession, FileEntry, ExecResult, RPCChannel } from '../types/host-driver';
import { randomUUID } from 'node:crypto';

export class SSHHostDriver implements IHostDriver {
  readonly deviceId: string;
  private client: Client;
  private sftpInstance: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  private alive: boolean = true;

  constructor(deviceId: string, client: Client) {
    this.deviceId = deviceId;
    this.client = client;

    client.on('end', () => {
      this.alive = false;
      this.sftpInstance = null;
    });
    client.on('close', () => {
      this.alive = false;
      this.sftpInstance = null;
    });
    client.on('error', () => {
      this.alive = false;
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  private async getSFTP(): Promise<SFTPWrapper> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);
    if (this.sftpInstance) return this.sftpInstance;
    if (this.sftpPromise) return this.sftpPromise;

    this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err: any, sftp: SFTPWrapper) => {
        this.sftpPromise = null;
        if (err) return reject(err);
        this.sftpInstance = sftp;
        sftp.on('end', () => { this.sftpInstance = null; });
        sftp.on('close', () => { this.sftpInstance = null; });
        resolve(sftp);
      });
    });

    return this.sftpPromise;
  }

  async createTerminal(opts: TerminalOptions = {}): Promise<TerminalSession> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);

    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const sessionId = randomUUID();

    return new Promise<TerminalSession>((resolve, reject) => {
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
    });
  }

  async readDir(dirPath: string): Promise<FileEntry[]> {
    const sftp = await this.getSFTP();
    return new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err);
        const entries: FileEntry[] = list.map((item) => {
          const isDir = Boolean((item.attrs.mode & 0o170000) === 0o040000);
          const fullPath = dirPath.endsWith('/') || dirPath.endsWith('\\')
            ? `${dirPath}${item.filename}`
            : `${dirPath}/${item.filename}`;
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

  async readFile(filePath: string): Promise<Buffer> {
    const sftp = await this.getSFTP();
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const readStream = sftp.createReadStream(filePath);
      readStream.on('data', (d: Buffer) => chunks.push(d));
      readStream.on('error', reject);
      readStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const sftp = await this.getSFTP();
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return new Promise<void>((resolve, reject) => {
      sftp.writeFile(filePath, buf, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async stat(targetPath: string): Promise<FileEntry> {
    const sftp = await this.getSFTP();
    return new Promise<FileEntry>((resolve, reject) => {
      sftp.stat(targetPath, (err, stats) => {
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

  async exec(cmd: string, args: string[] = [], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);

    let fullCommand = [cmd, ...args.map(a => `"${a.replace(/"/g, '\\"')}"`)].join(' ');
    if (opts?.cwd) {
      fullCommand = `cd "${opts.cwd.replace(/"/g, '\\"')}" && ${fullCommand}`;
    }

    return new Promise<ExecResult>((resolve, reject) => {
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
    });
  }

  async spawnPiRpc(opts: { cwd?: string; sessionDir?: string; resumeSession?: string } = {}): Promise<RPCChannel> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);

    const args = ['--mode', 'rpc'];
    if (opts.sessionDir) {
      args.push('--session-dir', `"${opts.sessionDir}"`);
    }
    if (opts.resumeSession) {
      args.push('--session', `"${opts.resumeSession}"`);
    } else {
      args.push('--no-session');
    }

    let command = `pi ${args.join(' ')}`;
    if (opts.cwd) {
      command = `cd "${opts.cwd.replace(/"/g, '\\"')}" && ${command}`;
    }

    return new Promise<RPCChannel>((resolve, reject) => {
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
    });
  }

  async close(): Promise<void> {
    this.alive = false;
    if (this.sftpInstance) {
      try { this.sftpInstance.end(); } catch {}
      this.sftpInstance = null;
    }
    try {
      this.client.end();
    } catch {}
  }
}
