import { parseMeshTarget, resolveProjectPath } from "./mesh-target";
import { getSessionAlias } from "./mesh-config";
import { getDeviceRuntime } from "../device-runtime/registry";
import type { IActiveSession } from "../device-runtime/types";
import { getCanonicalHostId, isLocalHostId } from "./host-identity";
import { randomUUID } from "crypto";

export type MeshDeliveryMode = "realtime" | "steer" | "followup" | "silent";

export const MODE_PROMPTS: Record<MeshDeliveryMode, string> = {
  realtime:
    'Sender is blocked waiting for your reply. Sender unblocks on receiving any message or on timeout. You MUST reply by calling send_session_message tool to "{replyTarget}", do NOT just output text',
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

function makePendingReplyKey(deviceId: string, sessionId: string): string {
  return `${deviceId.toLowerCase()}:${sessionId}`;
}

/**
 * Manually cancel a pending realtime wait for a given session or device.
 */
export function cancelRealtimeWait(sessionId?: string, deviceId?: string): boolean {
  let hit = false;
  for (const [key, entry] of pendingReplies.entries()) {
    const matchesSession = !sessionId
      || key.includes(sessionId)
      || entry.senderSessionId.includes(sessionId)
      || entry.targetSessionId.includes(sessionId);
    const matchesDevice = !deviceId
      || key.startsWith(deviceId.toLowerCase())
      || entry.senderDeviceId.toLowerCase() === deviceId.toLowerCase();

    if (matchesSession && matchesDevice) {
      pendingReplies.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      entry.cleanup?.();
      entry.resolve("Realtime wait stopped by user.");
      hit = true;
    }
  }
  return hit;
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
    // 1. Destination match: this message is explicitly addressed to the waiting sender session
    if (
      (resolvedSessionId && key === makePendingReplyKey(deviceTarget, resolvedSessionId)) ||
      (sessionTarget && entry.senderSessionId && (
        entry.senderSessionId === sessionTarget ||
        entry.senderSessionId.startsWith(sessionTarget) ||
        sessionTarget.startsWith(entry.senderSessionId)
      ) && entry.senderDeviceId.toLowerCase() === deviceTarget.toLowerCase())
    ) {
      matched = true;
    }
    // 2. Origin match: this message originates from the session that the waiting entry was expecting a reply from
    else if (
      callerDev &&
      callerSess &&
      entry.targetDeviceId.toLowerCase() === callerDev.toLowerCase() &&
      entry.senderDeviceId.toLowerCase() === deviceTarget.toLowerCase() &&
      (entry.targetSessionId === callerSess || entry.targetSessionId.startsWith(callerSess) || callerSess.startsWith(entry.targetSessionId))
    ) {
      matched = true;
    }
    // 3. Device-pair fallback: a message is arriving from the target host back to the waiting host!
    else if (
      callerDev &&
      entry.targetDeviceId.toLowerCase() === callerDev.toLowerCase() &&
      entry.senderDeviceId.toLowerCase() === deviceTarget.toLowerCase()
    ) {
      matched = true;
    }

    if (matched) {
      pendingReplies.delete(key);
      entry.cleanup?.();
      entry.resolve(message);
      isReplyToPending = true;
      resolvedSessionId = entry.senderSessionId;
      break;
    }
  }

  // c. CORE ANTI-DEADLOCK & DEDUPLICATION RULE (Scenario B):
  // If this message was a reply that resolved an active pending wait on the peer,
  // deliver directly via entry.resolve and return immediately!
  // Do NOT inject a duplicate prompt into the target session.
  if (isReplyToPending) {
    if (earlyWaitKey) pendingReplies.delete(earlyWaitKey);
    if (earlyTimer) clearTimeout(earlyTimer);
    return {
      success: true,
      targetDeviceId: deviceTarget,
      targetSessionId: resolvedSessionId || sessionTarget || "unknown",
      createdNewSession: false,
      mode,
      reply: "Delivered reply to waiting peer session.",
    };
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
    if (mode === "realtime" || mode === "steer") {
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

  // f. Realtime mode reply wait (resolved exclusively by peer calling send_session_message)
  if (mode === "realtime" && senderSessionId && earlyWaitPromise) {
    const replyText = await earlyWaitPromise;

    // Fallback prompt injection:
    // When called from a tool context (isToolCall !== false), the reply is returned directly
    // as the tool execution result (toolResult) to the model. We must NOT inject a duplicate
    // prompt into senderActive!
    // Only in non-tool contexts (isToolCall === false) where there is no tool call awaiting
    // the result do we deliver a fallback prompt.
    const isToolCall = options.senderContext?.isToolCall ?? true;
    if (!isToolCall && replyText && !replyText.startsWith("Timeout:") && !replyText.startsWith("Realtime wait stopped") && !replyText.startsWith("Delivered reply")) {
      const fromPeer = resolvedSessionId ? `${resolvedSessionId}.${deviceTarget}` : deviceTarget;
      const inboundMsg = `[From ${fromPeer}][mode: realtime]:\n${replyText}`;
      try {
        const senderRuntime = await getDeviceRuntime(senderDeviceId);
        const senderActive = await senderRuntime.getActiveSession(senderSessionId);
        if (senderActive && senderActive.isAlive()) {
          await senderActive.send({
            type: "prompt",
            message: inboundMsg,
            streamingBehavior: "followUp",
          });
        }
      } catch (_) {}
    }

    return {
      success: true,
      targetDeviceId: deviceTarget,
      targetSessionId: resolvedSessionId || "unknown",
      createdNewSession: isNewSession,
      mode,
      reply: replyText,
    };
  }

  return {
    success: true,
    targetDeviceId: deviceTarget,
    targetSessionId: resolvedSessionId || "unknown",
    createdNewSession: isNewSession,
    mode,
  };
}
