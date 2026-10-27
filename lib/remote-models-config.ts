import "server-only";
import { getGateway } from "@/lib/gateway/singleton";
import { stripJsonComments } from "@/lib/jsonc";
import { ModelsConfigReadError, normalizeModelsConfigCosts, sanitizeModelsConfig } from "@/lib/models-config-store";
import { readRemoteFiles, writeRemoteFile } from "@/lib/remote-settings-file";
import { getRemoteAgentDir } from "@/lib/remote-settings";
import { invalidateRemoteModels } from "@/lib/remote-models";

/**
 * `models.json` on a remote device: provider definitions, model overrides and
 * `/models` panel edits, all of which live in the device's own agent directory.
 *
 * The local `readModelsConfig` / `writeModelsConfig` (lib/models-config-store.ts)
 * work on this machine's filesystem, so a device needs the same pass over
 * `readRemoteFiles` / `writeRemoteFile`. The one rule that must survive the
 * move: a file this code cannot read is never replaced — the panel saves its
 * whole draft, so an empty read would delete every provider.
 */

/** `models.json`'s path and contents for `deviceId`, in one round trip. */
async function readConfigFile(deviceId: string) {
  const driver = getGateway().getOnlineDriver(deviceId);
  const agentDir = await getRemoteAgentDir(deviceId);
  const path = `${agentDir}/models.json`;
  // Missing file and unreadable file both arrive as "no contents"; the caller
  // decides which one it is (`parseRemoteModelsConfig`).
  const files = await readRemoteFiles(driver, [path]);
  return { path, text: files.get(path) ?? null, driver };
}

/**
 * Parse one `models.json`. Same leniency as pi's loader (BOM, `//` comments,
 * trailing commas) and the same refusal as the local reader: contents that are
 * not a JSON object throw, they do not read as empty.
 */
export function parseRemoteModelsConfig(text: string | null, path: string): Record<string, unknown> {
  if (text === null || !text.trim()) return { providers: {} };
  try {
    const parsed = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ""))) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ModelsConfigReadError(`Failed to read ${path}: expected a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ModelsConfigReadError) throw error;
    throw new ModelsConfigReadError(
      `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read `deviceId`'s `models.json`, shaped exactly like the local route answers. */
export async function readRemoteModelsConfig(deviceId: string): Promise<Record<string, unknown>> {
  const { path, text } = await readConfigFile(deviceId);
  return parseRemoteModelsConfig(text, path);
}

/**
 * Replace `deviceId`'s `models.json` with `data`.
 *
 * The existing file is read first for the same reason the local writer reads
 * it: a file this code cannot parse must not be overwritten by a draft that was
 * not built from it.
 */
export async function writeRemoteModelsConfig(
  deviceId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { path, text, driver } = await readConfigFile(deviceId);
  parseRemoteModelsConfig(text, path);
  const normalized = normalizeModelsConfigCosts(sanitizeModelsConfig(data));
  await writeRemoteFile(driver, path, JSON.stringify(normalized, null, 2));
  invalidateRemoteModels(deviceId);
}
