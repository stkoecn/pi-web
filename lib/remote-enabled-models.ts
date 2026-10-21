import "server-only";
import { getGateway } from "@/lib/gateway/singleton";
import { getRemoteAgentDir } from "@/lib/remote-settings";
import { readRemoteFiles, writeRemoteFile } from "@/lib/remote-settings-file";
import {
  mergeEnabledModels,
  parseSettingsObject,
  projectShadowsEnabledModels,
  readEnabledModelsFromSettings,
  serializeSettings,
} from "@/lib/remote-settings-merge";
import { loadRemoteModels, type RemoteModelCatalogue } from "@/lib/remote-models";

/**
 * `enabledModels` for a *remote* device.
 *
 * pi's RPC mode exposes no settings command at all — `set_model` deliberately
 * does not persist — so the only way to change a device's model scope is to edit
 * the device's own settings files. Two of them matter:
 *
 * - the global `~/.pi/agent/settings.json`, which pi-web may write;
 * - the project's `.pi/settings.json`, which *shadows* the global value. pi-web
 *   does not write that one (it belongs to the repository, not to this panel),
 *   so a shadowed edit is refused with the path and the key named.
 *
 * Both are read in one round trip: each is one RTT on a WAN device, and every
 * operation here needs both.
 */

export interface RemoteEnabledModelsState {
  /** The file whose value is in effect: the project's when it sets the key. */
  settingsPath: string;
  projectSettingsPath: string | null;
  /**
   * The *effective* `enabledModels` — the project's when it sets the key, the
   * global one otherwise; `undefined` means pi enables every model. Same rule as
   * the local reader, so the two branches show the same counts.
   */
  patterns: string[] | undefined;
  /** The project file names `enabledModels`, so the global value is not in effect. */
  shadowed: boolean;
  catalogue: RemoteModelCatalogue;
}

export class RemoteEnabledModelsScopeError extends Error {
  constructor(readonly settingsPath: string) {
    super(`${settingsPath} sets enabledModels for this project, so a global edit would not apply here.`);
    this.name = "RemoteEnabledModelsScopeError";
  }
}

function projectSettingsPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return `${cwd.replace(/\/+$/, "")}/.pi/settings.json`;
}

/** Both settings files plus the device's model catalogue, for one panel load. */
export async function readRemoteEnabledModels(
  deviceId: string,
  options: { cwd?: string | null } = {},
): Promise<RemoteEnabledModelsState> {
  const agentDir = await getRemoteAgentDir(deviceId);
  const settingsPath = `${agentDir}/settings.json`;
  const projectPath = projectSettingsPath(options.cwd);
  const driver = getGateway().getOnlineDriver(deviceId);

  const [files, catalogue] = await Promise.all([
    readRemoteFiles(driver, projectPath ? [settingsPath, projectPath] : [settingsPath]),
    loadRemoteModels(deviceId),
  ]);

  const globalText = files.get(settingsPath);
  const globalValue = globalText === undefined ? null : parseSettingsObject(globalText).value;
  const projectText = projectPath ? files.get(projectPath) : undefined;
  const projectValue = projectText === undefined ? null : parseSettingsObject(projectText).value;

  const shadowed = projectShadowsEnabledModels(projectValue);
  return {
    settingsPath: shadowed && projectPath ? projectPath : settingsPath,
    projectSettingsPath: projectPath,
    patterns: shadowed
      ? readEnabledModelsFromSettings(projectValue)
      : readEnabledModelsFromSettings(globalValue),
    shadowed,
    catalogue,
  };
}

/**
 * Persist a new global `enabledModels` on the device.
 *
 * The caller decides the new pattern list (the pure editor in
 * `lib/enabled-models.ts` does), so this only refuses the cases where writing
 * would be a lie: a project file that shadows the value, or a settings file that
 * cannot be parsed — merging into that would drop whatever it holds.
 */
export async function writeRemoteEnabledModels(
  deviceId: string,
  patterns: string[] | undefined,
  options: { cwd?: string | null } = {},
): Promise<{ settingsPath: string; written: boolean }> {
  const agentDir = await getRemoteAgentDir(deviceId);
  const settingsPath = `${agentDir}/settings.json`;
  const projectPath = projectSettingsPath(options.cwd);
  const driver = getGateway().getOnlineDriver(deviceId);

  const files = await readRemoteFiles(driver, projectPath ? [settingsPath, projectPath] : [settingsPath]);
  const projectText = projectPath ? files.get(projectPath) : undefined;
  const projectValue = projectText === undefined ? null : parseSettingsObject(projectText).value;
  if (projectPath && projectShadowsEnabledModels(projectValue)) {
    throw new RemoteEnabledModelsScopeError(projectPath);
  }

  const globalText = files.get(settingsPath);
  const globalRead = globalText === undefined ? { value: null } : parseSettingsObject(globalText);
  if (globalRead.error) {
    throw new Error(`${settingsPath} could not be read: ${globalRead.error}`);
  }

  const merged = mergeEnabledModels(globalRead.value, patterns);
  await writeRemoteFile(driver, settingsPath, serializeSettings(merged));
  return { settingsPath, written: true };
}
