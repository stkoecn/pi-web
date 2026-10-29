import { getGateway } from "@/lib/gateway/singleton";
import type { RPCChannel } from "@/lib/gateway/types/host-driver";
import { deviceHomeOrDefault } from "@/lib/device-home";
import { isBlockingExtensionUiRequest } from "@/lib/extension-ui-queue";
import type { ExtensionUiRequest } from "@/lib/types";

export interface RemoteRpcSession {
  sessionId: string;
  deviceId: string;
  channel: RPCChannel;
  state: any;
  listeners: Set<(msg: any) => void>;
  createdAt: number;
  /** Last message seen on the channel; the idle sweeper reaps stale sessions. */
  lastActivityAt: number;
  /**
   * Blocking extension dialogs still unanswered on this session, by request id.
   *
   * Tracked here rather than read from `state`: pi's `get_state` does not report
   * them, and the sidebar needs to tell a run parked on a person from one that
   * is still working.
   */
  pendingUiRequestIds: Set<string>;
  /**
   * A turn is in flight, as reported by pi's own events.
   *
   * Kept apart from `state.isStreaming`: `get_state` polling replaces `state`
   * wholesale, and pi's `isStreaming` dips to false between a prompt landing and
   * the first token, which would make the sidebar flicker out of "running".
   */
  runActive: boolean;
  /**
   * Tool loadout requested at spawn time. pi's RPC mode has no `set_tools`, so the
   * selection is pinned on the transcript by the `set_tools` command handler.
   */
  pendingToolNames?: string[];
}

declare global {
  var __remoteRpcSessions: Map<string, RemoteRpcSession> | undefined;
  var __remoteRpcIdleSweeper: ReturnType<typeof setInterval> | undefined;
}

const remoteSessions: Map<string, RemoteRpcSession> =
  globalThis.__remoteRpcSessions ?? (globalThis.__remoteRpcSessions = new Map());

/** One in-flight resume per (device, session): see ensureRemoteRpcSessionForExisting. */
const resumeFlights = new Map<string, Promise<RemoteRpcSession | undefined>>();

/** A remote session with no traffic for this long is closed and dropped. */
export const REMOTE_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
/**
 * Live remote `pi` processes allowed per device.
 *
 * Each one is a full agent runtime: measured at ~55 MB RSS on a 488 MB VPS.
 * Without a cap, opening sessions (or the tests probing them) filled the host,
 * and every new SSH channel then hung until `get_state` timed out. The oldest
 * idle session of the device is closed to make room, so a fresh session never
 * waits behind abandoned ones.
 */
export const REMOTE_SESSION_MAX_PER_DEVICE = 3;
/** How often the idle sweeper runs. */
const REMOTE_SESSION_SWEEP_INTERVAL_MS = 60_000;
/** Overall budget for a remote pi to answer its first `get_state`. */
const REMOTE_INIT_TIMEOUT_MS = 15_000;
/** `get_state` is re-sent at this cadence while pi is still booting. */
const REMOTE_INIT_RETRY_INTERVAL_MS = 500;
const REMOTE_INIT_MAX_ATTEMPTS = 10;
/** Budget for one override round trip (`set_model`, `set_thinking_level`, ...). */
const REMOTE_COMMAND_TIMEOUT_MS = 5_000;

let requestCounter = 0;

/**
 * Send one command and wait for ITS response.
 *
 * `RPCChannel.send()` is fire-and-forget, so a caller that needs the answer
 * (model/thinking overrides, a live `get_state`) matches on the `id` pi echoes
 * back. A timeout resolves `null` instead of rejecting: an override that the
 * remote pi refuses must not fail session creation.
 */
function requestOnChannel(
  channel: RPCChannel,
  command: Record<string, any>,
  timeoutMs = REMOTE_COMMAND_TIMEOUT_MS,
): Promise<any> {
  const id = `piweb-${++requestCounter}`;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    const finish = (msg: any) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      resolve(msg);
    };
    unsubscribe = channel.onMessage((msg) => {
      if (!msg || msg.type !== "response" || msg.id !== id) return;
      finish(msg);
    });
    if (settled) return;
    timer = setTimeout(() => finish(null), timeoutMs);
    channel.send({ ...command, id });
  });
}

/**
 * Lazily start the idle sweeper. Unref'd so it never keeps a CLI process alive,
 * and kept on `globalThis` so a hot reload does not stack sweeps.
 */
/**
 * Close the device's oldest idle sessions until one more fits under the cap.
 * A session that is streaming is never a candidate: closing it would abort a
 * turn the user is watching.
 */
/**
 * Keep a remote session's run state honest.
 *
 * `get_state` reports `isStreaming`, which is false while a turn sits on an
 * extension dialog and false again the instant a turn ends, so it cannot answer
 * "is this run going?". pi's own event stream can: `agent_start` begins a run,
 * `agent_end` / `agent_settled` end it, and a blocking `extension_ui_request`
 * parks it until the matching `extension_ui_response` goes back.
 */
function trackRemoteRunState(session: RemoteRpcSession, msg: any): void {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "agent_start") {
    session.runActive = true;
    session.state = { ...(session.state ?? {}), isStreaming: true };
    return;
  }
  if (msg.type === "agent_end" || msg.type === "agent_settled" || msg.type === "session_shutdown") {
    session.runActive = false;
    session.state = { ...(session.state ?? {}), isStreaming: false };
    session.pendingUiRequestIds.clear();
    return;
  }
  if (msg.type === "extension_ui_request" && typeof msg.id === "string") {
    if (isBlockingExtensionUiRequest(msg as unknown as ExtensionUiRequest)) {
      session.pendingUiRequestIds.add(msg.id);
    }
    return;
  }
  // The answer travels the other way (client -> pi), so it never appears here;
  // clearing on `agent_end` is what releases a parked run.
}

function enforceDeviceSessionCap(deviceId: string): void {
  const own = getAllRemoteRpcSessions().filter((session) => session.deviceId === deviceId);
  if (own.length < REMOTE_SESSION_MAX_PER_DEVICE) return;
  // Never evict a session that is mid-turn: closing it would abort a run the
  // user is watching. `isRemoteSessionRunning` covers a run parked on a dialog,
  // which `state.isStreaming` reports as idle.
  const candidates = own
    .filter((session) => !isRemoteSessionRunning(session))
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  let excess = own.length - REMOTE_SESSION_MAX_PER_DEVICE + 1;
  for (const candidate of candidates) {
    if (excess <= 0) break;
    closeRemoteRpcSession(candidate.sessionId);
    excess--;
  }
}

function ensureIdleSweeper(): void {
  if (globalThis.__remoteRpcIdleSweeper) return;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of new Set(remoteSessions.values())) {
      if (now - session.lastActivityAt < REMOTE_SESSION_IDLE_TIMEOUT_MS) continue;
      closeRemoteRpcSession(session.sessionId);
    }
  }, REMOTE_SESSION_SWEEP_INTERVAL_MS);
  timer.unref?.();
  globalThis.__remoteRpcIdleSweeper = timer;
}

export interface CreateRemoteRpcSessionOptions {
  deviceId: string;
  cwd?: string;
  sessionDir?: string;
  resumeSession?: string;
  /** Model to select once the remote pi is up. */
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  toolNames?: string[];
}

/**
 * Spawn (or resume) a remote `pi --mode rpc` and wait until it reports state.
 *
 * pi may still be booting when the channel opens, so `get_state` is sent
 * immediately and retried every 500 ms (up to 10 times) instead of sleeping a
 * fixed 400 ms and hoping. The requested model / thinking level / tool list is
 * applied once state is known, and the returned `data` is a fresh `get_state`
 * taken after those overrides landed.
 */
export async function createRemoteRpcSession(options: CreateRemoteRpcSessionOptions): Promise<{
  sessionId: string;
  session: RemoteRpcSession;
  data: any;
}> {
  const {
    deviceId,
    // Default to the device's own home: macOS answers `/Users/<name>` and has no
    // `/root`, so a hardcoded default pointed the spawn at a missing directory.
    cwd = await deviceHomeOrDefault(deviceId),
    sessionDir,
    resumeSession,
    model,
    thinkingLevel,
    toolNames,
  } = options;
  const gateway = getGateway();
  const driver = await gateway.getOrConnectDriver(deviceId);

  // Free a slot before spawning: the cap exists so a small device never runs out
  // of memory and starts hanging new SSH channels.
  enforceDeviceSessionCap(deviceId);

  const channel = await driver.spawnPiRpc({ cwd, sessionDir, resumeSession });
  const listeners = new Set<(msg: any) => void>();

  let resolvedSessionId = "";
  let initialState: any = null;
  let settled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  const sessionObj: RemoteRpcSession = {
    sessionId: "",
    deviceId,
    channel,
    state: null,
    listeners,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    pendingUiRequestIds: new Set<string>(),
    runActive: false,
  };

  let resolveInit: (value: { sessionId: string; data: any }) => void = () => {};
  let rejectInit: (error: Error) => void = () => {};

  const initPromise = new Promise<{ sessionId: string; data: any }>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });

  const overallTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (retryTimer) clearTimeout(retryTimer);
    try {
      channel.close();
    } catch {
      /* channel already gone */
    }
    rejectInit(new Error("Timeout waiting for remote pi rpc state"));
  }, REMOTE_INIT_TIMEOUT_MS);
  overallTimeout.unref?.();

  const finishInit = () => {
    if (settled) return;
    settled = true;
    clearTimeout(overallTimeout);
    if (retryTimer) clearTimeout(retryTimer);
    resolveInit({ sessionId: resolvedSessionId, data: initialState });
  };

  const requestState = () => {
    if (settled) return;
    attempts += 1;
    channel.send({ type: "get_state" });
    if (attempts < REMOTE_INIT_MAX_ATTEMPTS) {
      retryTimer = setTimeout(requestState, REMOTE_INIT_RETRY_INTERVAL_MS);
    }
  };

  // Single fan-out: activity tracking, init detection, then every listener.
  channel.onMessage((msg) => {
    sessionObj.lastActivityAt = Date.now();
    trackRemoteRunState(sessionObj, msg);

    if (!settled && msg?.type === "response" && msg.command === "get_state" && msg.success) {
      resolvedSessionId = msg.data?.sessionId || `remote-${Date.now()}`;
      initialState = msg.data;
      sessionObj.sessionId = resolvedSessionId;
      sessionObj.state = initialState;
      remoteSessions.set(resolvedSessionId, sessionObj);
      finishInit();
    }

    for (const listener of listeners) {
      try {
        listener(msg);
      } catch (err) {
        console.error("[RemoteRpcSession] listener error:", err);
      }
    }
  });

  channel.onError((err) => {
    console.log("[RemoteRpcSession] onError:", err.message);
    if (settled) return;
    settled = true;
    clearTimeout(overallTimeout);
    if (retryTimer) clearTimeout(retryTimer);
    rejectInit(err);
  });

  channel.onClose((code) => {
    console.log("[RemoteRpcSession] onClose:", code);
    if (resolvedSessionId) removeRemoteSession(resolvedSessionId);
  });

  ensureIdleSweeper();
  requestState();

  await initPromise;

  // Apply the caller's overrides in a fixed order so a resumed session ends up
  // in the state the request asked for.
  if (model) {
    await requestOnChannel(channel, {
      type: "set_model",
      provider: model.provider,
      modelId: model.modelId,
    });
  }
  if (thinkingLevel) {
    await requestOnChannel(channel, { type: "set_thinking_level", level: thinkingLevel });
  }
  if (toolNames) {
    // pi's RPC mode has no `set_tools` (rpc-mode.js answers `Unknown command:
    // set_tools`), so the loadout is recorded on the session for
    // /api/agent/[id]'s set_tools branch. It is still sent fire-and-forget for
    // forward compatibility with a pi build that grows the command; the reply is
    // not awaited so an unknown-command error cannot delay session creation.
    sessionObj.pendingToolNames = [...toolNames];
    channel.send({ type: "set_tools", toolNames: [...toolNames] });
  }

  // Refresh state so the returned model / thinking level reflect the overrides.
  const refreshed = await requestOnChannel(channel, { type: "get_state" });
  if (refreshed?.success && refreshed.data) {
    sessionObj.state = refreshed.data;
  }

  return { sessionId: resolvedSessionId, session: sessionObj, data: sessionObj.state ?? initialState };
}

/** Drop every map key that points at this session (resumed sessions are aliased). */
function removeRemoteSession(sessionId: string): void {
  const session = remoteSessions.get(sessionId);
  if (!session) return;
  for (const [key, value] of [...remoteSessions.entries()]) {
    if (value === session) remoteSessions.delete(key);
  }
}

export function getRemoteRpcSession(sessionId: string): RemoteRpcSession | undefined {
  return remoteSessions.get(sessionId);
}

/**
 * Current state of a live remote session, refreshed over the channel.
 *
 * Falls back to the cached snapshot when pi does not answer in time, which is
 * what `?systemPrompt=0` status polling and the reconcile loop can live with.
 */
export async function getRemoteRpcSessionState(sessionId: string): Promise<any | undefined> {
  const session = remoteSessions.get(sessionId);
  if (!session) return undefined;
  const response = await requestOnChannel(session.channel, { type: "get_state" });
  if (response?.success && response.data) {
    // `isStreaming` comes from our own event tracking, not from the reply: a
    // `get_state` taken while a turn is starting reports false, and overwriting
    // the flag here made the sidebar drop the spinner mid-run.
    session.state = { ...response.data, isStreaming: isRemoteSessionRunning(session) };
  }
  return session.state;
}

export function closeRemoteRpcSession(sessionId: string): boolean {
  const session = remoteSessions.get(sessionId);
  if (!session) return false;
  try {
    session.channel.close();
  } catch {
    /* channel already closed */
  }
  removeRemoteSession(sessionId);
  return true;
}

export function getAllRemoteRpcSessions(): RemoteRpcSession[] {
  return [...new Set(remoteSessions.values())];
}

/**
 * Remote sessions on this device with a live `pi` process, running or idle.
 *
 * Deletion needs this list rather than the running one: an idle process still
 * rewrites its transcript, so it has to be closed before the file is unlinked.
 */
export function getRemoteRpcSessionIdsForDevice(deviceId: string): string[] {
  return getAllRemoteRpcSessions()
    .filter((session) => session.deviceId === deviceId)
    .map((session) => session.sessionId);
}

/**
 * Remote sessions on this device that are actually running a turn.
 *
 * Not the same as "has a live channel": every session the user has opened keeps
 * a `pi` process (that is what makes reopening it instant), so listing all of
 * them made idle sessions show the running spinner forever. Same rule as the
 * local `isRunning()`: a run is in flight, or a blocking dialog is unanswered.
 */
export function getRunningRemoteRpcSessionIdsForDevice(deviceId: string): string[] {
  return getAllRemoteRpcSessions()
    .filter((session) => session.deviceId === deviceId && isRemoteSessionRunning(session))
    .map((session) => session.sessionId);
}

/** Remote sessions on this device parked on an unanswered extension dialog. */
export function getAwaitingInputRemoteRpcSessionIdsForDevice(deviceId: string): string[] {
  return getAllRemoteRpcSessions()
    .filter((session) => session.deviceId === deviceId && session.pendingUiRequestIds.size > 0)
    .map((session) => session.sessionId);
}

export function isRemoteSessionRunning(session: RemoteRpcSession): boolean {
  if (session.pendingUiRequestIds.size > 0) return true;
  return session.runActive;
}

/**
 * Forget an answered dialog.
 *
 * The answer travels client -> pi, so it never shows up on the channel this
 * process reads; without this the session would stay "awaiting input" until the
 * turn ended.
 */
export function clearRemotePendingUiRequest(sessionId: string, requestId: unknown): void {
  if (typeof requestId !== "string") return;
  remoteSessions.get(sessionId)?.pendingUiRequestIds.delete(requestId);
}

/**
 * Resume a persisted remote session that is not running in this process.
 *
 * The transcript is located on the device first, so an unknown id 404s instead
 * of spawning a brand-new pi. Read-only use of the remote catalogue.
 */
export async function ensureRemoteRpcSessionForExisting(
  deviceId: string,
  sessionId: string,
): Promise<RemoteRpcSession | undefined> {
  const existing = remoteSessions.get(sessionId);
  if (existing) return existing;

  // Opening one session fires several requests at once (the SSE stream, the
  // status poll, the state read). Each would otherwise spawn its own remote
  // `pi --mode rpc` for the same transcript: the losers of that race pay a full
  // SSH channel setup and can still be mid-handshake when the winner answers,
  // and a slow one surfaced as a spurious 404. One in-flight resume per session.
  const key = `${deviceId}:${sessionId}`;
  const inFlight = resumeFlights.get(key);
  if (inFlight) return inFlight;

  const flight = (async () => {
    const { findRemoteSessionFile } = await import("@/lib/remote-session-store");
    const file = await findRemoteSessionFile(deviceId, sessionId);
    if (!file) return undefined;

    const normalizedCwd = file.cwd ? file.cwd.replace(/\\/g, "/") : await deviceHomeOrDefault(deviceId);
    const created = await createRemoteRpcSession({
      deviceId,
      cwd: normalizedCwd,
      resumeSession: file.path,
    });
    // pi reports the persisted session's own id; alias the requested id too so
    // callers that only know the catalogue id find the same channel.
    remoteSessions.set(sessionId, created.session);
    return created.session;
  })().finally(() => {
    resumeFlights.delete(key);
  });

  resumeFlights.set(key, flight);
  return flight;
}
