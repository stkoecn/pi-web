import type { IHostDriver, TerminalOptions, TerminalSession, FileEntry, ExecResult, RPCChannel } from '../../types/host-driver';

export class OfflineHostDriver implements IHostDriver {
  readonly deviceId: string;
  private message: string;

  constructor(deviceId: string, message: string = 'Device is currently offline or unreachable') {
    this.deviceId = deviceId;
    this.message = message;
  }

  isAlive(): boolean {
    return false;
  }

  async createTerminal(_opts?: TerminalOptions): Promise<TerminalSession> {
    throw new Error(`[${this.deviceId}] ${this.message}`);
  }

  async readDir(_dirPath: string): Promise<FileEntry[]> {
    throw new Error(`[${this.deviceId}] ${this.message}`);
  }

  async readFile(_filePath: string): Promise<Buffer> {
    throw new Error(`[${this.deviceId}] ${this.message}`);
  }

  async writeFile(_filePath: string, _content: Buffer | string): Promise<void> {
    throw new Error(`[${this.deviceId}] ${this.message}`);
  }

  async stat(_targetPath: string): Promise<FileEntry> {
    throw new Error(`[${this.deviceId}] ${this.message}`);
  }

  async exec(_cmd: string, _args?: string[], _opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    throw new Error(`[${this.deviceId}] ${this.message}`);
  }

  async spawnPiRpc(_opts?: { cwd?: string; sessionDir?: string; resumeSession?: string }): Promise<RPCChannel> {
    throw new Error(`[${this.deviceId}] ${this.message}`);
  }

  async close(): Promise<void> {}
}
