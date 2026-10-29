import { parseMeshTarget, resolveProjectPath } from "./mesh-target";
import { getSessionAlias } from "./mesh-config";
import { getGateway } from "./singleton";
import { isRemoteDevice, LOCAL_DEVICE_ID } from "../device-context";
import { getRpcSession, startRpcSession } from "../rpc-manager";
import { resolveSessionPath, listAllSessions } from "../session-reader";
import { randomUUID } from "crypto";

export interface SendMeshMessageOptions {
  target: string; // e.g. "coder@pi-web.wshome" or "@pi-web.wshome"
  message: string;
  mode?: "followup" | "steer" | "silent";
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
  mode: "followup" | "steer" | "silent";
  error?: string;
}

/**
 * Global router to dispatch messages across sessions and hosts.
 */
export async function sendMeshMessage(options: SendMeshMessageOptions): Promise<SendMeshMessageResult> {
  const { target, message, mode = "followup", currentDeviceId = LOCAL_DEVICE_ID } = options;

  const parsed = parseMeshTarget(target, currentDeviceId);
  if (!parsed) {
    throw new Error(`Invalid mesh target format: "${target}". Expected [session]@[project].[host] or @[project].[host]`);
  }

  const { deviceTarget, projectTarget, sessionTarget, isNewSession } = parsed;

  // Self-targeting loop prevention: reject if targeting own session on same device
  if (
    options.senderContext?.deviceId &&
    options.senderContext?.sessionId &&
    (options.senderContext.deviceId === deviceTarget || (options.senderContext.deviceId === "localhost" && deviceTarget === "localhost")) &&
    sessionTarget &&
    (options.senderContext.sessionId === sessionTarget || options.senderContext.sessionId.startsWith(sessionTarget))
  ) {
    throw new Error(`Self-targeting loop prevented: cannot send mesh message to the current session itself (${sessionTarget}.${deviceTarget})`);
  }

  // 1. Ensure target device is dialed / alive if remote
  if (isRemoteDevice(deviceTarget)) {
    const gateway = getGateway();
    await gateway.connectForSelection(deviceTarget).catch(() => {});
  }

  // 2. Discover known projects and sessions on target device
  let resolvedCwd = projectTarget || "";
  let targetSessions: Array<{ id: string; cwd?: string }> = [];

  if (isRemoteDevice(deviceTarget)) {
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

  // 3. Sender context and reply prompt formatting
  const senderDeviceId = options.senderContext?.deviceId || options.currentDeviceId || "localhost";
  const senderSessionId = options.senderContext?.sessionId;

  // Format: [From 会话ID.主机名][reply by using send_session_message]: message
  const replyTarget = senderSessionId ? `${senderSessionId}.${senderDeviceId}` : senderDeviceId;
  const senderTag = `[From ${replyTarget}][reply by using send_session_message]: `;
  const fullMessage = `${senderTag}${message}`;

  // 4. Case A: Target is a brand-new session
  if (!resolvedSessionId || isNewSession) {
    if (isRemoteDevice(deviceTarget)) {
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
      return {
        success: true,
        targetDeviceId: deviceTarget,
        targetSessionId: newSessionId,
        createdNewSession: true,
        mode,
      };
    } else {
      const tempKey = `__new__mesh_${randomUUID()}`;
      const { session, realSessionId } = await startRpcSession(tempKey, "", resolvedCwd);
      await session.send({
        type: "prompt",
        message: fullMessage,
      });
      return {
        success: true,
        targetDeviceId: LOCAL_DEVICE_ID,
        targetSessionId: realSessionId || session.sessionId,
        createdNewSession: true,
        mode,
      };
    }
  }

  // 5. Case B: Target is an existing session
  if (isRemoteDevice(deviceTarget)) {
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

    if (mode === "steer") {
      remote.channel.send({
        type: "steer",
        message: fullMessage,
      });
    } else if (mode === "silent") {
      remote.channel.send({
        type: "follow_up",
        message: fullMessage,
      });
    } else {
      // If target remote session is currently running, use followUp streaming behavior
      const isRunning = Boolean(remote.state?.isStreaming);
      if (isRunning) {
        remote.channel.send({
          type: "prompt",
          message: fullMessage,
          streamingBehavior: "followUp",
        });
      } else {
        remote.channel.send({
          type: "prompt",
          message: fullMessage,
        });
      }
    }

    return {
      success: true,
      targetDeviceId: deviceTarget,
      targetSessionId: resolvedSessionId,
      createdNewSession: false,
      mode,
    };
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

    if (mode === "steer") {
      // If session is currently running, steer it; otherwise send as regular prompt
      if (existing.inner.isStreaming) {
        await existing.send({
          type: "steer",
          message: fullMessage,
        });
      } else {
        await existing.send({
          type: "prompt",
          message: fullMessage,
        });
      }
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
      // If target session is running, queue it via streamingBehavior: "followUp"
      if (existing.inner.isStreaming) {
        await existing.send({
          type: "prompt",
          message: fullMessage,
          streamingBehavior: "followUp",
        });
      } else {
        await existing.send({
          type: "prompt",
          message: fullMessage,
        });
      }
    }

    return {
      success: true,
      targetDeviceId: LOCAL_DEVICE_ID,
      targetSessionId: resolvedSessionId,
      createdNewSession: false,
      mode,
    };
  }
}
