import { parseMeshTarget, resolveProjectPath } from "./mesh-target";
import { getSessionAlias } from "./mesh-config";
import { getDeviceRuntime } from "../device-runtime/registry";
import type { IActiveSession } from "../device-runtime/types";
import { getCanonicalHostId, isLocalHostId } from "./host-identity";
import { randomUUID } from "crypto";

export type MeshDeliveryMode = "realtime" | "steer" | "followup" | "silent";

export const MODE_PROMPTS: Record<MeshDeliveryMode, string> = {
  realtime:
    'Sender is blocked waiting for response. Sender unblocks on receiving any message, user action, or on timeout. Reply by calling send_session_message to "{replyTarget}"',
  steer:
    'Sender is NOT blocked. Please prioritize this request and reply by calling send_session_message to "{replyTarget}"',
  followup:
    'Sender is NOT blocked. Process after current work and reply by calling send_session_message to "{replyTarget}"',
  silent:
    "Notification only, do NOT reply",
};

/**
 * Construct the explicit delivery prompt header prepended to cross-session messages.
 * Informs the recipient about sender blocking state and mandatory send_session_message reply protocol.
 */
export function buildMeshPromptHeader(replyTarget: string, mode: MeshDeliveryMode = "realtime"): string {
  const template = MODE_PROMPTS[mode] || MODE_PROMPTS.realtime;
  const prompt = template.replace(/\{replyTarget\}/g, replyTarget);
  return `[From ${replyTarget}][mode: ${mode}][${prompt}]:\n`;
}

export interface SendMeshMessageOptions {
  target: string; // e.g. "coder@pi-web.wshome", "@pi-web.wshome", or "sessionId.wshome"
  message: string;
  mode?: MeshDeliveryMode;
  currentDeviceId?: string;
  senderContext?: {
    deviceId?: string;
    sessionId?: string;
    cwd?: string;
    isToolCall?: boolean;
  };
}

export interface SendMeshMessageResult {
  success: boolean;
  targetDeviceId: string;
  targetSessionId: string;
  createdNewSession: boolean;
  mode: MeshDeliveryMode;
  reply?: string;
  unblockReason?: string;
  error?: string;
}

/** Registry for tracking pending realtime replies awaiting responses across sessions. */
interface PendingReplyEntry {
  senderDeviceId: string;
  senderSessionId: string;
  targetDeviceId: string;
  targetSessionId: string;
  resolve: (reply: string) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
}
const pendingReplies = new Map<string, PendingReplyEntry>();

interface InFlightOrCompletedDispatch {
  timestamp: number;
  promise: Promise<SendMeshMessageResult>;
}
const recentDispatches = new Map<string, InFlightOrCompletedDispatch>();
const DEDUPE_WINDOW_MS = 20_000;

function makePendingReplyKey(deviceId: string, sessionId: string): string {
  return `${deviceId.toLowerCase()}:${sessionId}`;
}

/**
 * Manually cancel a pending realtime wait for a given session or device.
 */
/**
 * Unblock a pending realtime wait for a given session and/or device.
 * Called whenever an incoming message arrives (from user, peer session, or abort).
 */
export function unblockPendingRealtimeWait(
  sessionId?: string,
  deviceId?: string,
  reason = "Unblocked by incoming message."
): boolean {
  let hit = false;
  const canonicalLocal = getCanonicalHostId();
  const targetDev = deviceId ? (isLocalHostId(deviceId) ? canonicalLocal : deviceId) : undefined;

  for (const [key, entry] of pendingReplies.entries()) {
    const sId = sessionId?.toLowerCase().trim();
    const entrySenderSess = entry.senderSessionId?.toLowerCase().trim();
    const entryTargetSess = entry.targetSessionId?.toLowerCase().trim();

    const matchesSession = !sId
      || key.toLowerCase().includes(sId)
      || (entrySenderSess && (entrySenderSess === sId || entrySenderSess.startsWith(sId) || sId.startsWith(entrySenderSess)))
      || (entryTargetSess && (entryTargetSess === sId || entryTargetSess.startsWith(sId) || sId.startsWith(entryTargetSess)));

    const matchesDevice = !targetDev
      || key.toLowerCase().startsWith(targetDev.toLowerCase())
      || entry.senderDeviceId.toLowerCase() === targetDev.toLowerCase()
      || (isLocalHostId(entry.senderDeviceId) && isLocalHostId(targetDev));

    if (matchesSession && matchesDevice) {
      pendingReplies.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      entry.cleanup?.();
      entry.resolve(reason);
      hit = true;
    }
  }
  return hit;
}

export const cancelRealtimeWait = unblockPendingRealtimeWait;

/**
 * Register a pending realtime wait entry for a given session.
 */
export function registerPendingRealtimeWait(
  sessionId: string,
  deviceId?: string,
  onUnblock?: (reason: string) => void,
  timeoutMs = 300_000
): () => void {
  const canonicalLocal = getCanonicalHostId();
  const dev = deviceId ? (isLocalHostId(deviceId) ? canonicalLocal : deviceId) : canonicalLocal;
  const key = makePendingReplyKey(dev, sessionId);

  let timer: NodeJS.Timeout | null = setTimeout(() => {
    pendingReplies.delete(key);
    onUnblock?.("Timeout: Target session did not reply within 300s.");
  }, timeoutMs);
  timer.unref?.();

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingReplies.delete(key);
  };

  pendingReplies.set(key, {
    senderDeviceId: dev,
    senderSessionId: sessionId,
    targetDeviceId: "",
    targetSessionId: "",
    resolve: (reason) => {
      cleanup();
      onUnblock?.(reason);
    },
    timer: timer!,
    cleanup,
  });

  return cleanup;
}

/**
 * Global router to dispatch messages across sessions and hosts using IDeviceRuntime.
 */
export async function sendMeshMessage(options: SendMeshMessageOptions): Promise<SendMeshMessageResult> {
  const canonicalLocal = getCanonicalHostId();
  const currentDev = options.currentDeviceId
    ? (isLocalHostId(options.currentDeviceId) ? canonicalLocal : options.currentDeviceId)
    : canonicalLocal;
  const { target, message, mode = "realtime", currentDeviceId = currentDev } = options;

  const senderDev = options.senderContext?.deviceId
    ? (isLocalHostId(options.senderContext.deviceId) ? canonicalLocal : options.senderContext.deviceId)
    : undefined;
  const senderSessionId = options.senderContext?.sessionId;
  const senderDeviceId = senderDev || canonicalLocal;

  // 20s deduplication window to prevent duplicate dispatch & ghost sessions from retries/replays
  const dedupeKey = `${senderDeviceId}:${senderSessionId || "none"}:${target}:${message.trim()}`;
  const now = Date.now();
  for (const [k, v] of recentDispatches.entries()) {
    if (now - v.timestamp > DEDUPE_WINDOW_MS) {
      recentDispatches.delete(k);
    }
  }

  const existing = recentDispatches.get(dedupeKey);
  if (existing && (now - existing.timestamp <= DEDUPE_WINDOW_MS)) {
    console.warn(`[MeshRouter] Duplicate message detected within 20s from ${senderDeviceId} to ${target}. Deduplicating.`);
    return existing.promise;
  }

  const dispatchPromise = (async () => {

  // a. Parse recipient & sender addresses
  const parsed = parseMeshTarget(target, currentDeviceId);
  if (!parsed) {
    throw new Error(`Invalid mesh target format: "${target}". Expected [session]@[project].[host] or @[project].[host]`);
  }

  const { deviceTarget: rawDeviceTarget, projectTarget, sessionTarget, isNewSession } = parsed;
  const isTargetLocal = isLocalHostId(rawDeviceTarget);
  const deviceTarget = isTargetLocal ? canonicalLocal : rawDeviceTarget;

  const senderDev = options.senderContext?.deviceId
    ? (isLocalHostId(options.senderContext.deviceId) ? canonicalLocal : options.senderContext.deviceId)
    : undefined;
  const senderSessionId = options.senderContext?.sessionId;
  const senderDeviceId = senderDev || canonicalLocal;

  // Self-targeting loop prevention: reject if targeting own session on same device
  if (
    senderDev &&
    senderSessionId &&
    senderDev.toLowerCase() === deviceTarget.toLowerCase() &&
    sessionTarget &&
    (senderSessionId === sessionTarget || senderSessionId.startsWith(sessionTarget))
  ) {
    throw new Error(`Self-targeting loop prevented: cannot send mesh message to the current session itself (${sessionTarget}.${deviceTarget})`);
  }

  // Early registration: register pendingReplies entry immediately (at 0ms) so cancelRealtimeWait
  // can cancel the wait even if session startup or network dispatch is still running.
  let earlyWaitPromise: Promise<string> | undefined;
  let earlyTriggerResolve: ((msg: string) => void) | undefined;
  let earlyWaitKey: string | undefined;
  let earlyTimer: NodeJS.Timeout | undefined;
  let isEarlySettled = false;

  if (mode === "realtime" && senderSessionId) {
    earlyWaitKey = makePendingReplyKey(senderDeviceId, senderSessionId);
    earlyWaitPromise = new Promise<string>((resolve) => {
      const triggerResolve = (msg: string) => {
        if (isEarlySettled) return;
        isEarlySettled = true;
        if (earlyWaitKey) pendingReplies.delete(earlyWaitKey);
        if (earlyTimer) clearTimeout(earlyTimer);
        resolve(msg);
      };

      earlyTriggerResolve = triggerResolve;

      earlyTimer = setTimeout(() => {
        triggerResolve("Timeout: Target session did not reply within 300s. The message was delivered, but no response was received.");
      }, 300_000);
      earlyTimer.unref?.();

      pendingReplies.set(earlyWaitKey!, {
        senderDeviceId,
        senderSessionId,
        targetDeviceId: deviceTarget,
        targetSessionId: sessionTarget || "",
        resolve: triggerResolve,
        timer: earlyTimer,
      });
    });
  }

  // d. Resolve target device runtime
  let targetRuntime;
  try {
    targetRuntime = await getDeviceRuntime(deviceTarget);
  } catch (err) {
    return {
      success: false,
      targetDeviceId: deviceTarget,
      targetSessionId: sessionTarget || "",
      createdNewSession: isNewSession,
      mode,
      error: `Cannot reach target device "${deviceTarget}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Discover known projects and sessions on target device
  let resolvedCwd = projectTarget || "";
  const targetSessions = await targetRuntime.listSessions().catch(() => []);

  // If projectTarget is omitted (e.g. `sess123.wshome`), resolve project from target session
  if (!projectTarget && sessionTarget) {
    const matched = targetSessions.find((s) => s.id === sessionTarget || s.id.startsWith(sessionTarget));
    if (matched && matched.cwd) {
      resolvedCwd = matched.cwd;
    }
  } else if (projectTarget) {
    const knownProjects = Array.from(new Set(targetSessions.map((s) => s.cwd).filter(Boolean) as string[]));
    resolvedCwd = resolveProjectPath(deviceTarget, projectTarget, knownProjects);
  }

  // Resolve target sessionId
  let resolvedSessionId: string | undefined;
  if (!isNewSession && sessionTarget) {
    // Check if sessionTarget is an alias in mesh-config
    resolvedSessionId = getSessionAlias(deviceTarget, resolvedCwd, sessionTarget);
    if (!resolvedSessionId) {
      // Check if sessionTarget matches a sessionId prefix or full id
      const match = targetSessions.find((s) => s.id === sessionTarget || s.id.startsWith(sessionTarget));
      if (match) resolvedSessionId = match.id;
      if (!resolvedSessionId) {
        resolvedSessionId = sessionTarget;
      }
    }
  }

  // Update early registered entry with final resolved targetSessionId
  if (earlyWaitKey && pendingReplies.has(earlyWaitKey) && resolvedSessionId) {
    const entry = pendingReplies.get(earlyWaitKey);
    if (entry) entry.targetSessionId = resolvedSessionId;
  }

  // c. Check and resolve existing pending wait (Core Anti-Deadlock rule)
  // If the incoming message matches a pending reply wait, unlock the waiter immediately!
  const callerDev = options.senderContext?.deviceId
    ? (isLocalHostId(options.senderContext.deviceId) ? canonicalLocal : options.senderContext.deviceId)
    : undefined;
  const callerSess = options.senderContext?.sessionId;
  let isReplyToPending = false;

  for (const [key, entry] of pendingReplies.entries()) {
    // CRITICAL: NEVER match against our own wait entry that was just registered 0ms ago!
    if (earlyWaitKey && key === earlyWaitKey) {
      continue;
    }

    let matched = false;
    const isDeviceTargetMatchingSender =
      entry.senderDeviceId.toLowerCase() === deviceTarget.toLowerCase() ||
      (isLocalHostId(entry.senderDeviceId) && isLocalHostId(deviceTarget));

    // 1. Destination match: this message is explicitly addressed to the waiting sender session
    if (
      isDeviceTargetMatchingSender && (
        (resolvedSessionId && (
          entry.senderSessionId.toLowerCase() === resolvedSessionId.toLowerCase() ||
          entry.senderSessionId.toLowerCase().startsWith(resolvedSessionId.toLowerCase()) ||
          resolvedSessionId.toLowerCase().startsWith(entry.senderSessionId.toLowerCase())
        )) ||
        (sessionTarget && (
          entry.senderSessionId.toLowerCase() === sessionTarget.toLowerCase() ||
          entry.senderSessionId.toLowerCase().startsWith(sessionTarget.toLowerCase()) ||
          sessionTarget.toLowerCase().startsWith(entry.senderSessionId.toLowerCase())
        ))
      )
    ) {
      matched = true;
    }
    // 2. Origin match: this message originates from the session that the waiting entry was expecting a reply from
    else if (
      callerDev &&
      callerSess &&
      (entry.targetDeviceId.toLowerCase() === callerDev.toLowerCase() || (isLocalHostId(entry.targetDeviceId) && isLocalHostId(callerDev))) &&
      isDeviceTargetMatchingSender &&
      (
        entry.targetSessionId.toLowerCase() === callerSess.toLowerCase() ||
        entry.targetSessionId.toLowerCase().startsWith(callerSess.toLowerCase()) ||
        callerSess.toLowerCase().startsWith(entry.targetSessionId.toLowerCase())
      )
    ) {
      matched = true;
    }
    // 3. Device-pair fallback: a message is arriving from the target host back to the waiting host!
    else if (
      callerDev &&
      (entry.targetDeviceId.toLowerCase() === callerDev.toLowerCase() || (isLocalHostId(entry.targetDeviceId) && isLocalHostId(callerDev))) &&
      isDeviceTargetMatchingSender
    ) {
      matched = true;
    }

    if (matched) {
      isReplyToPending = true;
      pendingReplies.delete(key);
      entry.cleanup?.();
      // Unblock the sender's send_session_message tool call with unblock reason, NOT the message body!
      entry.resolve("Unblocked by incoming message.");
      // If current sender also started an early wait, settle it immediately to break mutual lock
      if (earlyTriggerResolve) {
        earlyTriggerResolve("Delivered reply to waiting peer session.");
      }
      break;
    }
  }

  // b. Prompt header injection (realtime, steer, followup, silent)
  const replyTarget = senderSessionId ? `${senderSessionId}.${senderDeviceId}` : senderDeviceId;
  const senderTag = buildMeshPromptHeader(replyTarget, mode);
  const fullMessage = `${senderTag}${message}`;

  let targetActiveSession: IActiveSession | undefined;

  // e. Deliver message via unified runtime & active session
  if (!resolvedSessionId || isNewSession) {
    // Case A: Create brand-new session on target runtime
    const initResult = await targetRuntime.createSession({
      cwd: resolvedCwd,
    });
    resolvedSessionId = initResult.sessionId;
    targetActiveSession = initResult.activeSession || await targetRuntime.getActiveSession(resolvedSessionId);

    if (targetActiveSession) {
      await targetActiveSession.send({
        type: "prompt",
        message: fullMessage,
      });
    } else {
      await targetRuntime.sendPrompt(resolvedSessionId, fullMessage);
    }

    if (earlyWaitKey && pendingReplies.has(earlyWaitKey)) {
      const entry = pendingReplies.get(earlyWaitKey);
      if (entry) entry.targetSessionId = resolvedSessionId;
    }
  } else {
    // Case B: Existing session on target runtime
    targetActiveSession = await targetRuntime.getActiveSession(resolvedSessionId);
    if (!targetActiveSession || !targetActiveSession.isAlive()) {
      targetActiveSession = await targetRuntime.resumeSession(resolvedSessionId, undefined, { cwd: resolvedCwd });
    }

    // Deliver with proper streamingBehavior / type according to delivery mode
    // When this message is a reply to an active waiter (isReplyToPending), always use steer to awaken immediately!
    if (isReplyToPending || mode === "realtime" || mode === "steer") {
      if (targetActiveSession.isRunning()) {
        await targetActiveSession.steer(fullMessage);
      } else {
        await targetActiveSession.send({
          type: "prompt",
          message: fullMessage,
          streamingBehavior: "steer",
        });
      }
    } else if (mode === "silent") {
      if (targetActiveSession.isRunning()) {
        await targetActiveSession.send({
          type: "follow_up",
          message: fullMessage,
        });
      } else {
        await targetActiveSession.send({
          type: "prompt",
          message: fullMessage,
        });
      }
    } else {
      // Default: followup mode
      await targetActiveSession.send({
        type: "prompt",
        message: fullMessage,
        streamingBehavior: "followUp",
      });
    }
  }

  // f. Realtime mode reply wait: blocks sender until interrupted by any message or 300s timeout
  if (mode === "realtime" && senderSessionId && earlyWaitPromise) {
    if (isReplyToPending) {
      return {
        success: true,
        targetDeviceId: deviceTarget,
        targetSessionId: resolvedSessionId || "unknown",
        createdNewSession: isNewSession,
        mode,
        unblockReason: "Delivered reply to waiting peer session.",
      };
    }

    const unblockReason = await earlyWaitPromise;

    return {
      success: true,
      targetDeviceId: deviceTarget,
      targetSessionId: resolvedSessionId || "unknown",
      createdNewSession: isNewSession,
      mode,
      unblockReason: unblockReason || "Unblocked.",
    };
  }

  return {
    success: true,
    targetDeviceId: deviceTarget,
    targetSessionId: resolvedSessionId || "unknown",
    createdNewSession: isNewSession,
    mode,
  };
  })();

  recentDispatches.set(dedupeKey, {
    timestamp: now,
    promise: dispatchPromise,
  });

  dispatchPromise.catch(() => {
    recentDispatches.delete(dedupeKey);
  });

  return dispatchPromise;
}
