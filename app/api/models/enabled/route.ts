import { stat } from "fs/promises";
import { resolve } from "path";
import { getAgentDir, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  clearEnabledModels,
  constrainProviderEntries,
  pruneStaleEnabledModels,
  renameModelPatterns,
  renameProviderPatterns,
  setModelsEnabled,
  type EnabledModelsEdit,
  type ProviderRename,
} from "@/lib/enabled-models";
import {
  buildEnabledModelsInput,
  buildEnabledModelsView,
  customProviderIds,
  modelRef,
  readEnabledModelsSettings,
  writeEnabledModels,
  type EnabledModelsView,
} from "@/lib/enabled-models-runtime";
import type { EnabledModelsInput } from "@/lib/enabled-models";
import { getModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { loadRemoteModels, type RemoteModelCatalogue } from "@/lib/remote-models";

export const dynamic = "force-dynamic";

interface RequestContext {
  modelRuntime: ModelRuntime;
  models: readonly Model<Api>[];
  settingsManager: SettingsManager;
  /** Where the two settings files live, for the banner to name one. */
  paths: { cwd: string; agentDir: string };
}

async function loadContext(cwd: string): Promise<RequestContext> {
  const modelRuntime = withDeferredProviderModels(await getModelRuntimeWithExtensions());
  const agentDir = getAgentDir();
  return {
    modelRuntime,
    models: await modelRuntime.getAvailable(),
    settingsManager: SettingsManager.create(cwd, agentDir),
    paths: { cwd, agentDir },
  };
}

async function buildView(context: RequestContext): Promise<EnabledModelsView> {
  const { patterns, scope, path } = readEnabledModelsSettings(context.settingsManager, context.paths);
  const input = await buildEnabledModelsInput(patterns, context.models);
  const providerNames = new Map(
    context.modelRuntime.getProviders().map((provider) => [provider.id, provider.name]),
  );
  const modelError = context.modelRuntime.getError();
  return buildEnabledModelsView({
    input,
    models: context.models,
    providerNames,
    customProviders: customProviderIds(context.modelRuntime),
    scope,
    settingsPath: path,
    ...(modelError ? { modelError } : {}),
  });
}

/**
 * Resolve the cwd whose project settings decide whether the global value is
 * shadowed. It is only read, never written, but it still points at a settings
 * file, so it goes through the same allow-list as `/api/files`.
 */
async function resolveCwd(raw: string | null): Promise<{ cwd: string } | { error: Response }> {
  if (!raw) return { cwd: process.cwd() };
  const cwd = resolve(raw);
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return { error: Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 }) };
  }
  if (!cwdStat.isDirectory()) {
    return { error: Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 }) };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: Response.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);
  if (isRemoteDevice(deviceId)) {
    // A remote device's models live in its own runtime, so neither the local cwd
    // allow-list nor the local settings files apply here.
    return Response.json(await buildRemoteView(deviceId));
  }

  const resolved = await resolveCwd(new URL(req.url).searchParams.get("cwd"));
  if ("error" in resolved) return resolved.error;

  try {
    return Response.json(await buildView(await loadContext(resolved.cwd)));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * The catalogue of a remote device as `Model` objects, for `buildEnabledModelsView`.
 *
 * Only `id`, `name`, `provider` and `contextWindow` are read from them, so the
 * runtime-only fields of a real `Model` are irrelevant here.
 */
function remoteModelsForView(catalogue: RemoteModelCatalogue): readonly Model<Api>[] {
  return catalogue.models.map((model) => ({
    id: model.id,
    name: model.name || model.id,
    provider: model.provider,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  } as unknown as Model<Api>));
}

/**
 * `enabledModels` panel data for a remote device.
 *
 * pi's RPC mode cannot read that setting, so the panel shows every model the
 * device reports as enabled, with no pins, and read-only: `editable` is forced
 * false because the matching PUT answers 501 rather than writing to the wrong
 * machine's settings file.
 */
async function buildRemoteView(deviceId: string): Promise<EnabledModelsView> {
  const catalogue = await loadRemoteModels(deviceId);
  const input: EnabledModelsInput = {
    patterns: catalogue.enabledModels,
    availableRefs: catalogue.models.map((model) => `${model.provider}/${model.id}`),
    resolutions: [],
  };
  const view = buildEnabledModelsView({
    input,
    models: remoteModelsForView(catalogue),
    // The RPC model list carries no provider display names.
    providerNames: new Map<string, string>(),
    customProviders: new Set<string>(),
    scope: "global",
    settingsPath: `${deviceId}:~/.pi/agent/settings.json`,
  });
  return { ...view, editable: false };
}

interface EnabledModelsRequest {
  cwd?: unknown;
  deviceId?: unknown;
  op?: unknown;
  provider?: unknown;
  refs?: unknown;
  renames?: unknown;
  modelRenames?: unknown;
  fullyEnabled?: unknown;
  enabled?: unknown;
}

function renamePairs(value: unknown): ProviderRename[] | null {
  if (!Array.isArray(value)) return null;
  const renames: ProviderRename[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { from, to } = entry as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) return null;
    renames.push({ from, to });
  }
  return renames;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

/**
 * Repair the stored patterns after models.json changed under the panel.
 *
 * A pattern's meaning depends on the catalog, and the catalog just moved: a
 * provider rename can make its glob reach into another provider (pi matches
 * patterns against the bare model id too, so `stepfun/*` also matches
 * `commandcode`'s `stepfun/Step-5-Preview`), and renaming a model to an id with
 * a slash drops it out of `provider/*` entirely. So re-resolve, cut entries
 * back to the provider their prefix names, and restore the providers that were
 * fully enabled before the save.
 */
async function resyncAfterModelsConfigSave(
  context: RequestContext,
  input: EnabledModelsInput,
  options: {
    renames: readonly ProviderRename[];
    modelRenames: readonly ProviderRename[];
    fullyEnabled: readonly string[];
  },
): Promise<EnabledModelsEdit> {
  const { renames, modelRenames, fullyEnabled } = options;
  const original = input.patterns;
  // Model references first: they still carry the old provider id, which the
  // provider rewrite below would otherwise have replaced already.
  const renamed = renameProviderPatterns(renameModelPatterns(original, modelRenames), renames);
  let current = renamed === original
    ? input
    : await buildEnabledModelsInput(renamed, context.models, { withProviderGlobs: true });

  const constrained = constrainProviderEntries(current);
  if (constrained.ok && constrained.changed) {
    current = await buildEnabledModelsInput(constrained.patterns, context.models, { withProviderGlobs: true });
  }

  // A provider that was fully enabled before the save stays fully enabled, even
  // when a model of it was renamed out of the glob that used to cover it.
  const refs = fullyEnabled
    .map((id) => renames.find((rename) => rename.from === id)?.to ?? id)
    .flatMap((id) => context.models.filter((model) => model.provider === id).map(modelRef));
  const edit = setModelsEnabled(current, refs, true);
  if (!edit.ok) return edit;
  return { ok: true, patterns: edit.patterns, changed: !samePatternList(edit.patterns, original) };
}

function samePatternList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((pattern, index) => pattern === b[index]);
}

export async function PUT(req: Request) {
  let body: EnabledModelsRequest;
  try {
    body = await req.json() as EnabledModelsRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Writing `enabledModels` for a remote device is not implemented: the RPC
  // protocol has no settings command, and the local files belong to another
  // machine. Refuse instead of silently editing them.
  const requestDevice = getRequestDeviceId(req);
  const bodyDevice = typeof body.deviceId === "string" ? body.deviceId : null;
  if (isRemoteDevice(requestDevice) || isRemoteDevice(bodyDevice)) {
    return Response.json({ error: "Not supported on remote devices yet" }, { status: 501 });
  }

  const op = body.op;
  if (op !== "models" && op !== "provider" && op !== "clear" && op !== "prune" && op !== "resync") {
    return Response.json({ error: "Invalid op" }, { status: 400 });
  }
  if (op === "models" || op === "provider") {
    if (typeof body.enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
  }
  if (body.cwd !== undefined && typeof body.cwd !== "string") {
    return Response.json({ error: "Invalid cwd" }, { status: 400 });
  }

  const resolved = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
  if ("error" in resolved) return resolved.error;

  try {
    const context = await loadContext(resolved.cwd);
    const { patterns, scope } = readEnabledModelsSettings(context.settingsManager, context.paths);
    if (scope === "project") {
      return Response.json(
        { error: "Project settings override enabledModels", reason: "project-scope" },
        { status: 409 },
      );
    }

    const input = await buildEnabledModelsInput(patterns, context.models, { withProviderGlobs: true });
    let edit;
    if (op === "clear") {
      edit = clearEnabledModels(input);
    } else if (op === "prune") {
      edit = pruneStaleEnabledModels(input);
    } else if (op === "resync") {
      const renames = renamePairs(body.renames);
      const modelRenames = renamePairs(body.modelRenames ?? []);
      const fullyEnabled = stringArray(body.fullyEnabled ?? []);
      if (!renames || !modelRenames || !fullyEnabled) {
        return Response.json({ error: "Invalid resync payload" }, { status: 400 });
      }
      edit = await resyncAfterModelsConfigSave(context, input, { renames, modelRenames, fullyEnabled });
    } else {
      let refs: string[];
      if (op === "provider") {
        if (typeof body.provider !== "string" || !body.provider) {
          return Response.json({ error: "provider is required" }, { status: 400 });
        }
        // Resolved server-side so a provider switched on stays on for models
        // the browser has not seen yet.
        refs = context.models
          .filter((model) => model.provider === body.provider)
          .map(modelRef);
      } else {
        const requested = stringArray(body.refs);
        if (!requested) return Response.json({ error: "refs must be an array of strings" }, { status: 400 });
        refs = requested;
      }
      edit = setModelsEnabled(input, refs, body.enabled === true);
    }

    if (!edit.ok) {
      return Response.json(
        { error: "At least one model must stay enabled", reason: edit.reason },
        { status: 409 },
      );
    }
    if (edit.changed) {
      await writeEnabledModels(context.settingsManager, edit.patterns);
      invalidateModelsCache();
    }

    return Response.json(await buildView(context));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
