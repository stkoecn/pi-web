import type { IHostDriver, TerminalOptions, TerminalSession, FileEntry, ExecResult, RPCChannel } from '../../types/host-driver';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class LocalHostDriver implements IHostDriver {
  readonly deviceId: string = 'localhost';
  private alive: boolean = true;

  isAlive(): boolean {
    return this.alive;
  }

  async createTerminal(opts: TerminalOptions = {}): Promise<TerminalSession> {
    const sessionId = randomUUID();
    const isWin = process.platform === 'win32';
    const shell = opts.initialCmd
      ? (isWin ? 'cmd.exe' : '/bin/sh')
      : (process.env.SHELL || (isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'));

    const args = opts.initialCmd
      ? (isWin ? ['/c', opts.initialCmd] : ['-c', opts.initialCmd])
      : [];

    const proc = spawn(shell, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...opts.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: !opts.initialCmd && isWin,
    });

    const dataListeners = new Set<(data: Buffer) => void>();
    const exitListeners = new Set<(code: number) => void>();

    proc.stdout.on('data', (d: Buffer) => {
      for (const l of dataListeners) l(d);
    });
    proc.stderr.on('data', (d: Buffer) => {
      for (const l of dataListeners) l(d);
    });
    proc.on('close', (code: number) => {
      for (const l of exitListeners) l(code ?? 0);
    });

    return {
      sessionId,
      write: (data: string | Buffer) => {
        if (!proc.stdin.destroyed) {
          proc.stdin.write(data);
        }
      },
      resize: () => {},
      onData: (cb) => {
        dataListeners.add(cb);
        return () => dataListeners.delete(cb);
      },
      onExit: (cb) => {
        exitListeners.add(cb);
        return () => exitListeners.delete(cb);
      },
      close: () => {
        proc.kill();
      },
    };
  }

  async readDir(dirPath: string): Promise<FileEntry[]> {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      const full = path.join(dirPath, d.name);
      try {
        const s = await fs.stat(full);
        entries.push({
          name: d.name,
          path: full.replace(/\\/g, '/'),
          isDirectory: d.isDirectory(),
          size: s.size,
          mtime: s.mtimeMs,
        });
      } catch {
        entries.push({
          name: d.name,
          path: full.replace(/\\/g, '/'),
          isDirectory: d.isDirectory(),
          size: 0,
          mtime: 0,
        });
      }
    }
    return entries;
  }

  async readFile(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    await fs.writeFile(filePath, content);
  }

  async stat(targetPath: string): Promise<FileEntry> {
    const s = await fs.stat(targetPath);
    return {
      name: path.basename(targetPath),
      path: targetPath.replace(/\\/g, '/'),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtimeMs,
    };
  }

  async exec(cmd: string, args: string[] = [], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: opts?.cwd || process.cwd(),
        env: { ...process.env, ...opts?.env },
        shell: process.platform === 'win32',
      });
      return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ? err.stdout.toString() : '',
        stderr: err.stderr ? err.stderr.toString() : (err.message || String(err)),
        exitCode: err.code ?? 1,
      };
    }
  }

  async spawnPiRpc(opts: { cwd?: string; sessionDir?: string; resumeSession?: string } = {}): Promise<RPCChannel> {
    const args = ['--mode', 'rpc'];
    if (opts.sessionDir) args.push('--session-dir', opts.sessionDir);
    if (opts.resumeSession) args.push('--session', opts.resumeSession);
    else args.push('--no-session');

    const proc = spawn('pi', args, {
      cwd: opts.cwd || process.cwd(),
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const msgListeners = new Set<(msg: any) => void>();
    const errListeners = new Set<(err: Error) => void>();
    const closeListeners = new Set<(code?: number) => void>();

    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          for (const l of msgListeners) l(parsed);
        } catch {}
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const errStr = chunk.toString('utf8');
      for (const l of errListeners) l(new Error(errStr));
    });

    proc.on('close', (code: number) => {
      for (const l of closeListeners) l(code);
    });

    return {
      send: (msg) => {
        if (!proc.stdin.destroyed) {
          proc.stdin.write(JSON.stringify(msg) + '\n');
        }
      },
      onMessage: (cb) => {
        msgListeners.add(cb);
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
        if (!proc.stdin.destroyed) {
          proc.stdin.write(JSON.stringify({ type: 'abort' }) + '\n');
        }
      },
      close: () => {
        proc.kill();
      },
    };
  }

  async close(): Promise<void> {
    this.alive = false;
  }
}
