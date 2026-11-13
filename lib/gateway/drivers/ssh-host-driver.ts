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
  private isWindowsTarget: boolean | null = null;
  private isCmdExeTarget: boolean | null = null;
  private targetProbePromise: Promise<boolean> | null = null;

  private inFlightExecs = 0;
  private execQueue: (() => void)[] = [];
  private static readonly MAX_CONCURRENT_EXECS = 4;

  private acquireExecSlot(): Promise<() => void> {
    return new Promise((resolve) => {
      const enter = () => {
        this.inFlightExecs += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.inFlightExecs -= 1;
          const next = this.execQueue.shift();
          if (next) next();
        };
        resolve(release);
      };

      if (this.inFlightExecs < SSHHostDriver.MAX_CONCURRENT_EXECS) {
        enter();
      } else {
        this.execQueue.push(enter);
      }
    });
  }

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
   * Probe whether the remote shell is native Windows cmd.exe (as opposed to POSIX bash/sh).
   * In cmd.exe, `uname` fails, so `uname -s 2>/dev/null || echo %OS%` yields `Windows_NT`.
   * On Linux, macOS, or Git Bash / MSYS2 / MINGW64 on Windows, `uname -s` succeeds and
   * yields e.g. `Linux`, `Darwin`, `MINGW64...`, `MSYS...`. Those targets use POSIX syntax!
   */
  private async isCmdExe(): Promise<boolean> {
    if (this.isCmdExeTarget !== null) return this.isCmdExeTarget;
    try {
      const res = await this.execOneShot('uname -s 2>/dev/null || echo %OS%');
      const out = (res.stdout || '').trim();
      const lower = out.toLowerCase();
      const isCmd = lower === 'windows_nt' || (lower.includes('windows_nt') && !lower.includes('mingw') && !lower.includes('msys') && !lower.includes('cygwin'));
      this.isCmdExeTarget = isCmd;
      this.isWindowsTarget = isCmd || lower.includes('mingw') || lower.includes('msys') || lower.includes('cygwin') || lower.includes('windows');
      return isCmd;
    } catch {
      return false;
    }
  }

  /**
   * Probe whether the remote device is Windows (e.g. MINGW, MSYS, Windows_NT).
   * On Windows OpenSSH, persistent non-interactive shells holding an open stdin
   * cause MSYS2 bash/sh to busy-spin on Win32 named pipes, consuming 100% CPU.
   * For Windows targets, persistent shell pools are disabled in favor of clean
   * one-shot execs.
   */
  private async isWindows(): Promise<boolean> {
    if (this.isWindowsTarget !== null) return this.isWindowsTarget;
    if (this.targetProbePromise) return this.targetProbePromise;

    this.targetProbePromise = (async () => {
      try {
        await this.isCmdExe();
        return this.isWindowsTarget ?? false;
      } catch {
        return false;
      } finally {
        this.targetProbePromise = null;
      }
    })();

    return this.targetProbePromise;
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
    const isWin = await this.isWindows();
    await Promise.allSettled([
      !isWin ? this.getShellPool().ready() : Promise.resolve(),
      this.getSFTP().then(() => undefined),
    ]);

    // Automatically ensure remote mesh extension and drain any offline outbox messages
    import("../mesh-provision").then(async ({ ensureRemoteMeshExtension, drainRemoteMeshOutbox }) => {
      try {
        await ensureRemoteMeshExtension(this);
        await drainRemoteMeshOutbox(this);
      } catch (err) {
        console.warn(`[SSHHostDriver] Mesh auto-provisioning or drain failed for ${this.deviceId}:`, err);
      }
    }).catch(() => {});
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
        sftp.on('error', (sftpErr: any) => {
          console.warn(`[SSHHostDriver:${this.deviceId}] SFTP stream error: ${sftpErr?.message || sftpErr}`);
          this.sftpInstance = null;
        });
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
    let currentStream: ClientChannel | null = null;
    let closed = false;

    const dataListeners = new Set<(data: Buffer) => void>();
    const exitListeners = new Set<(code: number) => void>();

    const openChannel = async (): Promise<ClientChannel> => {
      if (closed || !this.alive) throw new Error(`Device ${this.deviceId} is disconnected`);
      return withChannelRetry(() => new Promise<ClientChannel>((resolve, reject) => {
        const ptyOptions = {
          term: 'xterm-256color',
          cols,
          rows,
        };

        const attachListeners = (stream: ClientChannel) => {
          currentStream = stream;
          stream.on('data', (chunk: Buffer) => {
            for (const listener of dataListeners) {
              try { listener(chunk); } catch {}
            }
          });

          stream.on('close', (code: number) => {
            if (currentStream === stream) {
              currentStream = null;
            }
            if (!closed) {
              for (const listener of exitListeners) {
                try { listener(code ?? 0); } catch {}
              }
            }
          });

          stream.on('error', (err: any) => {
            console.warn(`[SSHHostDriver:${this.deviceId}] Terminal stream error: ${err?.message || err}`);
          });

          resolve(stream);
        };

        if (opts.initialCmd) {
          this.client.exec(opts.initialCmd, { pty: ptyOptions, env: opts.env as any }, (err: any, stream: ClientChannel) => {
            if (err) return reject(err);
            attachListeners(stream);
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
            attachListeners(stream);
          });
        }
      }), {
        onRetry: (_err, attempt) => {
          // On channel open failure, evict idle shells from the persistent pool to yield channels
          const evicted = this.shellPool?.evictIdleShells(1) ?? 0;
          if (evicted > 0) {
            console.info(`[SSHHostDriver:${this.deviceId}] Evicted ${evicted} idle shell(s) from pool to free channel for terminal (attempt ${attempt + 1})`);
          }
        },
      });
    };

    await openChannel();

    const session: TerminalSession = {
      sessionId,
      write: (data: string | Buffer) => {
        if (!closed && currentStream && !currentStream.destroyed) {
          try {
            currentStream.write(data);
          } catch {
            // Channel write failure
          }
        }
      },
      resize: (newCols: number, newRows: number) => {
        if (!closed && currentStream && !currentStream.destroyed && (currentStream as any).setWindow) {
          try {
            (currentStream as any).setWindow(newRows, newCols, 0, 0);
          } catch {}
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
        closed = true;
        if (currentStream && !currentStream.destroyed) {
          try {
            currentStream.write('\x03\x04exit\n');
          } catch {}
          try {
            currentStream.close();
            currentStream.destroy();
          } catch {}
        }
        currentStream = null;
        dataListeners.clear();
        exitListeners.clear();
      },
      isAlive: () => {
        return !closed && !!currentStream && !currentStream.destroyed;
      },
      reconnect: async () => {
        if (closed) return false;
        try {
          if (currentStream && !currentStream.destroyed) {
            try { currentStream.destroy(); } catch {}
          }
          await openChannel();
          return true;
        } catch {
          return false;
        }
      },
    };

    return session;
  }

  private normalizeRemotePath(p: string): string {
    if (!p || p === '.' || p === '~' || p === '/~') return '.';
    if (p.startsWith('/~/')) return p.slice(3);
    if (p.startsWith('~/')) return p.slice(2);
    // On Windows SFTP servers, absolute paths look like "C:/path" or "C:\path".
    // Do NOT truncate them to "."! Convert backslashes to forward slashes.
    if (/^[a-zA-Z]:[\\/]/.test(p)) return p.replace(/\\/g, '/');
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
          let fullPath = normalized === '.'
            ? `/${item.filename}`
            : (normalized.endsWith('/') ? `${normalized}${item.filename}` : `${normalized}/${item.filename}`);
          // If normalized started with Windows drive (e.g. C:/...), don't add leading slash
          if (/^[a-zA-Z]:/.test(normalized) && fullPath.startsWith('/')) {
            fullPath = fullPath.slice(1);
          }
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

  async unlink(filePath: string): Promise<void> {
    const sftp = await this.getSFTP();
    const normalized = this.normalizeRemotePath(filePath);
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(normalized, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async exec(cmd: string, args: string[] = [], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<ExecResult> {
    if (!this.alive) throw new Error(`Device ${this.deviceId} is not connected`);

    const command = [cmd, ...args.map(a => `"${a.replace(/"/g, '\\"')}"`)].join(' ');

    const isCmd = await this.isCmdExe();
    if (isCmd) {
      const winCwd = opts?.cwd ? opts.cwd.replace(/\//g, '\\') : '';
      return this.execOneShot(winCwd ? `cd /d "${winCwd.replace(/"/g, '""')}" & ${command}` : command, opts);
    }

    const isWin = await this.isWindows();
    if (isWin) {
      // Windows targets running Git Bash / MSYS2 must avoid persistent shell pool pipe spinning, but use POSIX shell syntax
      const normalizedCwd = opts?.cwd ? opts.cwd.replace(/\\/g, '/') : '';
      return this.execOneShot(normalizedCwd ? `cd "${normalizedCwd.replace(/"/g, '\\"')}" && ${command}` : command, opts);
    }

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
      return this.execOneShot(opts?.cwd ? `cd "${opts.cwd.replace(/"/g, '\\"')}" && ${command}` : command, opts);
    }
  }

  private async execOneShot(
    fullCommand: string,
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const release = await this.acquireExecSlot();
    try {
      return await withChannelRetry(() => new Promise<ExecResult>((resolve, reject) => {
        this.client.exec(fullCommand, { env: opts?.env as any }, (err: any, stream: ClientChannel) => {
          if (err) return reject(err);

          let stdout = '';
          let stderr = '';
          let settled = false;

          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              try { stream.destroy(); } catch {}
              reject(new Error(`execOneShot timed out after ${timeoutMs}ms: ${fullCommand.slice(0, 80)}`));
            }
          }, timeoutMs);
          timer.unref?.();

          stream.on('data', (data: Buffer) => {
            stdout += data.toString('utf8');
          });
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString('utf8');
          });

          stream.on('error', (streamErr: Error) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(streamErr);
            }
          });

          stream.on('close', (code: number) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({
                stdout,
                stderr,
                exitCode: code ?? 0,
              });
            }
          });

          // Close stdin immediately so remote commands waiting for EOF don't hang
          try { stream.end(); } catch {}
        });
      }), {
        attempts: 5,
        baseDelayMs: 200,
        onRetry: (_err, attempt) => {
          const evicted = this.shellPool?.evictIdleShells(1) ?? 0;
          if (evicted > 0) {
            console.info(`[SSHHostDriver:${this.deviceId}] Evicted ${evicted} idle shell(s) from pool to free channel for execOneShot (attempt ${attempt + 1})`);
          }
        },
      });
    } finally {
      release();
    }
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
        const normDir = opts.sessionDir.replace(/\\/g, '/');
        args.push('--session-dir', `"${normDir}"`);
      }
      if (opts.resumeSession) {
        const normSession = opts.resumeSession.replace(/\\/g, '/');
        args.push('--session', `"${normSession}"`);
      }
    }

    // Automatically ensure remote mesh extension is present and load it via -e
    // Always use absolute path ~/ so it is resolved against user's home directory,
    // not relative to cwd (which causes e.g. D:\proj\tmp\.pi\agent\... not found).
    args.push('-e', `~/.pi/agent/mesh-agent-extension.mjs`);

    // Explicitly inject device and session environment variables so mesh extension knows its identity
    const envVars: string[] = [`PI_WEB_DEVICE_ID="${this.deviceId}"`];
    try {
      const { getActiveMeshBridgePort } = await import("../mesh-reverse-bridge");
      const bridgePort = getActiveMeshBridgePort(this.deviceId);
      if (bridgePort) {
        envVars.push(`PI_MESH_BRIDGE_PORT="${bridgePort}"`);
      }
    } catch {}
    let candidateSessionId: string | undefined;
    if (opts.resumeSession) {
      const slashIdx = Math.max(opts.resumeSession.lastIndexOf("/"), opts.resumeSession.lastIndexOf("\\"));
      const base = slashIdx === -1 ? opts.resumeSession : opts.resumeSession.slice(slashIdx + 1);
      const clean = base.endsWith(".jsonl") ? base.slice(0, -6) : base;
      const underIdx = clean.lastIndexOf("_");
      candidateSessionId = underIdx === -1 ? clean : clean.slice(underIdx + 1);
    }
    if (candidateSessionId) {
      envVars.push(`PI_SESSION_ID="${candidateSessionId}"`);
    }
    // The same PATH a user-installed `pi` needs: sshd hands an `exec` request
    // to a non-interactive shell that reads no rc file, so `pi` is not on PATH
    // when it was installed under `$HOME/.local/node/bin`.
    const isCmd = await this.isCmdExe();
    let command: string;
    if (isCmd) {
      // Windows OpenSSH cmd.exe does not support POSIX `VAR=val cmd` syntax
      const envCmds = envVars.map(v => `set ${v}`).join(' & ');
      const baseCmd = `pi ${args.join(' ')}`;
      if (opts.cwd) {
        const winCwd = opts.cwd.replace(/\//g, '\\');
        command = `${envCmds} & cd /d "${winCwd.replace(/"/g, '""')}" & ${baseCmd}`;
      } else {
        command = `${envCmds} & ${baseCmd}`;
      }
    } else {
      const envPrefix = envVars.join(" ");
      command = `${envPrefix} ${REMOTE_PATH_PREFIX} pi ${args.join(' ')}`;
      if (opts.cwd) {
        // Normalize backslashes to forward slashes to prevent shell escape stripping (e.g. D:\proj\helper -> D:projhelper)
        const normalizedCwd = opts.cwd.replace(/\\/g, '/');
        command = `cd "${normalizedCwd.replace(/"/g, '\\"')}" && ${command}`;
      }
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

        let errBuffer = '';
        stream.stderr.on('data', (chunk: Buffer) => {
          errBuffer += chunk.toString('utf8');
          const lines = errBuffer.split('\n');
          errBuffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              // If it's a mesh_outbound frame sent over stderr or stdout, deliver to msgListeners!
              const isMesh = parsed?.type === 'mesh_outbound' || (parsed?.data && parsed.data.type === 'mesh_outbound');
              if (isMesh) {
                for (const listener of msgListeners) {
                  listener(parsed);
                }
                continue;
              }
            } catch {
              // Not JSON, normal stderr
            }
            for (const listener of errListeners) {
              listener(new Error(trimmed));
            }
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
    }), {
      onRetry: (_err, attempt) => {
        const evicted = this.shellPool?.evictIdleShells(1) ?? 0;
        if (evicted > 0) {
          console.info(`[SSHHostDriver:${this.deviceId}] Evicted ${evicted} idle shell(s) from pool to free channel for RPC (attempt ${attempt + 1})`);
        }
      },
    });
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
  let abortError: any = null;
  try {
    const stats = await new Promise<{ size: number }>((resolve, reject) => {
      sftp.fstat(handle, (err, value) => (err ? reject(err) : resolve(value)));
    });
    const buffer = Buffer.alloc(stats.size);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (abortError) return;
        const position = next;
        if (position >= stats.size) return;
        next += chunkSize;
        const length = Math.min(chunkSize, stats.size - position);
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.read(handle, buffer, position, length, position, (err) => (err ? reject(err) : resolve()));
          });
        } catch (err) {
          abortError = err;
          throw err;
        }
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
  let abortError: any = null;
  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (abortError) return;
        const position = next;
        if (position >= data.length) return;
        next += chunkSize;
        const length = Math.min(chunkSize, data.length - position);
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.write(handle, data, position, length, position, (err) => (err ? reject(err) : resolve()));
          });
        } catch (err) {
          abortError = err;
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    await new Promise<void>((resolve) => sftp.close(handle, () => resolve()));
  }
}
