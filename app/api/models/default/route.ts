import { stat } from "fs/promises";
import { resolve } from "path";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  isThinkingLevel,
  projectSettingsPath,
  shadowingProjectKeys,
  writeDefaultPreferences,
  type DefaultPreferencesEdit,
} from "@/lib/default-preferences";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { resolveVisibleModels } from "@/lib/model-scope";
import { withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { invalidateModelsCache } from "@/lib/models-cache";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { loadRemoteModels } from "@/lib/remote-models";

export const dynamic = "force-dynamic";

interface DefaultPreferencesRequest {
  cwd?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
}

function parseEdit(body: DefaultPreferencesRequest): DefaultPreferencesEdit | null {
  const edit: DefaultPreferencesEdit = {};
  if (body.provider !== undefined || body.modelId !== undefined) {
    if (typeof body.provider !== "string" || !body.provider) return null;
    if (typeof body.modelId !== "string" || !body.modelId) return null;
    edit.model = { provider: body.provider, modelId: body.modelId };
  }
  if (body.thinkingLevel !== undefined) {
    if (!isThinkingLevel(body.thinkingLevel)) return null;
    edit.thinkingLevel = body.thinkingLevel;
  }
  return edit.model || edit.thinkingLevel ? edit : null;
}

/**
 * Current default model / reasoning level of the device the request names.
 *
 * The local machine reads pi's settings files; a remote device has no RPC
 * command that exposes them, so its live session's state is the best answer
 * available (that is the model and level a new session there starts with).
 */
export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);
  if (!isRemoteDevice(deviceId)) {
    return Response.json({ error: "Expected a remote deviceId" }, { status: 400 });
  }
  const catalogue = await loadRemoteModels(deviceId);
  return Response.json({
    defaultModel: catalogue.defaultModel
      ? { provider: catalogue.defaultModel.provider, modelId: catalogue.defaultModel.id }
      : null,
    defaultThinkingLevel: catalogue.thinkingLevel ?? null,
  });
}

/**
 * Save the model and/or reasoning level new sessions start with.
 *
 * Picking a model for one chat is session-scoped, as in the TUI; this is the
 * explicit "save as default" behind the selectors' star. The cwd decides which
 * project settings could shadow the global value and which models are in scope,
 * so it goes through the same allow-list as `/api/models`.
 *
 * Writing a *remote* device's settings is not implemented: the RPC protocol has
 * no settings command, and falling through to the local files would silently
 * save the preference on the wrong machine.
 */
export async function PUT(req: Request) {
  let body: DefaultPreferencesRequest;
  try {
    body = await req.json() as DefaultPreferencesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (isRemoteDevice(getRequestDeviceId(req))) {
    return Response.json({ error: "Not supported on remote devices yet" }, { status: 501 });
  }
  const edit = parseEdit(body);
  if (!edit) {
    return Response.json({ error: "Expected provider and modelId, or a valid thinkingLevel" }, { status: 400 });
  }

  let cwd = resolve(typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd());
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) {
      return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
    }
  } catch {
    cwd = process.cwd();
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const agentDir = getAgentDir();
    const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    const { settingsManager } = services;

    const shadowed = shadowingProjectKeys(settingsManager, edit);
    if (shadowed.length > 0) {
      const settingsPath = projectSettingsPath(cwd);
      return Response.json({
        error: `${settingsPath} sets ${shadowed.join(", ")} for this project, so a global default would not apply here.`,
        reason: "project-scope",
        settingsPath,
        keys: shadowed,
      }, { status: 409 });
    }

    if (edit.model) {
      // Only a model the selector can offer is a default that actually takes
      // effect: startup falls back to the first scoped model otherwise.
      const scope = await resolveVisibleModels(withDeferredProviderModels(services.modelRuntime), settingsManager.getEnabledModels());
      const { provider, modelId } = edit.model;
      if (!scope.visible.some((model) => model.provider === provider && model.id === modelId)) {
        return Response.json({ error: `Model not available: ${provider}/${modelId}` }, { status: 404 });
      }
    }

    await writeDefaultPreferences(settingsManager, edit);
    invalidateModelsCache();
    return Response.json({
      ok: true,
      ...(edit.model ? { defaultModel: edit.model } : {}),
      ...(edit.thinkingLevel ? { defaultThinkingLevel: edit.thinkingLevel } : {}),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
