import type {
  IDeviceRuntime,
  IActiveSession,
  CreateSessionOptions,
  SessionInitResult,
  ResumeSessionOptions,
  ListSessionsOptions,
  SessionSummary,
  SessionTranscript,
  ReadSessionContextOptions,
  SessionContextResult,
  ForkSessionOptions,
  ForkSessionResult,
  SetToolsResult,
  ToolDefinition,
  SendPromptOptions,
  SendPromptResult,
  PromptMessage,
  SteerMessage,
  SteerResult,
  MeshMessage,
  DeliverResult,
  DefaultModelConfig,
  DirectoryBrowseResult,
  ExecOptions,
  ExecResult,
  SessionUiState,
  SessionUiStateRequest,
  TerminalOptions,
  TerminalSession,
} from "./types";
import type { SessionEntry, SessionHeader } from "../types";
import {
  createRemoteRpcSession,
  getRemoteRpcSession,
  ensureRemoteRpcSessionForExisting,
  isRemoteSessionRunning,
  closeRemoteRpcSession,
  type RemoteRpcSession,
} from "../remote-agent-manager";
import {
  listRemoteSessions,
  findRemoteSessionFile,
  readRemoteSessionContent,
  readRemoteSessionUiState,
  updateRemoteSessionUiState as updateRemoteUiStateStore,
  invalidateRemoteSessionCache,
} from "../remote-session-store";
import { deleteRemoteSessions } from "../remote-session-delete";
import { forkRemoteSession } from "../remote-session-fork";
import { getRemoteTools } from "../remote-tools";
import { loadRemoteModels, remoteCatalogueToModelsData } from "../remote-models";
import type { ModelsData } from "../models-cache";
import {
  readRemoteDefaultPreferences,
  writeRemoteDefaultPreferences,
} from "../remote-default-preferences";
import {
  readRemoteEnabledModels,
  writeRemoteEnabledModels,
} from "../remote-enabled-models";
import {
  readRemoteModelsConfig,
  writeRemoteModelsConfig,
} from "../remote-models-config";
import { listRemoteDirectory, readRemoteBuffer } from "../remote-files";
import { deviceHomeOrDefault } from "../device-home";
import { getGateway } from "../gateway/singleton";
import type { IHostDriver } from "../gateway/types/host-driver";
import { sendMeshMessage } from "../gateway/mesh-router";
import {
  buildSessionContext,
  resolveSessionPath,
} from "../session-reader";
import {
  parseSessionEntries,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  attachTranscriptNotices,
  readSessionTranscriptNotices,
} from "../transcript-notices-server";
import { emptySessionUiState } from "../session-ui-state-shared";
import { withChannelRetry, isChannelOpenFailure } from "../gateway/drivers/channel-retry";

/**
 * Queue of pending session creation requests per device.
 * Serializes concurrent channel allocation and retries to avoid Channel open failure / MaxSessions saturation.
 */
const deviceSessionQueues = new Map<string, Promise<unknown>>();

async function enqueueDeviceSessionTask<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  const previous = deviceSessionQueues.get(deviceId) || Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  deviceSessionQueues.set(
    deviceId,
    previous.catch(() => {}).then(() => current),
  );

  try {
    await previous.catch(() => {});
    return await task();
  } finally {
    release();
    if (deviceSessionQueues.get(deviceId) === current) {
      deviceSessionQueues.delete(deviceId);
    }
  }
}

/**
 * Robust extraction of mesh_outbound frame payload from raw RPC message.
 * Supports both top-level { target, message, ... } and nested { data: { target, message, ... } }.
 */
export function unpackMeshOutboundFrame(msg: any): {
  isMeshOutbound: boolean;
  target?: string;
  message?: string;
  mode?: "realtime" | "steer" | "followup" | "silent";
  senderContext?: {
    sessionId?: string;
    deviceId?: string;
    cwd?: string;
    prompt?: string;
    isToolCall?: boolean;
  };
  frameId?: string;
} {
  if (!msg || typeof msg !== "object") {
    return { isMeshOutbound: false };
  }
  const p = msg.data && typeof msg.data === "object" ? msg.data : msg;
  const isMeshOutbound = msg.type === "mesh_outbound" || p.type === "mesh_outbound";
  const target = msg.target || p.target;
  const message = msg.message || p.message;
  if (!isMeshOutbound || !target || !message) {
    return { isMeshOutbound: false };
  }

  const mode = msg.mode || p.mode || "realtime";
  const frameId = msg.id || p.id || `${target}_${String(message).slice(0, 50)}`;

  const senderCtx = msg.senderContext || p.senderContext;
  const senderObj = msg.sender || p.sender;
  const senderSess = senderCtx?.sessionId || senderObj?.sessionId;
  const senderDev = senderCtx?.deviceId || senderObj?.host || senderObj?.deviceId;
  const senderCwd = senderCtx?.cwd || senderObj?.cwd;
  const prompt = senderCtx?.prompt || p.prompt;

  return {
    isMeshOutbound: true,
    target,
    message,
    mode,
    frameId,
    senderContext: {
      sessionId: senderSess,
      deviceId: senderDev,
      cwd: senderCwd,
      prompt,
      isToolCall: senderCtx?.isToolCall ?? true,
    },
  };
}

/**
 * Remote Active Session adapter wrapping an in-memory RemoteRpcSession.
 */
export class SshRemoteActiveSession implements IActiveSession {
  constructor(public readonly session: RemoteRpcSession) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  get cwd(): string | undefined {
    return this.session.state?.cwd;
  }

  get sessionFile(): string | undefined {
    return this.session.state?.sessionFile;
  }

  isAlive(): boolean {
    return !((this.session.channel as any).isClosed?.());
  }

  isRunning(): boolean {
    return isRemoteSessionRunning(this.session);
  }

  async send(message: Record<string, unknown>): Promise<unknown> {
    const type = message.type as string;
    if (type === "prompt" || type === "steer" || type === "follow_up" || type === "abort") {
      try {
        const { unblockPendingRealtimeWait } = await import("../gateway/mesh-router");
        unblockPendingRealtimeWait(this.sessionId, this.session.deviceId, "Unblocked by incoming message.");
      } catch {}
    }
    return new Promise((resolve, reject) => {
      const id = (message.id as string) || `remote-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const req = { ...message, id };
      const unsub = this.onMessage((msg: any) => {
        if (msg && msg.type === "response" && msg.id === id) {
          clearTimeout(timeout);
          unsub();
          resolve(msg);
        }
      });
      // No answer in 5 s means the command did not reach the remote `pi` (dead
      // channel, device asleep): a fabricated success made remote delivery
      // indistinguishable from the local path's real errors. `abort` stays
      // fire-and-forget — best effort by design.
      const timeout = setTimeout(() => {
        unsub();
        if (type === "abort") {
          resolve({ type: "response", id, success: true, acknowledged: false });
        } else {
          reject(new Error(
            `Remote command "${type}" got no response from device "${this.session.deviceId}" within 5 s.`
            + " The device may be offline or its `pi` process gone.",
          ));
        }
      }, 5000);
      timeout.unref?.();

      try {
        this.session.channel.send(req);
      } catch (error) {
        clearTimeout(timeout);
        unsub();
        reject(new Error(
          `Remote command "${type}" could not be sent to device "${this.session.deviceId}": ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });
  }

  async steer(message: string | Record<string, unknown>): Promise<unknown> {
    const text = typeof message === "string" ? message : (message.message as string);
    const images = typeof message === "string" ? undefined : (message.images as any);
    if (this.isRunning()) {
      return this.send({ type: "steer", message: text, ...(images ? { images } : {}) });
    }
    return this.send({
      type: "prompt",
      message: text,
      streamingBehavior: "steer",
      ...(images ? { images } : {}),
    });
  }

  async abort(): Promise<void> {
    this.session.channel.abort?.();
  }

  onMessage(callback: (msg: unknown) => void): () => void {
    const listener = (msg: unknown) => callback(msg);
    this.session.listeners.add(listener);
    return () => {
      this.session.listeners.delete(listener);
    };
  }

  close(): Promise<void> | void {
    closeRemoteRpcSession(this.sessionId);
  }
}

/**
 * SshRemoteDeviceRuntime implements IDeviceRuntime for remote SSH hosts.
 * Reuses existing gateway, SSH driver, and remote session modules without code duplication.
 */
export class SshRemoteDeviceRuntime implements IDeviceRuntime {
  readonly isRemote = true;
  readonly capabilities = {
    // The remote tool probe lists names and descriptions; JSON schemas need a
    // full session connection the probe does not open.
    toolParameters: false,
    // The probe reads the device's models.json and its live session; project
    // settings scoping is a local-file read the probe cannot do.
    modelsByCwd: false,
    projectUiState: true,
  };
  constructor(public readonly deviceId: string) {}

  protected async getDriver(): Promise<IHostDriver> {
    return getGateway().getOrConnectDriver(this.deviceId);
  }

  // 1. Session Lifecycle

  async createSession(options: CreateSessionOptions): Promise<SessionInitResult> {
    const effectiveCwd = options.cwd || (await this.getHomeDir());
    const initialModel = options.provider && options.modelId
      ? { provider: options.provider, modelId: options.modelId }
      : undefined;

    const attempts = options.maxRetries ?? 3;

    return enqueueDeviceSessionTask(this.deviceId, async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const { sessionId, session, data } = await createRemoteRpcSession({
            deviceId: this.deviceId,
            cwd: effectiveCwd,
            model: initialModel,
            thinkingLevel: options.thinkingLevel,
            toolNames: options.toolNames,
          });

          const activeSession = new SshRemoteActiveSession(session);

          if (options.prompt) {
            const promptText = typeof options.prompt === "string" ? options.prompt : options.prompt.message;
            const promptImages = typeof options.prompt === "string" ? undefined : options.prompt.images;
            await activeSession.send({
              type: "prompt",
              message: promptText,
              ...(promptImages ? { images: promptImages } : {}),
            });
          }

          return {
            sessionId,
            sessionFile: session.state?.sessionFile || data?.sessionFile,
            model: session.state?.model
              ? { provider: session.state.model.provider, modelId: session.state.model.id }
              : initialModel || null,
            thinkingLevel: session.state?.thinkingLevel ?? options.thinkingLevel ?? null,
            activeSession,
          };
        } catch (err) {
          lastError = err;
          if (isChannelOpenFailure(err) && attempt < attempts - 1) {
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    });
  }

  async resumeSession(
    sessionId: string,
    _sessionFile?: string,
    options?: ResumeSessionOptions,
  ): Promise<IActiveSession> {
    const existing = getRemoteRpcSession(sessionId);
    if (existing && !((existing.channel as any).isClosed?.())) {
      return new SshRemoteActiveSession(existing);
    }

    return enqueueDeviceSessionTask(this.deviceId, async () => {
      const resumed = await ensureRemoteRpcSessionForExisting(this.deviceId, sessionId);
      if (!resumed) {
        throw new Error(`Remote session not found or failed to resume: ${sessionId}`);
      }

      if (options?.thinkingLevel) {
        resumed.channel.send({ type: "set_thinking_level", level: options.thinkingLevel });
      }
      if (options?.toolNames) {
        resumed.channel.send({ type: "set_tools", toolNames: [...options.toolNames] });
      }

      return new SshRemoteActiveSession(resumed);
    });
  }

  async getActiveSession(sessionId: string): Promise<IActiveSession | undefined> {
    const existing = getRemoteRpcSession(sessionId);
    if (existing && existing.deviceId === this.deviceId && !((existing.channel as any).isClosed?.())) {
      return new SshRemoteActiveSession(existing);
    }
    return undefined;
  }

  async hasSession(sessionId: string): Promise<boolean> {
    const file = await findRemoteSessionFile(this.deviceId, sessionId);
    return Boolean(file);
  }

  async listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]> {
    let summaries = await listRemoteSessions(this.deviceId, {
      force: options?.force,
      deferDetails: options?.summary,
    });
    if (options?.cwd) {
      summaries = summaries.filter((s) => s.cwd === options.cwd);
    }
    return summaries;
  }

  async readSessionTranscript(sessionId: string, _sessionFile?: string): Promise<SessionTranscript> {
    const file = await findRemoteSessionFile(this.deviceId, sessionId);
    if (!file) {
      throw new Error(`Session not found on remote device ${this.deviceId}: ${sessionId}`);
    }

    const content = await readRemoteSessionContent(this.deviceId, file);
    const entries = parseSessionEntries(content) as unknown as SessionEntry[];
    const sm = SessionManager.inMemory(file.cwd || "/", undefined, entries as any);
    const header = sm.getHeader() as SessionHeader | null;

    const transcriptNotices = readSessionTranscriptNotices({
      entries,
      cwd: header?.cwd ?? file.cwd ?? "",
      leafId: sm.getLeafId(),
    });

    const context = attachTranscriptNotices(
      buildSessionContext(entries as never, sm.getLeafId(), {
        sessionId,
      }),
      transcriptNotices,
    );

    return {
      sessionId,
      sessionFile: file.path,
      entries,
      context,
      header,
      notices: transcriptNotices,
    };
  }

  async readSessionContext(
    sessionId: string,
    _sessionFile?: string,
    options?: ReadSessionContextOptions,
  ): Promise<SessionContextResult> {
    const file = await findRemoteSessionFile(this.deviceId, sessionId);
    if (!file) {
      throw new Error(`Session not found on remote device ${this.deviceId}: ${sessionId}`);
    }

    const content = await readRemoteSessionContent(this.deviceId, file);
    const entries = parseSessionEntries(content) as unknown as SessionEntry[];
    const sm = SessionManager.inMemory(file.cwd || "/", undefined, entries as any);
    const leafId = options?.leafId ?? sm.getLeafId();
    const tail = options?.tail ?? 50;
    const before = options?.before;

    const transcriptNotices = readSessionTranscriptNotices({
      entries,
      cwd: sm.getHeader()?.cwd ?? file.cwd ?? "",
      leafId: leafId ?? sm.getLeafId(),
    });

    const context = attachTranscriptNotices(
      buildSessionContext(entries as never, before ?? leafId, {
        deferThinking: options?.deferThinking,
        deferToolResultImages: options?.deferMedia,
        tail,
        excludeLeaf: Boolean(before),
        sessionId,
        deviceId: this.deviceId,
      }),
      transcriptNotices,
    );

    return { context, tail, before: before ?? null };
  }

  async deleteSession(sessionId: string, _sessionFile?: string): Promise<void> {
    await deleteRemoteSessions(this.deviceId, [sessionId]);
  }

  async deleteSessions(sessionIds: readonly string[], options?: { keepRunning?: boolean }) {
    return deleteRemoteSessions(this.deviceId, sessionIds, options);
  }

  async forkSession(
    sessionId: string,
    targetEntryId?: string,
    options?: ForkSessionOptions,
  ): Promise<ForkSessionResult> {
    const res = await forkRemoteSession(this.deviceId, sessionId, {
      targetEntryId: options?.targetEntryId ?? targetEntryId,
      sourceTitle: options?.sourceTitle,
    });
    return {
      sessionId: res.sessionId,
      sessionPath: res.session.path,
      name: res.session.name,
    };
  }

  async setSessionTools(sessionId: string, tools?: string[]): Promise<SetToolsResult> {
    let session = getRemoteRpcSession(sessionId);
    if (!session || ((session.channel as any).isClosed?.())) {
      // The local contract recreates the session from its transcript and pins
      // the loadout there. The remote mirror resumes the persisted session so
      // the loadout lands on a live channel too; a session that does not exist
      // on the device is an error, not a silent success.
      const resumed = await enqueueDeviceSessionTask(this.deviceId, () =>
        ensureRemoteRpcSessionForExisting(this.deviceId, sessionId));
      if (!resumed) {
        throw new Error(`Session not found on remote device ${this.deviceId}: ${sessionId}`);
      }
      session = resumed;
    }
    session.pendingToolNames = tools ? [...tools] : undefined;
    session.channel.send({ type: "set_tools", toolNames: tools ? [...tools] : [] });
    return { sessionId, tools, recreated: false };
  }

  async getTools(sessionId?: string, cwd?: string): Promise<ToolDefinition[]> {
    const rawTools = await getRemoteTools(this.deviceId, cwd);
    return rawTools.map((t) => ({
      name: t.name,
      description: t.description,
      active: t.active,
    }));
  }

  subscribeSessionEvents(sessionId: string, listener: (event: unknown) => void): () => void {
    const session = getRemoteRpcSession(sessionId);
    if (session && !((session.channel as any).isClosed?.())) {
      const wrapped = (msg: any) => listener(msg);
      session.listeners.add(wrapped);
      return () => {
        session.listeners.delete(wrapped);
      };
    }
    return () => {};
  }

  // 2. Messaging & Interruption

  async sendPrompt(
    sessionId: string,
    message: string | PromptMessage,
    options?: SendPromptOptions,
  ): Promise<SendPromptResult> {
    let active = await this.getActiveSession(sessionId);
    if (!active) {
      active = await this.resumeSession(sessionId);
    }

    const promptText = typeof message === "string" ? message : message.message;
    const images = typeof message === "string" ? undefined : message.images;

    const result = await active.send({
      type: "prompt",
      message: promptText,
      ...(images ? { images } : {}),
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    });

    return { success: true, sessionId, result };
  }

  async steerSession(
    sessionId: string,
    message: string | SteerMessage,
  ): Promise<SteerResult> {
    const active = await this.getActiveSession(sessionId);
    if (!active) {
      throw new Error(`Cannot steer session ${sessionId}: session is not active on remote device ${this.deviceId}`);
    }

    const text = typeof message === "string" ? message : message.message;
    const images = typeof message === "string" ? undefined : message.images;

    if (active.isRunning()) {
      await active.send({ type: "steer", message: text, ...(images ? { images } : {}) });
    } else {
      await active.send({
        type: "prompt",
        message: text,
        streamingBehavior: "steer",
        ...(images ? { images } : {}),
      });
    }

    return { success: true, sessionId };
  }

  async abortSession(sessionId: string): Promise<void> {
    const active = await this.getActiveSession(sessionId);
    if (active) {
      await active.abort();
    }
  }

  async deliverMeshMessage(
    targetSessionId: string,
    message: MeshMessage,
  ): Promise<DeliverResult> {
    const fullTarget = targetSessionId.includes("@") || targetSessionId.includes(".")
      ? targetSessionId
      : `${targetSessionId}@${this.deviceId}`;
    const result = await sendMeshMessage({
      target: fullTarget,
      message: message.message,
      mode: message.mode,
      senderContext: message.senderContext,
    });
    return {
      success: result.success,
      targetDeviceId: result.targetDeviceId,
      targetSessionId: result.targetSessionId,
      reply: result.reply,
      error: result.error,
    };
  }

  // 3. Models & Settings

  async getAvailableModels(cwd?: string): Promise<ModelsData> {
    const catalogue = await loadRemoteModels(this.deviceId);
    return remoteCatalogueToModelsData(catalogue);
  }

  async getDefaultModel(cwd?: string): Promise<DefaultModelConfig> {
    const prefs = await readRemoteDefaultPreferences(this.deviceId).catch(() => null);
    const catalogue = await loadRemoteModels(this.deviceId);
    const provider = prefs?.defaultProvider ?? catalogue.defaultModel?.provider ?? undefined;
    const modelId = prefs?.defaultModel ?? catalogue.defaultModel?.id ?? undefined;
    const thinkingLevel = prefs?.defaultThinkingLevel ?? catalogue.thinkingLevel ?? undefined;
    return {
      provider,
      modelId,
      thinkingLevel,
      settingsPath: prefs?.settingsPath ?? null,
    };
  }

  async setDefaultModel(config: DefaultModelConfig, cwd?: string): Promise<void> {
    await writeRemoteDefaultPreferences(
      this.deviceId,
      {
        model: config.provider && config.modelId ? { provider: config.provider, modelId: config.modelId } : undefined,
        thinkingLevel: config.thinkingLevel as any,
      },
      { cwd },
    );
  }

  async getEnabledModels(cwd?: string): Promise<string[]> {
    const state = await readRemoteEnabledModels(this.deviceId, { cwd });
    return state.patterns ?? [];
  }

  async setEnabledModels(models: string[], cwd?: string): Promise<void> {
    await writeRemoteEnabledModels(this.deviceId, models, { cwd });
  }

  async getModelsConfig(): Promise<Record<string, unknown>> {
    return readRemoteModelsConfig(this.deviceId);
  }

  async setModelsConfig(config: Record<string, unknown>): Promise<void> {
    await writeRemoteModelsConfig(this.deviceId, config);
  }

  // 4. Filesystem & Terminal

  async getHomeDir(): Promise<string> {
    return deviceHomeOrDefault(this.deviceId);
  }

  async browseDir(dirPath?: string): Promise<DirectoryBrowseResult> {
    const driver = await this.getDriver();
    const home = await this.getHomeDir();

    let target = dirPath?.trim() || home;
    if (target === "~") target = home;
    else if (target.startsWith("~/")) target = `${home}/${target.slice(2)}`;
    if (!target.startsWith("/")) target = `${home}/${target}`.replace(/\/{2,}/g, "/");

    let entries;
    try {
      entries = await listRemoteDirectory(driver, target);
    } catch {
      throw new Error(`Directory does not exist: ${target}`);
    }

    const directories = entries
      .filter((entry) => entry.isDir)
      .map((entry) => ({
        name: entry.name,
        path: target === "/" ? `/${entry.name}` : `${target}/${entry.name}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = target === "/" ? null : target.slice(0, target.lastIndexOf("/")) || "/";
    return { path: target, parentPath, directories };
  }

  async createDir(parentPath: string, name: string): Promise<string> {
    if (!name || name === "." || name === ".." || /[\/]/.test(name)) {
      throw new Error("Directory name must be a single folder name");
    }
    const driver = await this.getDriver();
    const parentStat = await driver.stat(parentPath).catch(() => null);
    if (!parentStat?.isDirectory) {
      throw new Error("Parent path is not a directory");
    }
    const createdPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    const res = await driver.exec(`mkdir -p -- ${JSON.stringify(createdPath)}`);
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || "Failed to create directory");
    }
    return createdPath;
  }

  async readFile(filePath: string): Promise<Buffer> {
    const driver = await this.getDriver();
    return readRemoteBuffer(driver, filePath);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const driver = await this.getDriver();
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const b64 = buf.toString("base64");
    const escapedPath = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const writeScript = `node -e \"const fs=require(\\\"fs\\\"), path=require(\\\"path\\\"); const p=\\\"${escapedPath}\\\"; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(\\\"${b64}\\\", \\\"base64\\\"));\"`;
    const res = await driver.exec(writeScript, [], { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw new Error(`Failed to write remote file ${filePath}: ${res.stderr || res.stdout}`);
    }
  }

  async exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult> {
    const driver = await this.getDriver();
    return driver.exec(cmd, args, opts);
  }

  async createTerminal(opts?: TerminalOptions): Promise<TerminalSession> {
    const driver = await this.getDriver();
    try {
      return await driver.createTerminal(opts);
    } catch (err) {
      if (isChannelOpenFailure(err)) {
        // If driver failed due to channel concurrency, wait briefly and retry once
        await new Promise((r) => setTimeout(r, 150));
        return driver.createTerminal(opts);
      }
      throw err;
    }
  }

  // 5. UI State

  async getSessionUiState(): Promise<SessionUiState> {
    const remote = await readRemoteSessionUiState(this.deviceId);
    return {
      ...emptySessionUiState(),
      projectNames: remote.projectNames || {},
      sessions: (remote.sessions as any) || {},
      projects: (remote.projects as any) || {},
      ...(remote.projectOrder ? { projectOrder: remote.projectOrder } : {}),
    };
  }

  async updateSessionUiState(patch: SessionUiStateRequest | Partial<SessionUiState>): Promise<void> {
    if ("action" in patch) {
      await updateRemoteUiStateStore(this.deviceId, patch);
      return;
    }

    const statePatch = patch as Partial<SessionUiState>;
    if (statePatch.sessions) {
      for (const [id, s] of Object.entries(statePatch.sessions)) {
        if (typeof s?.pinnedAt === "number") {
          await updateRemoteUiStateStore(this.deviceId, { action: "set", ids: [id], pinned: true });
        } else if (s?.pinnedAt === null) {
          await updateRemoteUiStateStore(this.deviceId, { action: "set", ids: [id], pinned: false });
        }
        if (typeof s?.archivedAt === "number") {
          await updateRemoteUiStateStore(this.deviceId, { action: "set", ids: [id], archived: true });
        } else if (s?.archivedAt === null) {
          await updateRemoteUiStateStore(this.deviceId, { action: "set", ids: [id], archived: false });
        }
      }
    }
    if (statePatch.projectNames) {
      for (const [key, name] of Object.entries(statePatch.projectNames)) {
        await updateRemoteUiStateStore(this.deviceId, { action: "rename-project", projectKey: key, name: name ?? null });
      }
    }
  }
}
