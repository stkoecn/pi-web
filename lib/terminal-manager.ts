import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import type { IPty } from "node-pty";
import { samePath } from "./paths";

export type TerminalEvent =
  | { type: "output"; data: string; offset: number; reset?: boolean }
  | { type: "exit"; exitCode: number }
  | { type: "closed" };

type TerminalListener = (event: TerminalEvent) => void;

export interface TerminalPtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface TerminalRecord {
  pty: TerminalPtyLike;
  cwd: string;
  deviceId?: string;
  listeners: Set<TerminalListener>;
  backlog: string;
  offset: number;
  exited: boolean;
  exitCode: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

declare global {
  var __piWebTerminals: Map<string, TerminalRecord> | undefined;
}

// ponytail: bounded replay; use terminal serialization if full-screen snapshots become necessary.
const MAX_BACKLOG = 128 * 1024;
export const TERMINAL_RECONNECT_MS = 120_000;

function registry(): Map<string, TerminalRecord> {
  if (!globalThis.__piWebTerminals) {
    globalThis.__piWebTerminals = new Map();
    const shutdown = () => {
      for (const id of globalThis.__piWebTerminals!.keys()) killTerminal(id, true);
    };
    process.once("exit", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piWebTerminals;
}

function shellEnvironment(): Record<string, string> {
  const isWin = platform() === "win32";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The browser login password guards this server, not the shells it starts.
    const comparableKey = isWin ? key.toUpperCase() : key;
    if (value !== undefined && comparableKey !== "PI_WEB_PASSWORD") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // Windows shells (Git Bash / MSYS2, cmd, PowerShell) otherwise inherit the
  // system ANSI codepage (e.g. GBK on zh-CN) and mangle non-ASCII filenames.
  if (!process.env.LANG && !process.env.LC_ALL && !process.env.LC_CTYPE) env.LANG = "C.UTF-8";
  return env;
}

function emit(record: TerminalRecord, event: TerminalEvent): void {
  for (const listener of record.listeners) listener(event);
}

function scheduleCleanup(id: string, record: TerminalRecord): void {
  if (record.cleanupTimer || record.listeners.size || registry().get(id) !== record) return;
  record.cleanupTimer = setTimeout(() => killTerminal(id), TERMINAL_RECONNECT_MS);
  record.cleanupTimer.unref?.();
}

function dimension(value: number, fallback: number): number {
  return Math.min(1000, Math.max(2, Number.isFinite(value) ? Math.floor(value) : fallback));
}

function resolveShellAndArgs(): { shell: string; args: string[] } {
  // Use platform() from "os" instead of process.platform so Next.js / Turbopack SWC
  // does not statically dead-code-eliminate or inline the build host's platform into the bundle.
  if (platform() === "win32") {
    return {
      shell: process.env.ComSpec ?? "cmd.exe",
      args: [],
    };
  }

  const envShell = process.env.SHELL;
  if (envShell && existsSync(envShell)) {
    const isBourneOnly = envShell.endsWith("/sh") || envShell.endsWith("/ash");
    return {
      shell: envShell,
      args: isBourneOnly ? [] : ["-l"],
    };
  }

  const candidates = [
    "/bin/bash",
    "/usr/bin/bash",
    "/usr/local/bin/bash",
    "/bin/zsh",
    "/usr/bin/zsh",
    "/bin/ash",
    "/bin/sh",
    "/usr/bin/sh",
  ];

  for (const cand of candidates) {
    if (existsSync(cand)) {
      const isBourneOnly = cand.endsWith("/sh") || cand.endsWith("/ash");
      return {
        shell: cand,
        args: isBourneOnly ? [] : ["-l"],
      };
    }
  }

  return {
    shell: "/bin/sh",
    args: [],
  };
}

export async function createTerminal(
  cwd: string,
  cols: number,
  rows: number,
  id: string = randomUUID(),
  deviceId?: string,
): Promise<string> {
  const existing = registry().get(id);
  if (existing) {
    if (existing.deviceId === deviceId && !samePath(existing.cwd, cwd)) {
      throw new Error("Terminal belongs to a different workspace");
    }
    return id;
  }

  // Handle remote device through Gateway driver
  if (deviceId && deviceId !== "localhost") {
    const { getGateway } = await import("./gateway/singleton");
    const driver = await getGateway().getOrConnectDriver(deviceId);
    const session = await driver.createTerminal({
      cwd,
      cols: dimension(cols, 80),
      rows: dimension(rows, 24),
    });

    const record: TerminalRecord = {
      pty: {
        write: (d: string) => session.write(d),
        resize: (c: number, r: number) => session.resize(c, r),
        kill: () => session.close(),
      },
      cwd,
      deviceId,
      listeners: new Set(),
      backlog: "",
      offset: 0,
      exited: false,
      exitCode: null,
      cleanupTimer: null,
    };
    registry().set(id, record);
    scheduleCleanup(id, record);

    session.onData((buf: Buffer) => {
      const data = buf.toString("utf-8");
      record.backlog = (record.backlog + data).slice(-MAX_BACKLOG);
      record.offset += data.length;
      emit(record, { type: "output", data, offset: record.offset });
    });

    session.onExit((exitCode: number) => {
      if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
      record.cleanupTimer = null;
      record.exited = true;
      record.exitCode = exitCode;
      emit(record, { type: "exit", exitCode });
      scheduleCleanup(id, record);
    });

    return id;
  }

  let spawn: typeof import("node-pty").spawn;
  try {
    // Load inside creation so native module failures reach the API's JSON error handler.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ spawn } = require("node-pty") as typeof import("node-pty"));
  } catch (error) {
    throw new Error(
      `Cannot load the node-pty native terminal module for ${process.platform}-${process.arch}. ` +
      "The binary may be missing or incompatible. In the pi-web installation directory " +
      "(the npx cache directory when using npx), run: npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts. " +
      "On Debian/Ubuntu, install build tools first: sudo apt-get install -y python3 build-essential. " +
      `Then restart pi-web. Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { shell, args } = resolveShellAndArgs();
  const pty = spawn(shell, args, {
    name: "xterm-256color",
    cols: dimension(cols, 80),
    rows: dimension(rows, 24),
    cwd: cwd || homedir(),
    env: shellEnvironment(),
  });
  const record: TerminalRecord = {
    pty,
    cwd,
    listeners: new Set(),
    backlog: "",
    offset: 0,
    exited: false,
    exitCode: null,
    cleanupTimer: null,
  };
  registry().set(id, record);
  // Includes creations whose response or initial SSE connection never arrives.
  scheduleCleanup(id, record);

  pty.onData((data) => {
    record.backlog = (record.backlog + data).slice(-MAX_BACKLOG);
    record.offset += data.length;
    emit(record, { type: "output", data, offset: record.offset });
  });
  pty.onExit(({ exitCode }) => {
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    record.cleanupTimer = null;
    record.exited = true;
    record.exitCode = exitCode;
    emit(record, { type: "exit", exitCode });
    scheduleCleanup(id, record);
  });
  return id;
}

export function hasTerminal(id: string): boolean {
  return registry().has(id);
}

export function getTerminalCwd(id: string): string | undefined {
  return registry().get(id)?.cwd;
}

export function subscribeTerminal(
  id: string,
  listener: TerminalListener,
  after?: number,
): { output: Extract<TerminalEvent, { type: "output" }>; exited: boolean; exitCode: number | null; unsubscribe: () => void } | null {
  const record = registry().get(id);
  if (!record) return null;
  record.listeners.add(listener);
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  record.cleanupTimer = null;
  const start = record.offset - record.backlog.length;
  const reset = after === undefined || after < start || after > record.offset;
  return {
    output: {
      type: "output",
      data: reset ? record.backlog : record.backlog.slice(after - start),
      offset: record.offset,
      reset,
    },
    exited: record.exited,
    exitCode: record.exitCode,
    unsubscribe: () => {
      record.listeners.delete(listener);
      scheduleCleanup(id, record);
    },
  };
}

export function writeTerminal(id: string, data: string): boolean {
  const record = registry().get(id);
  if (!record || record.exited) return false;
  record.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const record = registry().get(id);
  if (!record || record.exited) return false;
  record.pty.resize(dimension(cols, 80), dimension(rows, 24));
  return true;
}

export function killTerminal(id: string, force = false): boolean {
  const record = registry().get(id);
  if (!record) return false;
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  registry().delete(id);
  if (!record.exited) {
    record.pty.kill(force ? "SIGKILL" : undefined);
    // A shell may trap SIGHUP; explicit close and lease expiry must still finish.
    if (!force) {
      record.cleanupTimer = setTimeout(() => {
        if (!record.exited) record.pty.kill("SIGKILL");
      }, 2000);
      record.cleanupTimer.unref?.();
    }
  }
  emit(record, { type: "closed" });
  record.listeners.clear();
  return true;
}
