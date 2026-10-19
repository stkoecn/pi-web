// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.
//
// Both functions take an optional trailing `deviceId`: the id of the gateway
// device the session lives on. It is appended with `withDeviceId`, so a
// `localhost` call keeps the exact URL it always had.

// Relative import: this module is loaded by lib/agent-client.test.mjs through
// jiti without tsconfig path mapping, so `@/lib/...` would not resolve there.
import { withDeviceId } from "./device-context";

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

/**
 * GET /api/agent/[id] without the system prompt, for status reads: the usage read after each
 * reply and on every stream connect, the settle and reconcile polls. None of them shows the
 * prompt, and it is nearly all of the reply (context files, skills, tool notes: hundreds of KB
 * in a large project), fetched again after every model call (#1302).
 */
export function agentStatusUrl(sessionId: string, deviceId?: string): string {
  return withDeviceId(`/api/agent/${encodeURIComponent(sessionId)}?systemPrompt=0`, deviceId);
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  deviceId?: string,
): Promise<T> {
  const url = withDeviceId(`/api/agent/${encodeURIComponent(sessionId)}`, deviceId);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}
