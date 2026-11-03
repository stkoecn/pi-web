import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createAgentSessionServices,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { LOCAL_DEVICE_ID } from "../device-context";
import {
  startRpcSession,
  getRpcSession,
  setRpcSessionTools,
  getRpcSessionInfos,
  withSubagentDisplayStatus,
  type AgentSessionWrapper,
} from "../rpc-manager";
import {
  listAllSessions,
  listSessionSummaries,
  attachSessionProjectInfo,
  mergeSessionLists,
  resolveSessionPath,
  openSessionManager,
  buildSessionContext,
} from "../session-reader";
import { deleteSessions } from "../session-delete";
import { forkSessionBranch, readForkSourceTitle } from "../session-fork";
import {
  readSessionUiState,
  updateSessionUiState as updateSessionUiStateLocal,
} from "../session-ui-state";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  invalidateModelsCache,
  type ModelsData,
} from "../models-cache";
import {
  writeDefaultPreferences,
  isThinkingLevel,
  type DefaultPreferencesEdit,
} from "../default-preferences";
import { writeEnabledModels } from "../enabled-models-runtime";
import {
  orderSelectorModels,
  resolveVisibleModels,
  selectInitialModelScope,
} from "../model-scope";
import {
  rememberProviderModels,
  withDeferredProviderModels,
} from "../deferred-provider-models";
import { projectTrustReloadOptions } from "../project-trust";
import {
  getBrowseStartDirectory,
  resolveDirectory,
  listDirectories,
  getParentDirectory,
  shouldShowWindowsDrivePicker,
  listWindowsDrives,
} from "../directory-browser";
import { LocalHostDriver } from "../gateway/drivers/local-host-driver";
import { sendMeshMessage } from "../gateway/mesh-router";
import {
  attachTranscriptNotices,
  readSessionTranscriptNotices,
} from "../transcript-notices-server";
import { loadSkillsWithInstallInfo } from "../skills-service";
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

/**
 * Local Active Session adapter wrapping an in-memory AgentSessionWrapper.
 */
export class LocalActiveSession implements IActiveSession {
  constructor(public readonly wrapper: AgentSessionWrapper) {}

  get sessionId(): string {
    return this.wrapper.inner.sessionId;
  }

  get cwd(): string | undefined {
    return this.wrapper.cwd;
  }

  get sessionFile(): string | undefined {
    return this.wrapper.sessionFile;
  }

  isAlive(): boolean {
    return this.wrapper.isAlive();
  }

  isRunning(): boolean {
    return this.wrapper.isRunning();
  }

  async send(message: Record<string, unknown>): Promise<unknown> {
    return this.wrapper.send(message);
  }

  async steer(message: string | Record<string, unknown>): Promise<unknown> {
    if (typeof message === "string") {
      return this.wrapper.send({ type: "steer", message });
    }
    return this.wrapper.send(message);
  }

  async abort(): Promise<void> {
    await this.wrapper.send({ type: "abort" });
  }

  onMessage(callback: (msg: unknown) => void): () => void {
    return this.wrapper.onEvent((event) => callback(event));
  }

  close(): Promise<void> | void {
    return this.wrapper.shutdown();
  }
}

/**
 * LocalDeviceRuntime implements IDeviceRuntime by wrapping and delegating to
 * existing mature local subsystems without code duplication.
 */
export class LocalDeviceRuntime implements IDeviceRuntime {
  readonly deviceId: string = LOCAL_DEVICE_ID;

  // 1. Session Lifecycle

  async createSession(options: CreateSessionOptions): Promise<SessionInitResult> {
    const effectiveCwd = options.cwd || (await this.getHomeDir());
    const tempKey = options.tempKey || `__new__${randomUUID()}`;
    const initialModel = options.provider && options.modelId
      ? { provider: options.provider, modelId: options.modelId }
      : undefined;

    const { session, realSessionId } = await startRpcSession(
      tempKey,
      "",
      effectiveCwd,
      {
        ...(options.toolNames ? { toolNames: options.toolNames } : {}),
        ...(initialModel ? { initialModel } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel as any } : {}),
      },
    );

    if (options.prompt) {
      const promptText = typeof options.prompt === "string" ? options.prompt : options.prompt.message;
      const promptImages = typeof options.prompt === "string" ? undefined : options.prompt.images;
      await session.send({
        type: "prompt",
        message: promptText,
        ...(promptImages ? { images: promptImages } : {}),
      });
    }

    const state = (await session.send({ type: "get_state" }).catch(() => ({}))) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
      sessionFile?: string;
    };

    return {
      sessionId: realSessionId,
      sessionFile: session.sessionFile || state?.sessionFile,
      model: state?.model ? { provider: state.model.provider, modelId: state.model.id } : null,
      thinkingLevel: state?.thinkingLevel ?? null,
      activeSession: new LocalActiveSession(session),
    };
  }

  async resumeSession(
    sessionId: string,
    sessionFile?: string,
    options?: ResumeSessionOptions,
  ): Promise<IActiveSession> {
    const existing = getRpcSession(sessionId);
    if (existing?.isAlive()) {
      return new LocalActiveSession(existing);
    }

    const resolvedPath = sessionFile || (await resolveSessionPath(sessionId));
    if (!resolvedPath && !options?.cwd) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const { session } = await startRpcSession(
      sessionId,
      resolvedPath || "",
      options?.cwd,
      {
        ...(options?.toolNames ? { toolNames: options.toolNames } : {}),
        ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel as any } : {}),
      },
    );

    return new LocalActiveSession(session);
  }

  async getActiveSession(sessionId: string): Promise<IActiveSession | undefined> {
    const existing = getRpcSession(sessionId);
    if (existing?.isAlive()) {
      return new LocalActiveSession(existing);
    }
    return undefined;
  }

  async listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]> {
    let summaries: SessionSummary[];
    if (options?.summary) {
      summaries = await listSessionSummaries();
    } else {
      summaries = await listAllSessions({ force: options?.force, allowStale: options?.allowStale });
    }
    const rpcSessions = getRpcSessionInfos({ includeTransient: true });
    summaries = mergeSessionLists(summaries, rpcSessions);
    summaries = withSubagentDisplayStatus(summaries);
    await attachSessionProjectInfo(summaries);
    if (options?.cwd) {
      summaries = summaries.filter((s) => s.cwd === options.cwd);
    }
    return summaries;
  }

  async readSessionTranscript(sessionId: string, sessionFile?: string): Promise<SessionTranscript> {
    const rpc = getRpcSession(sessionId);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = sessionFile || (liveRpc ? liveRpc.sessionFile : await resolveSessionPath(sessionId));
    if (!liveRpc && !filePath) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
    const entries = sm.getEntries() as unknown as SessionEntry[];
    const header = sm.getHeader() as SessionHeader | null;
    const transcriptNotices = readSessionTranscriptNotices({
      entries,
      cwd: header?.cwd ?? "",
      leafId: sm.getLeafId(),
      models: liveRpc?.inner.modelRuntime,
    });
    const context = attachTranscriptNotices(
      buildSessionContext(entries as never, sm.getLeafId(), {
        sessionId,
      }),
      transcriptNotices,
    );

    return {
      sessionId,
      sessionFile: filePath ?? undefined,
      entries,
      context,
      header,
      notices: transcriptNotices,
    };
  }

  async readSessionContext(
    sessionId: string,
    sessionFile?: string,
    options?: ReadSessionContextOptions,
  ): Promise<SessionContextResult> {
    const rpc = getRpcSession(sessionId);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = sessionFile || (liveRpc ? liveRpc.sessionFile : await resolveSessionPath(sessionId));
    if (!liveRpc && !filePath) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
    const entries = sm.getEntries();
    const leafId = options?.leafId ?? sm.getLeafId();
    const tail = options?.tail ?? 50;
    const before = options?.before;
    const transcriptNotices = readSessionTranscriptNotices({
      entries: entries as unknown as SessionEntry[],
      cwd: sm.getHeader()?.cwd ?? "",
      leafId: leafId ?? sm.getLeafId(),
      models: liveRpc?.inner.modelRuntime,
    });
    const context = attachTranscriptNotices(
      buildSessionContext(entries as never, before ?? leafId, {
        deferThinking: options?.deferThinking,
        deferToolResultImages: options?.deferMedia,
        tail,
        excludeLeaf: Boolean(before),
        sessionId,
      }),
      transcriptNotices,
    );
    return { context, tail, before: before ?? null };
  }

  async deleteSession(sessionId: string, _sessionFile?: string): Promise<void> {
    await deleteSessions([sessionId]);
  }

  async forkSession(
    sessionId: string,
    targetEntryId?: string,
    options?: ForkSessionOptions,
  ): Promise<ForkSessionResult> {
    const rpc = getRpcSession(sessionId);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const sourcePath = liveRpc?.sessionFile || (await resolveSessionPath(sessionId));
    if (!sourcePath) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const liveLeafId = liveRpc ? (targetEntryId ?? liveRpc.inner.sessionManager.getLeafId()) : targetEntryId;
    const sourceTitle = options?.sourceTitle !== undefined
      ? options.sourceTitle
      : await readForkSourceTitle(sourcePath);
    const result = forkSessionBranch(sourcePath, liveLeafId, sourceTitle);
    return {
      sessionId: result.sessionId,
      sessionPath: result.path,
      name: result.name,
    };
  }

  async setSessionTools(sessionId: string, tools?: string[]): Promise<SetToolsResult> {
    const rpc = getRpcSession(sessionId);
    const sessionFile = rpc?.sessionFile || (await resolveSessionPath(sessionId)) || undefined;
    const result = await setRpcSessionTools(sessionId, sessionFile, tools);
    return {
      sessionId: result.sessionId,
      tools,
      recreated: result.recreated,
    };
  }

  async getTools(sessionId?: string, cwd?: string): Promise<ToolDefinition[]> {
    const rpc = sessionId ? getRpcSession(sessionId) : undefined;
    if (rpc?.isAlive()) {
      try {
        const tools = (await rpc.send({ type: "get_tools" })) as Array<{
          name: string;
          description?: string;
          parameters?: Record<string, unknown>;
          active?: boolean;
        }>;
        if (Array.isArray(tools)) {
          return tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            active: t.active,
          }));
        }
      } catch {
        // Fall back to default tool loadout
      }
    }

    const coreTools: ToolDefinition[] = [
      { name: "read", description: "Read file contents. Supports text files and images. Automatically handles offset and line pagination.", active: true },
      { name: "edit", description: "Make precise targeted file edits using exact text replacement.", active: true },
      { name: "write", description: "Create or overwrite files with complete content. Automatically creates parent directories.", active: true },
      { name: "bash", description: "Execute bash/shell commands in the current working directory. Returns stdout and stderr.", active: true },
      { name: "grep", description: "Search for regex patterns across files in the directory tree.", active: true },
      { name: "find", description: "Find files matching a glob pattern within the workspace.", active: true },
      { name: "ls", description: "List directory contents with file metadata.", active: true },
      { name: "ask", description: "Ask the user structured questions with tappable/selectable options.", active: true },
      { name: "send_session_message", description: "Send a message to another session or start a new session on this host or any connected remote host.", active: true },
    ];

    if (cwd) {
      try {
        const skillsResp = await loadSkillsWithInstallInfo(cwd);
        if (skillsResp?.skills) {
          for (const skill of skillsResp.skills) {
            if (!coreTools.some((t) => t.name === skill.name)) {
              coreTools.push({
                name: skill.name,
                description: skill.description,
                active: true,
              });
            }
          }
        }
      } catch {
        // Ignore skill loading errors
      }
    }

    return coreTools;
  }

  subscribeSessionEvents(sessionId: string, listener: (event: unknown) => void): () => void {
    const rpc = getRpcSession(sessionId);
    if (rpc?.isAlive()) {
      return rpc.onEvent(listener);
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
      throw new Error(`Cannot steer session ${sessionId}: session is not active`);
    }
    const text = typeof message === "string" ? message : message.message;
    const images = typeof message === "string" ? undefined : message.images;
    if (active.isRunning()) {
      await active.send({ type: "steer", message: text, ...(images ? { images } : {}) });
    } else {
      await active.send({ type: "prompt", message: text, streamingBehavior: "steer", ...(images ? { images } : {}) });
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
    const result = await sendMeshMessage({
      target: targetSessionId,
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

  private async loadModelsInternal(cwd: string): Promise<ModelsData> {
    const nameMap = new Map<string, string>();
    let modelList: { id: string; name: string; provider: string; input?: string[] }[] = [];
    let defaultModel: { provider: string; modelId: string } | null = null;
    const thinkingLevels: Record<string, string[]> = {};
    const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

    const agentDir = getAgentDir();
    const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    const modelError = services.modelRuntime.getError();
    const settings: SettingsManager = services.settingsManager;
    await rememberProviderModels(services.modelRuntime);
    const scope = await resolveVisibleModels(
      withDeferredProviderModels(services.modelRuntime),
      settings.getEnabledModels(),
    );
    const { visible, thinkingLevelPins, warnings } = scope;
    modelList = orderSelectorModels(scope).map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      input: m.input,
    }));
    for (const m of visible) {
      const key = `${m.provider}:${m.id}`;
      nameMap.set(key, m.name);
      thinkingLevels[key] = getSupportedThinkingLevels(m);
      if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
    }

    const defaultProvider = settings.getDefaultProvider();
    const defaultModelId = settings.getDefaultModel();
    const initial = selectInitialModelScope(scope, {
      ...(defaultProvider && defaultModelId
        ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
        : {}),
    });
    if (initial.model) {
      defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
    }
    const defaultThinkingLevel = initial.thinkingLevel
      ?? (initial.model
        ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
        : undefined)
      ?? settings.getDefaultThinkingLevel()
      ?? null;

    return withModelRuntimeError(
      {
        models: Object.fromEntries(nameMap),
        modelList,
        defaultModel,
        defaultThinkingLevel,
        savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
        thinkingLevels,
        thinkingLevelMaps,
        thinkingLevelPins,
        ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
      },
      modelError,
    );
  }

  async getAvailableModels(cwd?: string): Promise<ModelsData> {
    const effectiveCwd = cwd || (await this.getHomeDir());
    try {
      return await loadModelsWithCache(effectiveCwd, () => this.loadModelsInternal(effectiveCwd));
    } catch {
      return withSafeModelLoadFailure({
        models: {},
        modelList: [],
        defaultModel: null,
        defaultThinkingLevel: null,
        savedDefaultThinkingLevel: null,
        thinkingLevels: {},
        thinkingLevelMaps: {},
        thinkingLevelPins: {},
      });
    }
  }

  async getDefaultModel(cwd?: string): Promise<DefaultModelConfig> {
    const effectiveCwd = cwd || (await this.getHomeDir());
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(effectiveCwd, agentDir);
    return {
      provider: settings.getDefaultProvider() ?? undefined,
      modelId: settings.getDefaultModel() ?? undefined,
      thinkingLevel: settings.getDefaultThinkingLevel() ?? undefined,
    };
  }

  async setDefaultModel(config: DefaultModelConfig, cwd?: string): Promise<void> {
    const effectiveCwd = cwd || (await this.getHomeDir());
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(effectiveCwd, agentDir);
    const edit: DefaultPreferencesEdit = {};
    if (config.provider && config.modelId) {
      edit.model = { provider: config.provider, modelId: config.modelId };
    }
    if (config.thinkingLevel && isThinkingLevel(config.thinkingLevel)) {
      edit.thinkingLevel = config.thinkingLevel;
    }
    await writeDefaultPreferences(settings, edit);
    invalidateModelsCache();
  }

  async getEnabledModels(cwd?: string): Promise<string[]> {
    const effectiveCwd = cwd || (await this.getHomeDir());
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(effectiveCwd, agentDir);
    return settings.getEnabledModels() ?? [];
  }

  async setEnabledModels(models: string[], cwd?: string): Promise<void> {
    const effectiveCwd = cwd || (await this.getHomeDir());
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(effectiveCwd, agentDir);
    await writeEnabledModels(settings, models);
    invalidateModelsCache();
  }

  // 4. Filesystem & Terminal

  async getHomeDir(): Promise<string> {
    return os.homedir();
  }

  async browseDir(dirPath?: string): Promise<DirectoryBrowseResult> {
    if (shouldShowWindowsDrivePicker(dirPath)) {
      return {
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      };
    }
    const candidate = getBrowseStartDirectory(dirPath);
    const resolved = await resolveDirectory(candidate);
    const s = await fs.promises.stat(resolved);
    if (!s.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }
    const directories = await listDirectories(resolved);
    return {
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    };
  }

  async readFile(filePath: string): Promise<Buffer> {
    return fs.promises.readFile(filePath);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content);
  }

  async exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult> {
    const driver = new LocalHostDriver();
    return driver.exec(cmd, args, opts);
  }

  async createTerminal(opts?: TerminalOptions): Promise<TerminalSession> {
    const driver = new LocalHostDriver();
    return driver.createTerminal(opts);
  }

  // 5. UI State

  async getSessionUiState(): Promise<SessionUiState> {
    return readSessionUiState();
  }

  async updateSessionUiState(patch: SessionUiStateRequest | Partial<SessionUiState>): Promise<void> {
    if ("action" in patch) {
      await updateSessionUiStateLocal(patch);
      return;
    }
    const statePatch = patch as Partial<SessionUiState>;
    if (statePatch.sessions) {
      for (const [id, s] of Object.entries(statePatch.sessions)) {
        if (typeof s?.pinnedAt === "number") {
          await updateSessionUiStateLocal({ action: "set", ids: [id], pinned: true });
        } else if (s?.pinnedAt === null) {
          await updateSessionUiStateLocal({ action: "set", ids: [id], pinned: false });
        }
        if (typeof s?.archivedAt === "number") {
          await updateSessionUiStateLocal({ action: "set", ids: [id], archived: true });
        } else if (s?.archivedAt === null) {
          await updateSessionUiStateLocal({ action: "set", ids: [id], archived: false });
        }
      }
    }
    if (statePatch.projects) {
      for (const [key, p] of Object.entries(statePatch.projects)) {
        if (p && typeof p.pinnedAt === "number") {
          await updateSessionUiStateLocal({ action: "pin-project", projectKey: key, root: p.root, pinned: true });
        }
      }
    }
    if (statePatch.projectOrder) {
      await updateSessionUiStateLocal({ action: "add-projects", keys: statePatch.projectOrder });
    }
    if (statePatch.projectNames) {
      for (const [key, name] of Object.entries(statePatch.projectNames)) {
        await updateSessionUiStateLocal({ action: "rename-project", projectKey: key, name: name ?? null });
      }
    }
  }
}
