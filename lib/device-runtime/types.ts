import type {
  SessionInfo,
  SessionEntry,
  SessionHeader,
  SessionContext,
} from "../types";
import type { SessionDeleteResult } from "../session-delete";
import type {
  SessionUiState,
  SessionUiStateRequest,
} from "../session-ui-state-shared";
import type { ModelsData } from "../models-cache";
import type {
  TerminalOptions,
  TerminalSession,
} from "../gateway/types/host-driver";

/**
 * Represents a live/active session on a device.
 * Provides unified interface across local RPC agent and remote devices.
 */
export interface IActiveSession {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly sessionFile?: string;
  isAlive(): boolean;
  isRunning(): boolean;
  send(message: Record<string, unknown>): Promise<unknown>;
  steer(message: string | Record<string, unknown>): Promise<unknown>;
  abort(): Promise<void>;
  onMessage(callback: (msg: unknown) => void): () => void;
  close(): Promise<void> | void;
}

export type SessionSummary = SessionInfo;

export interface SessionTranscript {
  sessionId: string;
  sessionFile?: string;
  entries: SessionEntry[];
  context?: SessionContext;
  header?: SessionHeader | null;
  notices?: Map<string, unknown> | unknown[];
}

export interface PromptMessage {
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface SteerMessage {
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface CreateSessionOptions {
  cwd?: string;
  prompt?: string | PromptMessage;
  provider?: string;
  modelId?: string;
  toolNames?: string[];
  thinkingLevel?: string;
  /** Overrides the device's default session directory (remote spawns). */
  sessionDir?: string;
  tempKey?: string;
  maxRetries?: number;
}

export interface SendSessionCommandOptions {
  /** Tool loadout applied when a dead local session has to be resumed first. */
  toolNames?: string[];
}

export interface SessionStatus {
  running: boolean;
  /** The device's live/persisted state, when the session is known there. */
  state?: Record<string, unknown>;
}

export interface SessionInitResult {
  sessionId: string;
  sessionFile?: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  activeSession?: IActiveSession;
}

export interface ResumeSessionOptions {
  cwd?: string;
  toolNames?: string[];
  thinkingLevel?: string;
}

export interface ListSessionsOptions {
  force?: boolean;
  allowStale?: boolean;
  summary?: boolean;
  cwd?: string;
}

export interface ReadSessionContextOptions {
  leafId?: string;
  before?: string;
  tail?: number;
  deferThinking?: boolean;
  deferMedia?: boolean;
}

export interface SessionContextResult {
  context: SessionContext;
  tail?: number;
  before?: string | null;
}

/**
 * What a runtime implementation fully supports, so callers can degrade
 * explicitly instead of discovering silent gaps at runtime. The remote
 * runtime's probe cannot enumerate tool JSON schemas and reads device-level
 * models (no project scoping); everything else matches the local contract.
 */
export interface RuntimeCapabilities {
  /** getTools() returns each tool's JSON-schema `parameters`. */
  toolParameters: boolean;
  /** getAvailableModels() scopes by the cwd's project settings. */
  modelsByCwd: boolean;
  /** Session UI state carries project pins and the sidebar's project order. */
  projectUiState: boolean;
}

export interface ForkSessionOptions {
  sourceTitle?: string;
  /** Fork at this entry instead of the session's current leaf. */
  targetEntryId?: string;
}

export interface ForkSessionResult {
  sessionId: string;
  sessionPath: string;
  name?: string;
}

export interface SetToolsResult {
  sessionId: string;
  tools?: string[];
  recreated?: boolean;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  active?: boolean;
  exposure?: string;
}

export interface SendPromptOptions {
  streamingBehavior?: "steer" | "followUp";
}

export interface SendPromptResult {
  success: boolean;
  sessionId: string;
  result?: unknown;
}

export interface SteerResult {
  success: boolean;
  sessionId: string;
}

export interface MeshMessage {
  targetSessionId?: string;
  message: string;
  mode?: "realtime" | "steer" | "followup" | "silent";
  senderContext?: {
    sessionId?: string;
    deviceId?: string;
    prompt?: string;
  };
}

export interface DeliverResult {
  success: boolean;
  targetDeviceId?: string;
  targetSessionId?: string;
  reply?: string;
  error?: string;
}

export interface DefaultModelConfig {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  settingsPath?: string | null;
}

export interface DirectoryBrowseResult {
  path: string;
  parentPath: string | null;
  directories: Array<{ name: string; path: string }>;
  drives?: Array<{ name: string; path: string }>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Unified device runtime abstraction contract.
 * Exposes 5 core capability domains:
 * 1. Session Lifecycle
 * 2. Messaging & Interruption
 * 3. Models & Settings
 * 4. Filesystem & Terminal
 * 5. UI State
 */
export interface IDeviceRuntime {
  readonly deviceId: string;
  readonly isRemote: boolean;
  readonly capabilities: RuntimeCapabilities;

  // 1. Session Lifecycle
  createSession(options: CreateSessionOptions): Promise<SessionInitResult>;
  resumeSession(sessionId: string, sessionFile?: string, options?: ResumeSessionOptions): Promise<IActiveSession>;
  getActiveSession(sessionId: string): Promise<IActiveSession | undefined>;
  hasSession(sessionId: string): Promise<boolean>;
  listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]>;
  readSessionTranscript(sessionId: string, sessionFile?: string): Promise<SessionTranscript>;
  readSessionContext(sessionId: string, sessionFile?: string, options?: ReadSessionContextOptions): Promise<SessionContextResult>;
  deleteSession(sessionId: string, sessionFile?: string): Promise<void>;
  deleteSessions(sessionIds: readonly string[], options?: { keepRunning?: boolean }): Promise<SessionDeleteResult>;
  forkSession(sessionId: string, targetEntryId?: string, options?: ForkSessionOptions): Promise<ForkSessionResult>;
  setSessionTools(sessionId: string, tools?: string[]): Promise<SetToolsResult>;
  getTools(sessionId?: string, cwd?: string): Promise<ToolDefinition[]>;
  /**
   * A client command verbatim to a live (or resumable) session. Delivery
   * commands accept on write; their progress flows through the event stream.
   * Throws when the session does not exist on this device.
   */
  sendSessionCommand(sessionId: string, command: Record<string, unknown>, options?: SendSessionCommandOptions): Promise<unknown>;
  /** Live-or-persisted status for polling; `running: false` when unknown. */
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  /** Releases a session's live channel. Local sessions report closed: false. */
  closeSession(sessionId: string): Promise<boolean>;
  subscribeSessionEvents(sessionId: string, listener: (event: unknown) => void): () => void;

  // 2. Messaging & Realtime Interruption
  sendPrompt(sessionId: string, message: string | PromptMessage, options?: SendPromptOptions): Promise<SendPromptResult>;
  steerSession(sessionId: string, message: string | SteerMessage): Promise<SteerResult>;
  abortSession(sessionId: string): Promise<void>;
  deliverMeshMessage(targetSessionId: string, message: MeshMessage): Promise<DeliverResult>;

  // 3. Models & Settings
  getAvailableModels(cwd?: string): Promise<ModelsData>;
  getDefaultModel(cwd?: string): Promise<DefaultModelConfig>;
  setDefaultModel(config: DefaultModelConfig, cwd?: string): Promise<void>;
  getEnabledModels(cwd?: string): Promise<string[]>;
  setEnabledModels(models: string[], cwd?: string): Promise<void>;
  getModelsConfig(): Promise<Record<string, unknown>>;
  setModelsConfig(config: Record<string, unknown>): Promise<void>;

  // 4. Filesystem & Terminal
  getHomeDir(): Promise<string>;
  browseDir(dirPath?: string): Promise<DirectoryBrowseResult>;
  createDir(parentPath: string, name: string): Promise<string>;
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, content: Buffer | string): Promise<void>;
  exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult>;
  createTerminal(opts?: TerminalOptions): Promise<TerminalSession>;

  // 5. UI State
  getSessionUiState(): Promise<SessionUiState>;
  updateSessionUiState(patch: SessionUiStateRequest | Partial<SessionUiState>): Promise<void>;
}

export type {
  SessionUiState,
  SessionUiStateRequest,
  SessionDeleteResult,
  ModelsData,
  TerminalOptions,
  TerminalSession,
};
