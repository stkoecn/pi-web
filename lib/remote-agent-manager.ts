import { getGateway } from "@/lib/gateway/singleton";
import type { RPCChannel } from "@/lib/gateway/types";

export interface RemoteRpcSession {
  sessionId: string;
  deviceId: string;
  channel: RPCChannel;
  state: any;
  listeners: Set<(msg: any) => void>;
  createdAt: number;
}

declare global {
  var __remoteRpcSessions: Map<string, RemoteRpcSession> | undefined;
}

const remoteSessions: Map<string, RemoteRpcSession> =
  globalThis.__remoteRpcSessions ?? (globalThis.__remoteRpcSessions = new Map());

export async function createRemoteRpcSession(options: {
  deviceId: string;
  cwd?: string;
  sessionDir?: string;
  resumeSession?: string;
}): Promise<{ sessionId: string; session: RemoteRpcSession; data: any }> {
  const { deviceId, cwd = "/root", sessionDir, resumeSession } = options;
  const gateway = getGateway();
  const driver = await gateway.getOrConnectDriver(deviceId);

  const channel = await driver.spawnPiRpc({ cwd, sessionDir, resumeSession });
  const listeners = new Set<(msg: any) => void>();

  let resolvedSessionId = "";
  let initialState: any = null;

  const sessionObj: RemoteRpcSession = {
    sessionId: "",
    deviceId,
    channel,
    state: null,
    listeners,
    createdAt: Date.now(),
  };

  const initPromise = new Promise<{ sessionId: string; data: any }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for remote pi rpc state"));
    }, 15000);

    const cleanup = channel.onMessage((msg) => {
      if (msg.type === "response" && msg.command === "get_state" && msg.success) {
        clearTimeout(timeout);
        resolvedSessionId = msg.data?.sessionId || `remote-${Date.now()}`;
        initialState = msg.data;
        sessionObj.sessionId = resolvedSessionId;
        sessionObj.state = initialState;
        remoteSessions.set(resolvedSessionId, sessionObj);
        resolve({ sessionId: resolvedSessionId, data: initialState });
      }
    });

    channel.onError((err) => {
      console.log('[RemoteRpcSession] onError:', err.message);
      clearTimeout(timeout);
      reject(err);
    });

    channel.onClose((code) => {
      console.log('[RemoteRpcSession] onClose:', code);
      if (resolvedSessionId) {
        remoteSessions.delete(resolvedSessionId);
      }
    });
  });

  channel.onMessage((msg) => {
    for (const listener of listeners) {
      try {
        listener(msg);
      } catch (err) {
        console.error("[RemoteRpcSession] listener error:", err);
      }
    }
  });

  // Wait 400ms for remote node runtime to initialize stdin, then query initial state
  setTimeout(() => {
    channel.send({ type: "get_state" });
  }, 400);

  const res = await initPromise;
  return { sessionId: res.sessionId, session: sessionObj, data: res.data };
}

export function getRemoteRpcSession(sessionId: string): RemoteRpcSession | undefined {
  return remoteSessions.get(sessionId);
}

export function closeRemoteRpcSession(sessionId: string): boolean {
  const session = remoteSessions.get(sessionId);
  if (session) {
    session.channel.close();
    remoteSessions.delete(sessionId);
    return true;
  }
  return false;
}

export function getAllRemoteRpcSessions(): RemoteRpcSession[] {
  return Array.from(remoteSessions.values());
}
