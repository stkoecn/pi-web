/**
 * Persistent `sh` channels for a single SSH connection.
 *
 * Why this exists: `client.exec()` opens a fresh SSH channel per call, and on a
 * high-latency link that costs far more than the command itself. Measured
 * against a US VPS (257 ms ICMP RTT):
 *
 *   client.exec("echo hi")            ~900 ms
 *   command written to a live `sh`    ~280 ms
 *
 * So every command pays a channel setup and teardown it does not need. This
 * pool keeps a few `sh` processes alive and multiplexes commands onto them.
 *
 * Framing: each command redirects its output to temp files, prints a header
 * line with the exit code and the exact byte counts, then dumps the files. The
 * reader trusts those counts instead of scanning for a sentinel, so command
 * output can contain anything at all — including the header marker.
 */

import type { Client, ClientChannel } from 'ssh2';
import { randomBytes } from 'node:crypto';

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Give up (and recycle the shell) after this long. */
  timeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** A command that runs this long leaves the channel in an unknown state. */
const RECYCLE_AFTER_TIMEOUT_MS = 100;

interface PendingCommand {
  nonce: string;
  resolve: (result: ShellExecResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class PersistentShell {
  private channel: ClientChannel | null = null;
  private opening: Promise<ClientChannel> | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: PendingCommand | null = null;
  private dead = false;
  busy = false;

  constructor(
    private readonly client: Client,
    private readonly label: string,
    private readonly onDead: () => void,
  ) {}

  isUsable(): boolean {
    return !this.dead && this.channel !== null;
  }

  private open(): Promise<ClientChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    if (this.opening) return this.opening;
    this.opening = new Promise<ClientChannel>((resolve, reject) => {
      // `sh` rather than a login shell: no rc files, no prompt, no echo, and
      // nothing between us and the command.
      this.client.exec('sh', (err: Error | undefined, stream: ClientChannel) => {
        this.opening = null;
        if (err) {
          this.markDead();
          return reject(err);
        }
        stream.on('data', (data: Buffer) => this.onData(data));
        stream.stderr.on('data', () => {
          // stderr of the `sh` process itself (not of our commands, which are
          // redirected to files) means the channel is broken.
        });
        stream.on('close', () => {
          this.channel = null;
          this.markDead();
        });
        stream.on('error', () => {
          this.channel = null;
          this.markDead();
        });
        this.channel = stream;
        this.buffer = Buffer.alloc(0);
        resolve(stream);
      });
    });
    return this.opening;
  }

  private markDead() {
    this.dead = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`SSH shell channel closed (${this.label})`));
    }
    this.onDead();
  }

  private onData(data: Buffer) {
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    this.drain();
  }

  private drain() {
    const pending = this.pending;
    if (!pending) {
      // Nothing is waiting: drop noise (a shell can print a startup banner).
      if (this.buffer.length > 64 * 1024) this.buffer = this.buffer.subarray(-4096);
      return;
    }

    const marker = Buffer.from(`\u0001${pending.nonce} `, 'utf8');
    const markerAt = this.buffer.indexOf(marker);
    if (markerAt === -1) {
      if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.subarray(-4096);
      return;
    }
    const newlineAt = this.buffer.indexOf(0x0a, markerAt);
    if (newlineAt === -1) return;

    const header = this.buffer.subarray(markerAt + marker.length, newlineAt).toString('utf8');
    const [rcRaw, errLenRaw, outLenRaw] = header.trim().split(/\s+/);
    const exitCode = Number.parseInt(rcRaw ?? '0', 10);
    const errLen = Number.parseInt(errLenRaw ?? '0', 10);
    const outLen = Number.parseInt(outLenRaw ?? '0', 10);
    if (!Number.isFinite(errLen) || !Number.isFinite(outLen)) return;

    const bodyStart = newlineAt + 1;
    const bodyEnd = bodyStart + errLen + outLen;
    if (this.buffer.length < bodyEnd) return;

    const stderr = this.buffer.subarray(bodyStart, bodyStart + errLen).toString('utf8');
    const stdout = this.buffer.subarray(bodyStart + errLen, bodyEnd).toString('utf8');
    this.buffer = this.buffer.subarray(bodyEnd);

    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve({
      stdout,
      stderr,
      exitCode: Number.isFinite(exitCode) ? exitCode : 0,
    });
    this.drain();
  }

  async run(command: string, opts: ShellExecOptions = {}): Promise<ShellExecResult> {
    const channel = await this.open();
    if (this.pending) throw new Error(`SSH shell already busy (${this.label})`);

    const nonce = randomBytes(8).toString('hex');
    const outFile = `/tmp/.piweb-${nonce}.out`;
    const errFile = `/tmp/.piweb-${nonce}.err`;
    let script = command;
    if (opts.cwd) script = `cd "${opts.cwd.replace(/"/g, '\\"')}" && { ${script} ; }`;
    if (opts.env) {
      const assignments = Object.entries(opts.env)
        .map(([key, value]) => `${key}='${String(value).replace(/'/g, `'\\''`)}'`)
        .join(' ');
      if (assignments) script = `${assignments} ${script}`;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise<ShellExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.nonce !== nonce) return;
        this.pending = null;
        reject(new Error(`Remote command timed out after ${timeoutMs}ms: ${command.slice(0, 120)}`));
        // The shell may still be running the command; its output would be
        // attributed to the next one, so throw the channel away.
        setTimeout(() => this.dispose(), RECYCLE_AFTER_TIMEOUT_MS);
      }, timeoutMs);
      timer.unref?.();

      this.pending = { nonce, resolve, reject, timer };

      const line = `( ${script} ) >${outFile} 2>${errFile}; __piweb_rc=$?; `
        + `printf '\\001${nonce} %s %s %s\\n' "$__piweb_rc" "$(wc -c <${errFile})" "$(wc -c <${outFile})"; `
        + `cat ${errFile} ${outFile}; rm -f ${errFile} ${outFile}\n`;
      channel.write(line);
    });
  }

  dispose() {
    this.dead = true;
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      try { channel.end(); } catch { /* already gone */ }
      try { channel.close(); } catch { /* already gone */ }
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`SSH shell disposed (${this.label})`));
    }
  }
}

/**
 * A small pool of persistent shells. Concurrency beyond the pool size queues
 * rather than opening new channels — a new channel costs ~3x a command.
 */
export class PersistentShellPool {
  private readonly shells: PersistentShell[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private disposed = false;
  private warmUp: Promise<void> | null = null;

  constructor(
    private readonly client: Client,
    private readonly label: string,
    // A page load fans out to about a dozen gateway requests at once (device
    // list, session list, detail, files, git status, settings), and each needs
    // one command. With three channels they queue: measured on a 257 ms-RTT
    // VPS, 24 concurrent commands took 2416 ms on three channels and 956 ms on
    // eight. sshd's default MaxSessions is 10, so eight is still safely inside
    // it (a sixteenth channel fails to open).
    private readonly size = 8,
  ) {
    // Open the first channel immediately rather than on the first command: a
    // channel open costs a full round trip (250 ms on a WAN device) and the
    // first request after a page load always needs one.
    this.warmUp = this.acquire()
      .then((shell) => {
        shell.busy = false;
        this.releaseWaiter();
      })
      .catch(() => {
        // A device that is not ready yet simply opens its shell on demand.
      });
  }

  /** Resolves once the first shell channel has been opened (or failed). */
  async ready(): Promise<void> {
    await this.warmUp;
  }

  private async acquire(): Promise<PersistentShell> {
    for (;;) {
      if (this.disposed) throw new Error(`SSH shell pool disposed (${this.label})`);
      for (const shell of this.shells) {
        if (!shell.busy && shell.isUsable()) {
          shell.busy = true;
          return shell;
        }
      }
      if (this.shells.length < this.size) {
        let shell: PersistentShell | null = null;
        shell = new PersistentShell(this.client, this.label, () => {
          const index = this.shells.indexOf(shell!);
          if (index !== -1) this.shells.splice(index, 1);
          this.releaseWaiter();
        });
        shell.busy = true;
        this.shells.push(shell);
        return shell;
      }
      // All busy: wait for a release, then look again.
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  private releaseWaiter() {
    const waiter = this.idleWaiters.shift();
    if (waiter) waiter();
  }

  async exec(command: string, opts: ShellExecOptions = {}): Promise<ShellExecResult> {
    const shell = await this.acquire();
    try {
      return await shell.run(command, opts);
    } finally {
      shell.busy = false;
      this.releaseWaiter();
    }
  }

  dispose() {
    this.disposed = true;
    for (const shell of this.shells) shell.dispose();
    this.shells.length = 0;
    while (this.idleWaiters.length > 0) {
      const waiter = this.idleWaiters.shift();
      if (waiter) waiter();
    }
  }
}
