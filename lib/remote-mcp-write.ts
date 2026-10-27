import "server-only";
import type { McpExposure, McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { McpConfigFileInfo, McpConfigFileProblem, McpScope } from "@/lib/api-types";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import {
  applyInsertMcpServer,
  applyMcpServerEnabledInProject,
  applyMcpServerExposure,
  applyMcpServersEnabled,
  applyRemoveMcpServer,
  isMcpConfigWriteError,
  McpConfigWriteError,
  ownServerEntry,
  parseMcpConfigDocument,
  serializeMcpConfig,
  type McpConfigDocument,
  type McpEnabledOutcome,
  type McpRemovedServer,
} from "@/lib/mcp-config-file";
import { isMcpOverrideEntry } from "@/lib/mcp-override";
import { findWebPasswordField } from "@/lib/mcp-transport";
import type { PiSdkInternals } from "@/lib/pi-sdk-internals";
import { readRemoteFiles, writeRemoteFile } from "@/lib/remote-settings-file";

/**
 * Settings › MCP for a device: the same files, written through the gateway.
 *
 * `lib/mcp-config-file.ts` decides what a change means — which keys a switch
 * touches, where an override goes, which bytes a file gets — and this module
 * supplies the one part that is not local: reading the file off the device and
 * writing it back. Both go through `lib/remote-settings-file.ts`, so a file
 * round-trips byte for byte and a write keeps the mode it had.
 *
 * The local writer's link rule (`realpath` inside the allowed roots) has no
 * meaning here: a device's folders are the device's business, and the panel only
 * offers folders the user picked there.
 */

const WRITE_TIMEOUT_MS = 30_000;

/** The `mcp.json` of a device's agent directory, and of a project on it. */
export function remoteGlobalMcpPath(agentDir: string): string {
  return `${agentDir}/mcp.json`;
}

export function remoteProjectMcpPath(cwd: string): string {
  return `${cwd}/.pi/mcp.json`;
}

/** Where a write goes on a device: the same shape as the local target, minus the allowed roots. */
export type RemoteMcpTarget = { scope: "global"; agentDir: string } | { scope: "project"; cwd: string };

/** The path a target writes. */
export function remoteMcpTargetPath(target: RemoteMcpTarget): string {
  return target.scope === "global" ? remoteGlobalMcpPath(target.agentDir) : remoteProjectMcpPath(target.cwd);
}

export interface RemoteMcpEditOutcome<T> {
  value: T;
  written: boolean;
  path: string;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the file off the device, let `edit` change the parsed document, write it
 * back when `edit` reports a change.
 *
 * A file that cannot be parsed is never overwritten: the same rule as the local
 * writer, and the reason a hand-edited `mcp.json` with a trailing comma gets a
 * 409 instead of silently losing every server it held.
 */
export async function editRemoteMcpFile<T>(
  driver: IHostDriver,
  target: RemoteMcpTarget,
  edit: (file: McpConfigDocument) => { changed: boolean; value: T },
): Promise<RemoteMcpEditOutcome<T>> {
  const path = remoteMcpTargetPath(target);
  const text = (await readRemoteFiles(driver, [path], WRITE_TIMEOUT_MS)).get(path);
  const document = parseMcpConfigDocument(text, path);
  const servers = isRecordObject(document.mcpServers) ? document.mcpServers : undefined;
  const { changed, value } = edit({ document, servers, exists: text !== undefined, path });
  if (changed) await writeRemoteFile(driver, path, serializeMcpConfig(document, text), WRITE_TIMEOUT_MS);
  return { value, written: changed, path };
}

/** The named servers on or off, one write; per-name outcomes as the local writer gives them. */
export async function setRemoteMcpServersEnabled<R extends string = never>(
  driver: IHostDriver,
  target: RemoteMcpTarget,
  names: readonly string[],
  enabled: boolean,
  refuse?: (name: string, entry: Record<string, unknown>) => R | undefined,
): Promise<RemoteMcpEditOutcome<McpEnabledOutcome<R>[]>> {
  return editRemoteMcpFile(driver, target, (file) => applyMcpServersEnabled(file, names, enabled, refuse));
}

export async function setRemoteMcpServerExposure(
  driver: IHostDriver,
  target: RemoteMcpTarget,
  name: string,
  exposure: McpExposure,
): Promise<RemoteMcpEditOutcome<McpEnabledOutcome<never>>> {
  return editRemoteMcpFile(driver, target, (file) => applyMcpServerExposure(file, name, exposure));
}

export async function setRemoteMcpServerEnabledInProject(
  driver: IHostDriver,
  target: Extract<RemoteMcpTarget, { scope: "project" }>,
  name: string,
  enabled: boolean,
): Promise<RemoteMcpEditOutcome<McpEnabledOutcome<never>>> {
  return editRemoteMcpFile(driver, target, (file) => applyMcpServerEnabledInProject(file, name, enabled));
}

export async function removeRemoteMcpServer(
  driver: IHostDriver,
  target: RemoteMcpTarget,
  name: string,
): Promise<RemoteMcpEditOutcome<McpRemovedServer>> {
  return editRemoteMcpFile(driver, target, (file) => applyRemoveMcpServer(file, name));
}

export async function insertRemoteMcpServer(
  driver: IHostDriver,
  target: RemoteMcpTarget,
  name: string,
  entry: unknown,
  index?: number,
): Promise<RemoteMcpEditOutcome<void>> {
  return editRemoteMcpFile(driver, target, (file) => applyInsertMcpServer(file, name, entry, index));
}

/** The entries a device's `mcp.json` defines, in file order, with the file's problems. */
export function describeRemoteMcpFile(
  text: string | undefined,
  path: string,
  scope: McpScope,
): { info: McpConfigFileInfo; entries: [string, unknown][] } {
  const problems: McpConfigFileProblem[] = [];
  const info: McpConfigFileInfo = { scope, path, exists: text !== undefined, problems };
  if (text === undefined) return { info, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    problems.push({ reason: "unparsable", error: `${path}: ${error instanceof Error ? error.message : String(error)}` });
    return { info, entries: [] };
  }
  if (!isRecordObject(parsed) || (parsed.mcpServers !== undefined && !isRecordObject(parsed.mcpServers))) {
    problems.push({ reason: "invalid-shape", error: `${path}: expected an object with an "mcpServers" object` });
    return { info, entries: [] };
  }
  if (typeof parsed.autoEnableCodemode === "boolean") info.autoEnableCodemode = parsed.autoEnableCodemode;
  else if (parsed.autoEnableCodemode !== undefined) {
    problems.push({ reason: "auto-enable-codemode-invalid", error: "autoEnableCodemode must be a boolean" });
  }
  return { info, entries: Object.entries(isRecordObject(parsed.mcpServers) ? parsed.mcpServers : {}) };
}

/** The names a device's file defines now, for a name an add must not take. */
export function remoteNamesInFile(text: string | undefined, path: string, scope: McpScope): string[] {
  return describeRemoteMcpFile(text, path, scope).entries.map(([name]) => name);
}

/**
 * One entry of a device's file, read as its listing reads it.
 *
 * The local reader (`readMcpServerEntry()`) is built on `realpath` and a local
 * allow-list, so it cannot be pointed at a device. What a route needs from it is
 * small: is the entry there, is it an object, and what would a session connect.
 * The validator is a pure function and runs here, so a refused entry is refused
 * with pi's own words.
 */
export interface RemoteMcpEntryRead {
  ok: boolean;
  value?: unknown;
  /** The entry a session would connect: the validator's copy, or an override of the global entry. */
  config?: McpServerConfig;
  reason?: "unparsable" | "invalid-shape" | "server-missing" | "unreadable";
  error?: string;
  path: string;
}

export function readRemoteMcpEntry(
  text: string | undefined,
  path: string,
  scope: McpScope,
  name: string,
  internals?: Pick<PiSdkInternals, "validateMcpServerConfig">,
): RemoteMcpEntryRead {
  let document: Record<string, unknown>;
  try {
    document = parseMcpConfigDocument(text, path);
  } catch (error) {
    const reason = isMcpConfigWriteError(error) ? error.reason : "unreadable";
    return {
      ok: false,
      reason: reason === "unparsable" || reason === "invalid-shape" ? reason : "unreadable",
      error: error instanceof Error ? error.message : String(error),
      path,
    };
  }
  const servers = isRecordObject(document.mcpServers) ? document.mcpServers : undefined;
  const value = ownServerEntry(servers, name);
  if (value === undefined) {
    return { ok: false, reason: "server-missing", error: `${path} does not define MCP server "${name}"`, path };
  }
  const config = internals?.validateMcpServerConfig(name, value);
  return { ok: true, value, path, ...(config && typeof config !== "string" ? { config } : {}) };
}

/** A project override as a session connects it: the global entry with the override's keys. */
export function remoteOverrideConfig(
  globalConfig: McpServerConfig | undefined,
  entry: Record<string, unknown>,
): McpServerConfig | undefined {
  if (!globalConfig) return undefined;
  return { ...globalConfig, ...entry } as McpServerConfig;
}

/** Whether an entry references this Pi Web host's password, so turning it on must be refused. */
export function remoteReferencesWebPassword(
  config: unknown,
  internals: Pick<PiSdkInternals, "isCommandConfigValue" | "getConfigValueEnvVarNames">,
): boolean {
  return findWebPasswordField(config, internals) !== undefined;
}

export { McpConfigWriteError, isMcpConfigWriteError, isMcpOverrideEntry };
export type { McpConfigDocument };
