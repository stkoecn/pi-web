export interface TerminalOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  initialCmd?: string;
  env?: Record<string, string>;
}

export interface TerminalSession {
  sessionId: string;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onData(callback: (data: Buffer) => void): () => void;
  onExit(callback: (exitCode: number) => void): () => void;
  close(): void;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RPCChannel {
  send(message: Record<string, any>): void;
  onMessage(callback: (msg: Record<string, any>) => void): () => void;
  onError(callback: (err: Error) => void): () => void;
  onClose(callback: (code?: number) => void): () => void;
  abort(): void;
  close(): void;
}

export interface IHostDriver {
  readonly deviceId: string;
  
  // 1. Terminal (Interactive PTY)
  createTerminal(opts?: TerminalOptions): Promise<TerminalSession>;

  // 2. File Operations (via SFTP / Remote)
  readDir(dirPath: string): Promise<FileEntry[]>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, content: Buffer | string): Promise<void>;
  stat(targetPath: string): Promise<FileEntry>;

  // 3. Execution (Git, utilities, tools)
  exec(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;

  // 4. Remote Pi Agent RPC channel (pi --mode rpc)
  spawnPiRpc(opts?: { cwd?: string; sessionDir?: string; resumeSession?: string }): Promise<RPCChannel>;

  // Status check & lifecycle
  isAlive(): boolean;
  close(): Promise<void>;
}
