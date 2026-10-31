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

function makePendingReplyKey(deviceId: string, sessionId: string): string {
  return `${deviceId.toLowerCase()}:${sessionId}`;
}

/**
 * Manually cancel a pending realtime wait for a given session.
 */
export function cancelRealtimeWait(sessionId: string, deviceId?: string): boolean {
  for (const [key, entry] of pendingReplies.entries()) {
    if (key.includes(sessionId) && (!deviceId || key.startsWith(deviceId.toLowerCase()))) {
      pendingReplies.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      entry.cleanup?.();
      entry.resolve("Realtime wait stopped by user.");
      return true;
    }
  }
  return false;
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

  // Intercept reply: match by destination session key, OR if the current sender was targeted by an active realtime wait!
  const callerDev = options.senderContext?.deviceId ? (isLocalHostId(options.senderContext.deviceId) ? canonicalLocal : options.senderContext.deviceId) : undefined;
  const callerSess = options.senderContext?.sessionId;

  for (const [key, entry] of pendingReplies.entries()) {
    let matched = false;
    // 1. Exact match on target session + device
    if (resolvedSessionId && key === makePendingReplyKey(deviceTarget, resolvedSessionId)) {
      matched = true;
    }
    // 2. Caller match: this message is originating from the target session of an active wait
    else if (
      callerSess &&
      callerDev &&
      entry.targetDeviceId.toLowerCase() === callerDev.toLowerCase() &&
      (entry.targetSessionId === callerSess || entry.targetSessionId.startsWith(callerSess) || callerSess.startsWith(entry.targetSessionId)) &&
      entry.senderDeviceId.toLowerCase() === deviceTarget.toLowerCase()
    ) {
      matched = true;
    }

    if (matched) {
      pendingReplies.delete(key);
      entry.cleanup?.();
      entry.resolve(message);
      break;
    }
  }

  // 3. Sender context and reply prompt formatting
  const rawSenderDev = options.senderContext?.deviceId || options.currentDeviceId || canonicalLocal;
  const senderDeviceId = isLocalHostId(rawSenderDev) ? canonicalLocal : rawSenderDev;
  const senderSessionId = options.senderContext?.sessionId;

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
      created.session.channel.send({
        type: "prompt",
        message: fullMessage,
      });
      resolvedSessionId = newSessionId;
    } else {
      const tempKey = `__new__mesh_${randomUUID()}`;
      const { session, realSessionId } = await startRpcSession(tempKey, "", resolvedCwd);
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

  // If in realtime mode and sender has a session id, block until recipient replies or 300s timeout
  if (mode === "realtime" && senderSessionId) {
    const myWaitKey = makePendingReplyKey(senderDeviceId, senderSessionId);
    const replyText = await new Promise<string>(async (resolve) => {
      let settled = false;
      let cleanupListener: (() => void) | undefined;

      const triggerResolve = (msg: string) => {
        if (settled) return;
        settled = true;
        pendingReplies.delete(myWaitKey);
        if (timer) clearTimeout(timer);
        cleanupListener?.();
        resolve(msg);
      };

      const timer = setTimeout(() => {
        triggerResolve("Timeout: Target session did not reply within 300s. The message was delivered, but no response was received.");
      }, 300_000);
      timer.unref?.();

      pendingReplies.set(myWaitKey, {
        senderDeviceId,
        senderSessionId,
        targetDeviceId: deviceTarget,
        targetSessionId: resolvedSessionId || "",
        resolve: (text) => triggerResolve(text),
        timer,
        cleanup: () => cleanupListener?.(),
      });

      // Hook into target session events: ANY assistant message or turn completion resolves the wait
      try {
        if (isTargetLocal) {
          const { getRpcSession } = await import("../rpc-manager");
          const targetSession = getRpcSession(resolvedSessionId);
          if (targetSession) {
            cleanupListener = targetSession.onEvent((event: any) => {
              if (event?.type === "message_end" && event.message?.role === "assistant") {
                const content = typeof event.message.content === "string"
                  ? event.message.content
                  : Array.isArray(event.message.content)
                  ? event.message.content.map((c: any) => c.text || "").join(String.fromCharCode(10))
                  : "";
                if (content.trim()) triggerResolve(content.trim());
              } else if (event?.type === "agent_end") {
                triggerResolve("[Target session finished turn]");
              }
            });
          }
        } else {
          const { getRemoteRpcSession } = await import("../remote-agent-manager");
          const remoteSession = getRemoteRpcSession(resolvedSessionId);
          if (remoteSession) {
            const listener = (msg: any) => {
              if (msg?.type === "event" && msg.event?.type === "message_end" && msg.event.message?.role === "assistant") {
                const content = typeof msg.event.message.content === "string"
                  ? msg.event.message.content
                  : Array.isArray(msg.event.message.content)
                  ? msg.event.message.content.map((c: any) => c.text || "").join(String.fromCharCode(10))
                  : "";
                if (content.trim()) triggerResolve(content.trim());
              } else if (msg?.type === "event" && msg.event?.type === "agent_end") {
                triggerResolve("[Target session finished turn]");
              }
            };
            remoteSession.listeners.add(listener);
            cleanupListener = () => { remoteSession.listeners.delete(listener); };
          }
        }
      } catch (_) {
        // Fall back to sendMeshMessage reply interception
      }
    });

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
