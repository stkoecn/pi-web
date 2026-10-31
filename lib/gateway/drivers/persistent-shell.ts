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
import { withChannelRetry } from './channel-retry';

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

/**
 * Directories a user-installed tool can live in, ahead of the default PATH.
 *
 * sshd runs an `exec` request through `$SHELL -c`, and a non-interactive `sh`
 * reads no rc file, so the PATH is the bare system one: a `pi` installed by
 * `npm install -g` under `$HOME/.local/node` is simply not found, and every
 * command fails with `pi: command not found`. Prepending the usual per-user
 * bin directories makes a user-level install work without root.
 *
 * `$HOME` rather than `~`: tilde expands only when unquoted and never inside
 * double quotes, so `PATH="...:~/bin"` silently adds a literal `~/bin`.
 */
export const REMOTE_PATH_PREFIX =
  'PATH="$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:$HOME/.local/node/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/scoop/apps/nodejs-lts/current/bin:$HOME/scoop/shims:$PATH"';

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
    // Retry inside `open()` so a refused channel (sshd's MaxSessions budget is
    // shared with SFTP, terminals and the `pi --mode rpc` channels) does not
    // mark this shell dead and drop it from the pool it is still serving.
    this.opening = withChannelRetry(() => new Promise<ClientChannel>((resolve, reject) => {
      // `sh` rather than a login shell: no rc files, no prompt, no echo, and
      // nothing between us and the command.
      this.client.exec(`${REMOTE_PATH_PREFIX} exec sh`, (err: Error | undefined, stream: ClientChannel) => {
        if (err) return reject(err);
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
    }))
      .finally(() => { this.opening = null; })
      .catch((error: Error) => {
        this.markDead();
        throw error;
      });
    return this.opening;
  }

  /**
   * Open the channel now instead of on the first command.
   *
   * Opening costs a full round trip — measured 2089 ms on a 282 ms-RTT link —
   * and every page load issues a command within milliseconds of connecting.
   * Paying it during connection setup keeps it off the first request.
   */
  async warm(): Promise<void> {
    await this.open();
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
        this.dead = true; // Mark dead immediately so it cannot be acquired again
        this.pending = null;
        reject(new Error(`Remote command timed out after ${timeoutMs}ms: ${command.slice(0, 120)}`));
        // The shell may still be running the command; its output would be
        // attributed to the next one, so throw the channel away.
        this.dispose();
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
    // eight.
    //
    // sshd's default `MaxSessions 10` is a budget for the WHOLE connection, and
    // this pool is not its only consumer: one SFTP channel stays open for the
    // connection's lifetime, and every open remote session holds an `exec`
    // channel for its `pi --mode rpc` process. So the pool must leave room.
    //
    // Six rather than four: measured on the same 282 ms-RTT VPS, eight
    // concurrent commands took 1451 ms on four channels and 871 ms on six, and
    // twelve took 1870 ms against 897 ms. Eight channels were no better than
    // six at those widths (1134 / 620 ms) and cost two more of the ten slots,
    // which is the trade the earlier comment was right to worry about: a
    // refused channel is now retried rather than failing the request, but a
    // retry is still a round trip. Six leaves four slots for SFTP plus three
    // open sessions, and one spare.
    private readonly size = 6,
  ) {
    // Open the first channel immediately rather than on the first command: a
    // channel open costs a full round trip (250 ms on a WAN device) and the
    // first request after a page load always needs one.
    this.warmUp = this.acquire()
      .then(async (shell) => {
        // `acquire()` only builds the wrapper: without this the channel is
        // still opened by the first command, and `ready()` resolves in 0 ms
        // while that command pays the full round trip.
        try {
          await shell.warm();
        } finally {
          shell.busy = false;
          this.releaseWaiter();
        }
      })
      .then(() => {
        // One channel is not enough: a page load issues six commands at once
        // (session list, session detail, files, git status, settings, models),
        // and the five that find no free shell each pay their own channel open.
        // Measured on a 282 ms-RTT VPS, six concurrent commands after warming
        // one shell took 895 ms; after warming all six they took 329 ms.
        //
        // Deliberately not awaited: `ready()` gates the device being usable, and
        // the remaining opens should happen while the page is still loading, not
        // before it can talk to us. The steady state is the same either way —
        // the first burst of six commands grows the pool to six channels and
        // keeps them — so this only moves the cost off the user's request.
        void this.warmRemaining();
      })
      .catch(() => {
        // A device that is not ready yet simply opens its shell on demand.
      });
  }

  /** Open the rest of the pool in the background, once the first one is up. */
  private async warmRemaining(): Promise<void> {
    while (!this.disposed && this.shells.length < this.size) {
      let shell: PersistentShell;
      try {
        shell = await this.acquire();
      } catch {
        return;
      }
      void shell.warm().catch(() => {
        // A refused channel is retried by the next command; it does not make
        // the device unusable.
      }).finally(() => {
        shell.busy = false;
        this.releaseWaiter();
      });
    }
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
