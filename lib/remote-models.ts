/**
 * Model catalogue of a *remote* gateway device.
 *
 * `GET /api/models` used to answer with the model list of the machine running
 * pi-web. When the UI is addressed at a gateway device (`?deviceId=<id>`) that
 * list is wrong: the target machine may have entirely different providers,
 * credentials and defaults. So the catalogue is asked from the device's own
 * `pi --mode rpc` instead, over the same channel the session routes use.
 *
 * RPC commands used (see `@earendil-works/pi-coding-agent` rpc-mode):
 *   - `get_available_models`  → `{ models }` — every model whose provider has a
 *     usable credential on that device.
 *   - `get_state`             → `{ model, thinkingLevel, ... }` — the model and
 *     reasoning level a fresh session there starts with.
 *   - `get_available_thinking_levels` → `{ levels }` — levels of the currently
 *     selected model; only used as a fallback.
 *
 * There is no RPC command for pi's *settings* (default provider/model,
 * `enabledModels`), so the catalogue carries no enabled-scope information:
 * `enabledModels` stays undefined and the caller treats the list as unscoped.
 *
 * Everything here is best effort: a device that cannot be reached yields an
 * empty catalogue, never a rejected promise, because a model picker that throws
 * takes the whole chat UI down.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { RPCChannel } from "@/lib/gateway/types/host-driver";
import { deviceHomeOrDefault } from "@/lib/device-home";

/** One model as the remote device reports it, normalised to what the UI needs. */
export interface RemoteModelInfo {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevels?: string[];
  /** Kept verbatim so the caller can answer with the local `thinkingLevelMaps` shape. */
  thinkingLevelMap?: Record<string, string | null>;
  /** Input modalities (`text`, `image`), used by the composer for image support. */
  input?: string[];
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface RemoteModelCatalogue {
  models: RemoteModelInfo[];
  /** Model a fresh session on that device starts with (`get_state.model`). */
  defaultModel?: { provider: string; id: string };
  /** Reasoning level a fresh session starts with (`get_state.thinkingLevel`). */
  thinkingLevel?: string;
  /** Always undefined for now: pi's RPC mode exposes no `enabledModels` read. */
  enabledModels?: string[];
}

interface CacheEntry {
  catalogue: RemoteModelCatalogue;
  expiresAt: number;
}

declare global {
  var __piWebRemoteModels: Map<string, CacheEntry> | undefined;
  var __piWebRemoteModelsInFlight: Map<string, Promise<RemoteModelCatalogue>> | undefined;
}

const REMOTE_MODELS_TTL_MS = 60_000;
/** A handful of devices is all a browser ever addresses; keep the map bounded. */
const REMOTE_MODELS_CACHE_LIMIT = 8;
/** One round trip must answer within this, or the device counts as unreachable. */
const REMOTE_MODELS_REQUEST_TIMEOUT_MS = 8_000;
/**
 * Spawning `pi --mode rpc` on a reachable device is quick; on an unreachable one
 * the driver only gives up after its own connect budget. Cap the wait so the model
 * picker falls back to an empty list instead of hanging for tens of seconds.
 */
const REMOTE_MODELS_SESSION_TIMEOUT_MS = 10_000;

const EMPTY_CATALOGUE: RemoteModelCatalogue = { models: [] };

let requestCounter = 0;

function cacheEntries(): Map<string, CacheEntry> {
  return globalThis.__piWebRemoteModels ?? (globalThis.__piWebRemoteModels = new Map());
}

function inFlightLoads(): Map<string, Promise<RemoteModelCatalogue>> {
  return globalThis.__piWebRemoteModelsInFlight ?? (globalThis.__piWebRemoteModelsInFlight = new Map());
}

/** Drop the cached catalogue of one device, or of every device. */
export function invalidateRemoteModels(deviceId?: string): void {
  const entries = cacheEntries();
  const inFlight = inFlightLoads();
  if (deviceId) {
    entries.delete(deviceId);
    inFlight.delete(deviceId);
    return;
  }
  entries.clear();
  inFlight.clear();
}

/**
 * Send one command and wait for *its* response.
 *
 * `RPCChannel.send()` is fire-and-forget, so the answer is correlated on the
 * `id` pi echoes back (`rpc-mode` reads `command.id`). A channel that is also
 * serving a live session therefore does not confuse us with that session's own
 * traffic: responses carrying a different id are ignored.
 */
function requestOnChannel(
  channel: RPCChannel,
  command: string,
  timeoutMs = REMOTE_MODELS_REQUEST_TIMEOUT_MS,
): Promise<any> {
  const id = `piweb-models-${++requestCounter}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      settle();
    };
    timer = setTimeout(
      () => finish(() => reject(new Error(`Timeout waiting for remote pi response: ${command}`))),
      timeoutMs,
    );
    timer.unref?.();
    unsubscribe = channel.onMessage((msg: any) => {
      if (!msg || msg.type !== "response" || msg.command !== command) return;
      if (msg.id !== undefined && msg.id !== id) return;
      if (msg.success === false) {
        finish(() => reject(new Error(String(msg.error || `Remote pi rejected ${command}`))));
        return;
      }
      finish(() => resolve(msg.data));
    });
    channel.send({ type: command, id });
  });
}

/** `requestOnChannel` that swallows failures: one dead command must not sink the list. */
async function safeRequest(channel: RPCChannel, command: string): Promise<any> {
  try {
    return await requestOnChannel(channel, command);
  } catch {
    return null;
  }
}

function supportedLevels(model: any): string[] {
  try {
    return getSupportedThinkingLevels(model as Model<Api>);
  } catch {
    return ["off"];
  }
}

/** Normalise a remote `Model` object; returns null when it carries no usable identity. */
function toModelInfo(model: any): RemoteModelInfo | null {
  if (!model || typeof model !== "object") return null;
  const provider = typeof model.provider === "string" ? model.provider : "";
  const id = typeof model.id === "string" ? model.id : "";
  if (!provider || !id) return null;
  return {
    provider,
    id,
    ...(typeof model.name === "string" && model.name ? { name: model.name } : {}),
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
    thinkingLevels: supportedLevels(model),
    // Kept so `/api/models` can answer with the same `thinkingLevelMaps` shape
    // the local branch produces.
    ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === "object"
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    ...(Array.isArray(model.input) ? { input: model.input } : {}),
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
  };
}

/**
 * Pick the channel to ask: a live session for that device if there is one (its
 * channel already talks to a running pi, so no extra process is spawned),
 * otherwise a fresh ephemeral one in the device's home directory.
 */
async function resolveChannel(deviceId: string): Promise<{ channel: RPCChannel; state: any } | null> {
  // Imported lazily: `lib/remote-agent-manager` pulls in the gateway singleton,
  // which the local (device-blind) path has no reason to load.
  const { createRemoteRpcSession, getRemoteRpcSession, getAllRemoteRpcSessions } = await import(
    "@/lib/remote-agent-manager"
  );

  const live = getAllRemoteRpcSessions()
    .filter((session) => session.deviceId === deviceId)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  // Re-resolve through `getRemoteRpcSession`: the session may have been reaped
  // between the listing and this line.
  const existing = live.length > 0 ? getRemoteRpcSession(live[0].sessionId) : undefined;
  if (existing) return { channel: existing.channel, state: existing.state };

  const created = await Promise.race([
    // A loser of the race keeps running; swallow its outcome so a late failure is
    // not an unhandled rejection.
    createRemoteRpcSession({ deviceId, cwd: await deviceHomeOrDefault(deviceId) }).catch(() => null),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), REMOTE_MODELS_SESSION_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  if (!created) return null;
  return { channel: created.session.channel, state: created.data };
}

async function fetchCatalogue(deviceId: string): Promise<RemoteModelCatalogue> {
  try {
    const target = await resolveChannel(deviceId);
    if (!target) return EMPTY_CATALOGUE;
    const { channel } = target;

    const [modelsResponse, levelsResponse, stateResponse] = await Promise.all([
      safeRequest(channel, "get_available_models"),
      safeRequest(channel, "get_available_thinking_levels"),
      target.state ? Promise.resolve({ data: target.state }) : safeRequest(channel, "get_state"),
    ]);

    const rawModels: any[] = Array.isArray(modelsResponse?.models) ? modelsResponse.models : [];
    const state = stateResponse?.data ?? null;
    const stateModel = state?.model ?? null;

    let models = rawModels
      .map(toModelInfo)
      .filter((model): model is RemoteModelInfo => model !== null);
    // A device whose runtime answered nothing useful still knows its current
    // model from `get_state`; offer at least that one instead of an empty picker.
    if (models.length === 0 && stateModel) {
      const single = toModelInfo(stateModel);
      if (single) models = [single];
    }
    // No `enabledModels` scope is readable over RPC, so order like the unscoped
    // local branch: stable sort by provider id.
    models.sort((a, b) => a.provider.localeCompare(b.provider));

    const defaultModel =
      stateModel && typeof stateModel.provider === "string" && typeof stateModel.id === "string"
        ? { provider: stateModel.provider, id: stateModel.id }
        : undefined;

    // Fallback for the selected model only: `get_available_thinking_levels`
    // describes the current model, not the whole list.
    const remoteLevels: string[] = Array.isArray(levelsResponse?.levels)
      ? levelsResponse.levels.filter((level: unknown): level is string => typeof level === "string")
      : [];
    if (defaultModel && remoteLevels.length > 0) {
      const selected = models.find(
        (model) => model.provider === defaultModel.provider && model.id === defaultModel.id,
      );
      if (selected && (selected.thinkingLevels ?? []).length <= 1) {
        selected.thinkingLevels = remoteLevels;
      }
    }

    const thinkingLevel =
      typeof state?.thinkingLevel === "string" && state.thinkingLevel ? state.thinkingLevel : undefined;

    return {
      models,
      ...(defaultModel ? { defaultModel } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  } catch {
    return EMPTY_CATALOGUE;
  }
}

/**
 * Catalogue of `deviceId`, cached for 60 s.
 *
 * Concurrent callers share one load (the in-flight promise is the map value), so
 * a burst of requests cannot spawn several `pi` processes on the device. Empty
 * results are not cached: a device that was unreachable must be retried, and a
 * device that truly has no models still answers from the session it left behind.
 */
export async function loadRemoteModels(
  deviceId: string,
  options: { force?: boolean } = {},
): Promise<RemoteModelCatalogue> {
  const entries = cacheEntries();
  const inFlight = inFlightLoads();

  if (!options.force) {
    const cached = entries.get(deviceId);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.catalogue;
      entries.delete(deviceId);
    }
    const pending = inFlight.get(deviceId);
    if (pending) return pending;
  }

  const load = fetchCatalogue(deviceId)
    .then((catalogue) => {
      if (catalogue.models.length > 0) {
        const now = Date.now();
        for (const [key, entry] of entries) {
          if (entry.expiresAt <= now) entries.delete(key);
        }
        while (entries.size >= REMOTE_MODELS_CACHE_LIMIT) {
          const oldestKey = entries.keys().next().value;
          if (oldestKey === undefined) break;
          entries.delete(oldestKey);
        }
        entries.set(deviceId, { catalogue, expiresAt: now + REMOTE_MODELS_TTL_MS });
      }
      return catalogue;
    })
    .catch(() => EMPTY_CATALOGUE)
    .finally(() => {
      if (inFlight.get(deviceId) === load) inFlight.delete(deviceId);
    });

  inFlight.set(deviceId, load);
  return load;
}
