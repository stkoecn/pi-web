import { parseMeshTarget, resolveProjectPath } from "./mesh-target";
import { getSessionAlias } from "./mesh-config";
import { getGateway } from "./singleton";
import { isRemoteDevice, LOCAL_DEVICE_ID } from "../device-context";
import { getCanonicalHostId, isLocalHostId } from "./host-identity";
import { getRpcSession, startRpcSession } from "../rpc-manager";
import { resolveSessionPath, listAllSessions } from "../session-reader";
import { randomUUID } from "crypto";

export type MeshDeliveryMode = "realtime" | "steer" | "followup" | "silent";

export const MODE_PROMPTS: Record<MeshDeliveryMode, string> = {
  realtime: "Waiting for a reply, please process it as soon as possible",
  steer: "Please process and reply first",
  followup: "Please process and reply after processing the previous tasks",
  silent: "Notify only, no reply required",
};

export interface SendMeshMessageOptions {
  target: string; // e.g. "coder@pi-web.wshome" or "@pi-web.wshome"
  message: string;
  mode?: MeshDeliveryMode;
  currentDeviceId?: string;
  senderContext?: {
    deviceId?: string;
    sessionId?: string;
    cwd?: string;
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

function extractTextFromAssistantMessage(message: any): string | null {
  if (!message || message.role !== "assistant") return null;
  const texts = (message.content ?? [])
    .filter((b: any) => b.type === "text" && typeof b.text === "string" && b.text.trim())
    .map((b: any) => b.text);
  return texts.length > 0 ? texts.join(String.fromCharCode(10)) : null;
}

function makePendingReplyKey(deviceId: string, sessionId: string): string {
  return `${deviceId.toLowerCase()}:${sessionId}`;
}

/**
 * Manually cancel a pending realtime wait for a given session.
 */
export function cancelRealtimeWait(sessionId?: string, deviceId?: string): boolean {
  let hit = false;
  let isReplyToPending = false;
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
 * Global router to dispatch messages across sessions and hosts.
 */
export async function sendMeshMessage(options: SendMeshMessageOptions): Promise<SendMeshMessageResult> {
  const canonicalLocal = getCanonicalHostId();
  const currentDev = options.currentDeviceId ? (isLocalHostId(options.currentDeviceId) ? canonicalLocal : options.currentDeviceId) : canonicalLocal;
  const { target, message, mode = "realtime", currentDeviceId = currentDev } = options;

  const parsed = parseMeshTarget(target, currentDeviceId);
  if (!parsed) {
    throw new Error(`Invalid mesh target format: "${target}". Expected [session]@[project].[host] or @[project].[host]`);
  }

  const { deviceTarget: rawDeviceTarget, projectTarget, sessionTarget, isNewSession } = parsed;
  const isTargetLocal = isLocalHostId(rawDeviceTarget);
  const deviceTarget = isTargetLocal ? canonicalLocal : rawDeviceTarget;

  // Self-targeting loop prevention: reject if targeting own session on same device
  const senderDev = options.senderContext?.deviceId ? (isLocalHostId(options.senderContext.deviceId) ? canonicalLocal : options.senderContext.deviceId) : undefined;
  const senderSessionId = options.senderContext?.sessionId;
  const senderDeviceId = senderDev || canonicalLocal;

  // Early registration: register pendingReplies entry immediately (at 0ms) so cancelRealtimeWait
  // can cancel the wait even if the user clicks "stop" while session startup or network dispatch is still running.
  let earlyWaitPromise: Promise<string> | undefined;
  let earlyTriggerResolve: ((msg: string) => void) | undefined;
  let earlyWaitKey: string | undefined;
  let earlyTargetCleanup: (() => void) | undefined;
  let earlyTimer: NodeJS.Timeout | undefined;
  let isEarlySettled = false;

  if (mode === "realtime" && senderSessionId) {
    earlyWaitKey = makePendingReplyKey(senderDeviceId, senderSessionId!);
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
        senderSessionId: senderSessionId!,
        targetDeviceId: deviceTarget,
        targetSessionId: sessionTarget || "",
        resolve: triggerResolve,
        timer: earlyTimer,
      });
    });
  }
  if (
    senderDev &&
    options.senderContext?.sessionId &&
    senderDev === deviceTarget &&
    sessionTarget &&
    (options.senderContext.sessionId === sessionTarget || options.senderContext.sessionId.startsWith(sessionTarget))
  ) {
    throw new Error(`Self-targeting loop prevented: cannot send mesh message to the current session itself (${sessionTarget}.${deviceTarget})`);
  }

  // 1. Ensure target device is dialed / alive if remote
  if (!isTargetLocal) {
    const gateway = getGateway();
    await gateway.connectForSelection(deviceTarget).catch(() => {});
  }

  // 2. Discover known projects and sessions on target device
  let resolvedCwd = projectTarget || "";
  let targetSessions: Array<{ id: string; cwd?: string }> = [];

  if (!isTargetLocal) {
    const { listRemoteSessions } = await import("../remote-session-store");
    targetSessions = (await listRemoteSessions(deviceTarget).catch(() => [])) as Array<{ id: string; cwd?: string }>;
  } else {
    targetSessions = (await listAllSessions().catch(() => [])) as Array<{ id: string; cwd?: string }>;
  }

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

  // 3. Resolve target sessionId
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

  // Intercept reply: match by destination session key, OR if the current sender was targeted by an active realtime wait!
  const callerDev = options.senderContext?.deviceId ? (isLocalHostId(options.senderContext.deviceId) ? canonicalLocal : options.senderContext.deviceId) : undefined;
  const callerSess = options.senderContext?.sessionId;
  let isReplyToPending = false;

  for (const [key, entry] of pendingReplies.entries()) {
    let matched = false;
    // 1. Destination match: this message is sent to the session that is waiting for a reply
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
    // 2. Origin match: this message is originating from the target session (or target device) that was asked to reply
    else if (
      callerDev &&
      entry.targetDeviceId.toLowerCase() === callerDev.toLowerCase() &&
      entry.senderDeviceId.toLowerCase() === deviceTarget.toLowerCase() &&
      (!callerSess || !entry.targetSessionId || entry.targetSessionId === callerSess || entry.targetSessionId.startsWith(callerSess) || callerSess.startsWith(entry.targetSessionId))
    ) {
      matched = true;
    }
    // 3. Host-level fallback: if only one wait is active between these two devices
    else if (
      entry.senderDeviceId.toLowerCase() === deviceTarget.toLowerCase() &&
      callerDev &&
      entry.targetDeviceId.toLowerCase() === callerDev.toLowerCase()
    ) {
      matched = true;
    }

    if (matched) {
      pendingReplies.delete(key);
      entry.cleanup?.();
      entry.resolve(message);
      isReplyToPending = true;
      break;
    }
  }

  // 3. Sender context and reply prompt formatting

  // Format reply instruction depending on whether target is local or remote
  const replyTarget = senderSessionId ? `${senderSessionId}.${senderDeviceId}` : senderDeviceId;
  
  // Notice instruction: simple and clean header. Both local and remote sessions have `send_session_message` tool injected!
  const modeHint = MODE_PROMPTS[mode] || MODE_PROMPTS.realtime;
  const senderTag = `[From ${replyTarget}][mode: ${mode}][${modeHint}][reply by using send_session_message]:
`;
  const fullMessage = `${senderTag}${message}`;

  // 4. Case A: Target is a brand-new session
  if (!resolvedSessionId || isNewSession) {
    if (!isTargetLocal) {
      const { createRemoteRpcSession } = await import("../remote-agent-manager");
      const created = await createRemoteRpcSession({
        deviceId: deviceTarget,
        cwd: resolvedCwd,
      });
      const newSessionId = created.sessionId || created.session.sessionId || "unknown";
      if (earlyTriggerResolve) {
        const handler = (event: any) => {
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const replyText = extractTextFromAssistantMessage(event.message);
            if (replyText) earlyTriggerResolve?.(replyText);
          } else if (event.type === "agent_end") {
            earlyTriggerResolve?.("Recipient session completed turn.");
          }
        };
        created.session.listeners.add(handler);
        earlyTargetCleanup = () => created.session.listeners.delete(handler);
      }
      created.session.channel.send({
        type: "prompt",
        message: fullMessage,
      });
      resolvedSessionId = newSessionId;
    } else {
      const tempKey = `__new__mesh_${randomUUID()}`;
      const { session, realSessionId } = await startRpcSession(tempKey, "", resolvedCwd);
      if (earlyTriggerResolve) {
        const off = session.onEvent((event: any) => {
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const replyText = extractTextFromAssistantMessage(event.message);
            if (replyText) earlyTriggerResolve?.(replyText);
          } else if (event.type === "agent_end") {
            earlyTriggerResolve?.("Recipient session completed turn.");
          }
        });
        earlyTargetCleanup = () => off();
      }
      await session.send({
        type: "prompt",
        message: fullMessage,
      });
      return {
        success: true,
        targetDeviceId: canonicalLocal,
        targetSessionId: realSessionId || session.sessionId,
        createdNewSession: true,
        mode,
      };
    }
  }

  // 5. Case B: Target is an existing session
  if (!isTargetLocal) {
    // Ensure remote host driver is connected before attempting session RPC
    const gateway = (await import("./singleton")).getGateway();
    await gateway.getDriverForRequest(deviceTarget);

    const { getRemoteRpcSession, ensureRemoteRpcSessionForExisting } = await import("../remote-agent-manager");
    let remote = getRemoteRpcSession(resolvedSessionId);
    if (!remote) {
      remote = await ensureRemoteRpcSessionForExisting(deviceTarget, resolvedSessionId);
    }
    if (!remote) {
      throw new Error(`Target remote session "${resolvedSessionId}" could not be opened on device "${deviceTarget}"`);
    }

    if (earlyTriggerResolve) {
      const handler = (event: any) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const replyText = extractTextFromAssistantMessage(event.message);
          if (replyText) earlyTriggerResolve?.(replyText);
        } else if (event.type === "agent_end") {
          earlyTriggerResolve?.("Recipient session completed turn.");
        }
      };
      remote.listeners.add(handler);
      earlyTargetCleanup = () => remote.listeners.delete(handler);
    }

    if (mode === "realtime" || mode === "steer") {
      remote.channel.send({
        type: "prompt",
        message: fullMessage,
        streamingBehavior: "steer",
      });
    } else if (mode === "silent") {
      remote.channel.send({
        type: "follow_up",
        message: fullMessage,
      });
    } else {
      // Always specify streamingBehavior: "followUp" so that even if the session is currently streaming
      // or in the middle of a tool call / thinking, pi will gracefully queue the message instead of throwing
      // "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
      remote.channel.send({
        type: "prompt",
        message: fullMessage,
        streamingBehavior: "followUp",
      });
    }

    // Continue to realtime wait check below
  } else {
    // Local session
    let existing = getRpcSession(resolvedSessionId);
    if (!existing || !existing.isAlive()) {
      const filePath = await resolveSessionPath(resolvedSessionId);
      if (!filePath) {
        throw new Error(`Target local session "${resolvedSessionId}" not found`);
      }
      const started = await startRpcSession(resolvedSessionId, filePath, undefined);
      existing = started.session;
    }

    if (earlyTriggerResolve) {
      const off = existing.onEvent((event: any) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const replyText = extractTextFromAssistantMessage(event.message);
          if (replyText) earlyTriggerResolve?.(replyText);
        } else if (event.type === "agent_end") {
          earlyTriggerResolve?.("Recipient session completed turn.");
        }
      });
      earlyTargetCleanup = () => off();
    }

    if (mode === "realtime" || mode === "steer") {
      await existing.send({
        type: "prompt",
        message: fullMessage,
        streamingBehavior: "steer",
      });
    } else if (mode === "silent") {
      if (existing.inner.isStreaming) {
        await existing.send({
          type: "follow_up",
          message: fullMessage,
        });
      } else {
        await existing.send({
          type: "prompt",
          message: fullMessage,
        });
      }
    } else {
      // Default: followup mode
      // Always specify streamingBehavior: "followUp" to prevent rejection if agent is processing
      await existing.send({
        type: "prompt",
        message: fullMessage,
        streamingBehavior: "followUp",
      });
    }

    // Case B local finished
  }

  // If this message was a direct reply that resolved an active wait on the recipient,
  // do NOT make the sender wait again! Deliver immediately and return.
  if (isReplyToPending) {
    if (earlyWaitKey) pendingReplies.delete(earlyWaitKey);
    if (earlyTimer) clearTimeout(earlyTimer);
    earlyTargetCleanup?.();
    return {
      success: true,
      targetDeviceId: deviceTarget,
      targetSessionId: resolvedSessionId || "unknown",
      createdNewSession: isNewSession,
      mode,
      reply: "Delivered reply to waiting peer session.",
    };
  }

  // If in realtime mode and sender has a session id, wait on the early-registered promise
  if (mode === "realtime" && senderSessionId && earlyWaitPromise) {
    // If not already settled by an early cancel, attach listeners to target session
    if (!isEarlySettled) {
      let cleanupListener: (() => void) | undefined;
      const targetSess = resolvedSessionId;

      if (!isTargetLocal) {
        const { getRemoteRpcSession } = await import("../remote-agent-manager");
        const remote = getRemoteRpcSession(targetSess);
        if (remote) {
          const handler = (event: any) => {
            if (event.type === "message_end" && event.message?.role === "assistant") {
              const text = extractTextFromAssistantMessage(event.message);
              if (text && earlyTriggerResolve) earlyTriggerResolve(text);
            } else if (event.type === "agent_end") {
              if (earlyTriggerResolve) earlyTriggerResolve("Agent completed execution.");
            }
          };
          remote.listeners.add(handler);
          cleanupListener = () => remote.listeners.delete(handler);
        }
      } else {
        const existing = getRpcSession(targetSess);
        if (existing) {
          const off = existing.onEvent((event: any) => {
            if (event.type === "message_end" && event.message?.role === "assistant") {
              const text = extractTextFromAssistantMessage(event.message);
              if (text && earlyTriggerResolve) earlyTriggerResolve(text);
            } else if (event.type === "agent_end") {
              if (earlyTriggerResolve) earlyTriggerResolve("Agent completed execution.");
            }
          });
          cleanupListener = () => off();
        }
      }

      // Attach cleanup to the registered entry
      if (earlyWaitKey && pendingReplies.has(earlyWaitKey)) {
        const entry = pendingReplies.get(earlyWaitKey);
        if (entry) entry.cleanup = cleanupListener;
      }
    }

    if (earlyWaitKey && pendingReplies.has(earlyWaitKey)) { const entry = pendingReplies.get(earlyWaitKey); if (entry) entry.cleanup = earlyTargetCleanup; }
    const replyText = await earlyWaitPromise;
    earlyTargetCleanup?.();
    // Deliver the captured reply as an independent incoming message into sender session,
    // so it displays as an independent purple [IN ↙] card on the timeline!
    if (replyText && !replyText.startsWith("Timeout:") && !replyText.startsWith("Realtime wait stopped") && !replyText.startsWith("Delivered reply")) {
      const fromPeer = resolvedSessionId ? `${resolvedSessionId}.${deviceTarget}` : deviceTarget;
      const inboundMsg = `[From ${fromPeer}][mode: realtime]:
${replyText}`;
      try {
        if (isLocalHostId(senderDeviceId)) {
          const localSender = getRpcSession(senderSessionId);
          if (localSender && localSender.isAlive()) {
            await localSender.send({
              type: "prompt",
              message: inboundMsg,
              streamingBehavior: "followUp",
            });
          }
        } else {
          const { getRemoteRpcSession } = await import("../remote-agent-manager");
          const remoteSender = getRemoteRpcSession(senderSessionId);
          if (remoteSender) {
            remoteSender.channel.send({
              type: "prompt",
              message: inboundMsg,
              streamingBehavior: "followUp",
            });
          }
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
