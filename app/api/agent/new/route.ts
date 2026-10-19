import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { getRequestDeviceId, isRemoteDevice, LOCAL_DEVICE_ID } from "@/lib/device-context";
import { deviceHomeOrDefault } from "@/lib/device-home";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    const deviceId = getRequestDeviceId(req) !== LOCAL_DEVICE_ID
      ? getRequestDeviceId(req)
      // `deviceId` in the body is the documented fallback for callers that cannot
      // set a header (curl/scripts/tests); the query param and header win.
      : (typeof command.deviceId === "string" && command.deviceId.trim()
        ? command.deviceId.trim()
        : LOCAL_DEVICE_ID);
    if (isRemoteDevice(deviceId)) {
      const { createRemoteRpcSession } = await import("@/lib/remote-agent-manager");
      const { provider, modelId, toolNames, thinkingLevel, sessionDir, deviceId: _bodyDeviceId, ...promptCommand } = command as {
        provider?: string;
        modelId?: string;
        toolNames?: string[];
        thinkingLevel?: unknown;
        sessionDir?: string;
        deviceId?: string;
        [key: string]: unknown;
      };
      void _bodyDeviceId;
      if ((provider && !modelId) || (!provider && modelId)) {
        throw new Error("provider and modelId must be provided together");
      }
      const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

      // Overrides travel with the spawn so the remote pi boots straight into the
      // requested model / thinking level instead of being re-configured later.
      const { sessionId, session: remoteSession, data } = await createRemoteRpcSession({
        deviceId,
        // No `/root` fallback: macOS devices have no such directory.
        cwd: cwd || await deviceHomeOrDefault(deviceId),
        ...(typeof sessionDir === "string" ? { sessionDir } : {}),
        ...(provider && modelId ? { model: { provider, modelId } } : {}),
        ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
        ...(toolNames ? { toolNames } : {}),
      });

      const modelState = data?.model
        ? { provider: data.model.provider as string, modelId: data.model.id as string }
        : null;
      const thinkingState = data?.thinkingLevel as string | undefined;

      // A brand-new persistent remote session only becomes visible once the
      // catalogue is re-scanned; the sidebar lists it right after creation.
      const { invalidateRemoteSessionCache } = await import("@/lib/remote-session-store");
      invalidateRemoteSessionCache(deviceId);

      if (promptCommand.type !== "ensure_session") {
        // Fire-and-forget: the client learns about progress through the SSE stream.
        remoteSession.channel.send(promptCommand);
        promptAccepted = promptCommand.type === "prompt";
      }

      // Same key set as the local branch so the client reducer needs no branch.
      return NextResponse.json({
        success: true,
        sessionId,
        data: null,
        model: modelState,
        thinkingLevel: thinkingState,
      });
    }

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
    });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}
