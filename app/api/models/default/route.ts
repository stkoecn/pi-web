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
import { DeviceOfflineError } from "@/lib/gateway/singleton";

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
 * The answer comes from the device's own `settings.json`, because that is what a
 * new session there reads at startup. When the file names no default, the live
 * session's state is used instead: pi picks a model anyway, and reporting `null`
 * would leave the selectors' star un-set while every new session clearly has a
 * model.
 */
export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);
  if (!isRemoteDevice(deviceId)) {
    return Response.json({ error: "Expected a remote deviceId" }, { status: 400 });
  }
  const catalogue = await loadRemoteModels(deviceId);
  const { readRemoteDefaultPreferences } = await import("@/lib/remote-default-preferences");
  const saved = await readRemoteDefaultPreferences(deviceId).catch(() => null);
  const provider = saved?.defaultProvider ?? catalogue.defaultModel?.provider ?? null;
  const modelId = saved?.defaultModel ?? catalogue.defaultModel?.id ?? null;
  return Response.json({
    defaultModel: provider && modelId ? { provider, modelId } : null,
    defaultThinkingLevel: saved?.defaultThinkingLevel ?? catalogue.thinkingLevel ?? null,
    settingsPath: saved?.settingsPath ?? null,
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
 * On a remote device the same edit is applied to *that* device's
 * `~/.pi/agent/settings.json` (see lib/remote-default-preferences.ts): the RPC
 * protocol has no settings command, so the file pi itself would write is edited
 * with the same merge semantics. The local allow-list does not apply there — no
 * local file is read, and the device's paths are not local paths.
 */
export async function PUT(req: Request) {
  let body: DefaultPreferencesRequest;
  try {
    body = await req.json() as DefaultPreferencesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const requestDeviceId = getRequestDeviceId(req);
  if (isRemoteDevice(requestDeviceId)) {
    return saveRemotePreferences(requestDeviceId, body);
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

/**
 * The remote branch of `PUT`: write the edit to the device's own settings file.
 *
 * The model is checked against what the device reports as usable, the same way
 * the local branch checks it against its visible scope — a default naming a model
 * the device cannot run would be silently replaced at the next startup, so it is
 * refused here instead of being written and then ignored.
 */
async function saveRemotePreferences(
  deviceId: string,
  body: DefaultPreferencesRequest,
): Promise<Response> {
  const edit = parseEdit(body);
  if (!edit) {
    return Response.json({ error: "Expected provider and modelId, or a valid thinkingLevel" }, { status: 400 });
  }
  if (edit.model) {
    const catalogue = await loadRemoteModels(deviceId);
    const { provider, modelId } = edit.model;
    // An empty catalogue means the device answered nothing: refusing on that
    // basis would block a save whenever its `pi` is busy, so only a non-empty
    // list is allowed to say "not available".
    if (catalogue.models.length > 0
      && !catalogue.models.some((model) => model.provider === provider && model.id === modelId)) {
      return Response.json({ error: `Model not available: ${provider}/${modelId}` }, { status: 404 });
    }
  }

  const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : null;
  try {
    const { writeRemoteDefaultPreferences } = await import("@/lib/remote-default-preferences");
    const result = await writeRemoteDefaultPreferences(deviceId, edit, { cwd });
    // The catalogue carries the device's *current* default from its live session,
    // which the file edit does not change: without this, the star would keep
    // showing the previous default for the rest of the cache window.
    const { invalidateRemoteModels } = await import("@/lib/remote-models");
    invalidateRemoteModels(deviceId);
    return Response.json({
      ok: true,
      settingsPath: result.settingsPath,
      written: result.written,
      ...(edit.model ? { defaultModel: edit.model } : {}),
      ...(edit.thinkingLevel ? { defaultThinkingLevel: edit.thinkingLevel } : {}),
    });
  } catch (error) {
    const { RemoteProjectScopeError, RemoteSettingsUnreadableError } = await import("@/lib/remote-default-preferences");
    if (error instanceof DeviceOfflineError) {
      return Response.json({ error: error.message, code: error.code, deviceId: error.deviceId }, { status: 503 });
    }
    if (error instanceof RemoteProjectScopeError) {
      return Response.json({
        error: error.message,
        reason: "project-scope",
        settingsPath: error.settingsPath,
        keys: error.keys,
      }, { status: 409 });
    }
    if (error instanceof RemoteSettingsUnreadableError) {
      return Response.json({
        error: error.message,
        reason: "settings-unreadable",
        settingsPath: error.settingsPath,
      }, { status: 409 });
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
