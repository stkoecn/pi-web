import "server-only";
import type { McpExposure } from "@earendil-works/pi-coding-agent";
import type {
  McpActionItemResult,
  McpActionResponse,
  McpErrorResponse,
  McpRefusalReason,
  McpResponse,
  McpScope,
  McpServerRef,
} from "@/lib/api-types";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { MCP_ADD_MAX_TEXT, prepareMcpAdd, readMcpAddSecretReferences, readMcpAddValues, type McpAddRefusal, type McpAddRequest } from "@/lib/mcp-add";
import { isMcpConfigWriteError } from "@/lib/mcp-config-file";
import { suggestFreeName } from "@/lib/mcp-import";
import { mcpOAuthStoreKeys, mcpOAuthUrl, noteMcpSignOut } from "@/lib/mcp-sign-out";
import { forgetMcpEntryStatuses } from "@/lib/mcp-status";
import { findWebPasswordField } from "@/lib/mcp-transport";
import { holdRemovedEntry, returnRemovedEntry, takeRemovedEntry } from "@/lib/mcp-undo";
import type { PiSdkInternals } from "@/lib/pi-sdk-internals";
import { invalidateRemoteModels } from "@/lib/remote-models";
import {
  describeRemoteMcpFile,
  insertRemoteMcpServer,
  isMcpOverrideEntry,
  readRemoteMcpEntry,
  remoteGlobalMcpPath,
  remoteMcpTargetPath,
  remoteNamesInFile,
  remoteOverrideConfig,
  remoteProjectMcpPath,
  remoteReferencesWebPassword,
  removeRemoteMcpServer,
  setRemoteMcpServerEnabledInProject,
  setRemoteMcpServerExposure,
  setRemoteMcpServersEnabled,
  type RemoteMcpTarget,
} from "@/lib/remote-mcp-write";
import { invalidateRemoteSettings } from "@/lib/remote-settings";
import { readRemoteFiles, writeRemoteFile } from "@/lib/remote-settings-file";
import {
  invalidateRemoteTrust,
  readRemoteTrustSnapshot,
  remoteFolderIsFresh,
  remoteProjectTrustStatus,
  remoteTrustBreadth,
  setRemoteTrust,
  type RemoteTrustSnapshot,
} from "@/lib/remote-trust";

/**
 * `POST /api/mcp` on a device.
 *
 * Every action the panel offers has the same meaning here as on this machine:
 * one `mcp.json` is read, changed and written back, and the answer is the
 * overview GET would give so the pane replaces its listing without a second
 * request. What differs is where the bytes are and who decides trust — the
 * device's own `trust.json` and its own folders — which is why the gate
 * (`lib/remote-trust.ts`) asks the device instead of reading this machine's.
 *
 * The read that decides everything is one round trip: both `mcp.json` files and
 * `trust.json` come back together, and only a write costs another.
 */

/** One newline, spelled without an escape a patch script can eat. */
const NEWLINE = String.fromCharCode(10);

/** A refusal as the route answers it; `reason` is the code the panel translates. */
export interface RemoteMcpRefusal {
  ok: false;
  status: number;
  reason: McpRefusalReason;
  error: string;
  params: Omit<McpErrorResponse, "error" | "reason">;
}

/** The action landed: `extra` is what the answer adds to the overview. */
export interface RemoteMcpDone {
  ok: true;
  extra: Omit<McpActionResponse, keyof McpResponse>;
}

export type RemoteMcpResult = RemoteMcpDone | RemoteMcpRefusal;

function refused(
  status: number,
  reason: McpRefusalReason,
  error: string,
  params: Omit<McpErrorResponse, "error" | "reason"> = {},
): RemoteMcpRefusal {
  return { ok: false, status, reason, error, params };
}

function done(extra: Omit<McpActionResponse, keyof McpResponse> = {}): RemoteMcpDone {
  return { ok: true, extra };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Everything an action needs, read in one round trip before it decides anything. */
export interface RemoteMcpContext {
  deviceId: string;
  driver: IHostDriver;
  agentDir: string;
  /** The panel's project, or null when it shows the global file alone. */
  cwd: string | null;
  internals: PiSdkInternals;
  globalText: string | undefined;
  projectText: string | undefined;
  trust: RemoteTrustSnapshot;
}

/**
 * Read the two files and the folder's trust in one round trip.
 *
 * `readRemoteTrustSnapshot()` carries the files along: its script already runs on
 * the device, and asking twice for the same connection is what made this pane
 * slow on a WAN device.
 */
export async function openRemoteMcp(
  deviceId: string,
  driver: IHostDriver,
  agentDir: string,
  cwd: string | null,
  internals: PiSdkInternals,
): Promise<RemoteMcpContext> {
  const globalPath = remoteGlobalMcpPath(agentDir);
  const projectPath = cwd ? remoteProjectMcpPath(cwd) : undefined;
  const snapshot = await readRemoteTrustSnapshot(
    driver,
    agentDir,
    cwd,
    projectPath ? [globalPath, projectPath] : [globalPath],
  );
  return {
    deviceId,
    driver,
    agentDir,
    cwd,
    internals,
    globalText: snapshot.files.get(globalPath),
    projectText: projectPath ? snapshot.files.get(projectPath) : undefined,
    trust: snapshot,
  };
}

/** The folder's trust from the snapshot, or undefined when the panel shows no project. */
export function trustOf(context: RemoteMcpContext) {
  return context.cwd ? remoteProjectTrustStatus(context.trust, context.cwd) : undefined;
}

/**
 * The device's trust for a folder, from the snapshot this request already read.
 *
 * `undo` names the folder the removal came from, which is the panel's own in
 * every answer the panel can act on; a snapshot read for another folder is not
 * evidence about this one, so that case reads again rather than assumes.
 */
async function trustStatusFor(context: RemoteMcpContext, cwd: string) {
  if (context.cwd === cwd) return remoteProjectTrustStatus(context.trust, cwd);
  const snapshot = await readRemoteTrustSnapshot(context.driver, context.agentDir, cwd);
  return remoteProjectTrustStatus(snapshot, cwd);
}

/** Where a write to `scope` goes, under the device's own trust rule. */
async function writeTarget(
  context: RemoteMcpContext,
  scope: McpScope,
  cwd?: string,
): Promise<RemoteMcpTarget | RemoteMcpRefusal> {
  if (scope === "global") return { scope: "global", agentDir: context.agentDir };
  const folder = cwd ?? context.cwd;
  if (!folder) return refused(400, "invalid-request", "A project server needs the project's cwd");
  const status = await trustStatusFor(context, folder);
  if (status.decisionError !== undefined) return refused(409, "trust-unreadable", status.decisionError);
  if (status.decision !== true) {
    return refused(403, "project-untrusted", "The project is not trusted, so its .pi/mcp.json is not changed");
  }
  return { scope: "project", cwd: folder };
}

function isRefusal(value: RemoteMcpTarget | RemoteMcpRefusal): value is RemoteMcpRefusal {
  return "ok" in value;
}

/** A writer refusal as the route answers it: 409 for a file state the user can fix, 500 for anything else. */
function writeRefusal(error: unknown): RemoteMcpRefusal {
  if (isMcpConfigWriteError(error)) {
    const params = { path: error.path, ...(error.serverName !== undefined ? { name: error.serverName } : {}) };
    if (error.reason === "unreadable") return refused(500, "internal", error.message, params);
    return refused(409, error.reason as McpRefusalReason, error.message, params);
  }
  return refused(500, "internal", errorMessage(error));
}

/** Why the writer left one server as it was, as a 409; undefined when it now says what was asked. */
function outcomeRefusal(outcome: { name: string; outcome: string; reason?: string }, path: string): RemoteMcpRefusal | undefined {
  const name = outcome.name;
  switch (outcome.outcome) {
    case "missing":
      return refused(409, "server-missing", `${path} does not define MCP server "${name}"`, { path, name });
    case "not-an-object":
      return refused(409, "entry-not-object", `${path} defines MCP server "${name}" as something other than an object, so it has nothing to switch`, { path, name });
    case "refused":
      return refused(409, "web-password", `"${name}" references PI_WEB_PASSWORD, so Pi Web does not turn it on`, { name });
    default:
      return undefined;
  }
}

/** The files this context read, as the entry reader wants them. */
function fileText(context: RemoteMcpContext, scope: McpScope): string | undefined {
  return scope === "global" ? context.globalText : context.projectText;
}

function entryPath(context: RemoteMcpContext, scope: McpScope): string {
  return scope === "global" ? remoteGlobalMcpPath(context.agentDir) : remoteProjectMcpPath(context.cwd ?? "");
}

/** Drop what a write invalidated, so the pane's read-back sees the change. */
function forget(context: RemoteMcpContext): void {
  invalidateRemoteSettings(context.deviceId);
  invalidateRemoteTrust(context.deviceId);
}

/**
 * Turning on an entry that references PI_WEB_PASSWORD is refused: Pi Web would
 * not connect it, and the pi CLI running there would send the password. The check
 * is a pure function over the entry, so it runs here on the entry the device
 * holds.
 */
function webPasswordRefusal(internals: PiSdkInternals) {
  return (_name: string, entry: Record<string, unknown>) =>
    findWebPasswordField(entry, internals) ? ("web-password" as const) : undefined;
}

/** Turns one server on or off. */
export async function switchRemoteServer(
  context: RemoteMcpContext,
  server: McpServerRef,
  enabled: boolean,
): Promise<RemoteMcpResult> {
  const target = await writeTarget(context, server.scope);
  if (isRefusal(target)) return target;
  try {
    const { value: [outcome], path } = await setRemoteMcpServersEnabled(
      context.driver,
      target,
      [server.name],
      enabled,
      enabled ? webPasswordRefusal(context.internals) : undefined,
    );
    const failure = outcomeRefusal(outcome ?? { name: server.name, outcome: "missing" }, path);
    if (failure) return failure;
  } catch (error) {
    return writeRefusal(error);
  }
  forget(context);
  return done();
}

/** How one server's tools reach the model; nothing connects because of it. */
export async function setRemoteServerExposure(
  context: RemoteMcpContext,
  server: McpServerRef,
  exposure: McpExposure,
): Promise<RemoteMcpResult> {
  const target = await writeTarget(context, server.scope);
  if (isRefusal(target)) return target;
  try {
    const { value: outcome, path } = await setRemoteMcpServerExposure(context.driver, target, server.name, exposure);
    const failure = outcomeRefusal(outcome, path);
    if (failure) return failure;
  } catch (error) {
    return writeRefusal(error);
  }
  forget(context);
  return done();
}

/**
 * Turns a global server on or off in the panel's project alone: an override
 * entry in the project's `.pi/mcp.json`. The global entry must be one pi loads,
 * since an override of anything else is skipped.
 */
export async function switchRemoteServerInProject(
  context: RemoteMcpContext,
  name: string,
  enabled: boolean,
): Promise<RemoteMcpResult> {
  const target = await writeTarget(context, "project");
  if (isRefusal(target)) return target;
  if (target.scope !== "project") return refused(500, "internal", "No project file to write to");
  const read = readRemoteMcpEntry(
    context.globalText,
    remoteGlobalMcpPath(context.agentDir),
    "global",
    name,
    context.internals,
  );
  if (!read.ok) {
    const params = { path: read.path, ...(read.reason === "server-missing" ? { name } : {}) };
    if (read.reason === "unreadable") return refused(500, "internal", read.error ?? "", params);
    return refused(409, (read.reason ?? "server-missing") as McpRefusalReason, read.error ?? "", params);
  }
  if (!read.config) {
    return refused(409, "server-invalid", `MCP server "${name}" cannot be read`, { name });
  }
  if (enabled && findWebPasswordField(read.config, context.internals)) {
    return refused(409, "web-password", `"${name}" references PI_WEB_PASSWORD, so Pi Web does not turn it on`, { name });
  }
  try {
    const { value: outcome, path } = await setRemoteMcpServerEnabledInProject(context.driver, target, name, enabled);
    const failure = outcomeRefusal(outcome, path);
    if (failure) return failure;
  } catch (error) {
    return writeRefusal(error);
  }
  forget(context);
  return done();
}

/** The group switch: one write per file, a result per server. */
export async function switchRemoteServers(
  context: RemoteMcpContext,
  servers: McpServerRef[],
  enabled: boolean,
): Promise<RemoteMcpResult> {
  const results = new Map<string, McpActionItemResult>();
  const key = (server: McpServerRef) => `${server.scope}\0${server.name}`;
  for (const scope of ["global", "project"] as const) {
    const group = servers.filter((server) => server.scope === scope);
    if (group.length === 0) continue;
    const target = await writeTarget(context, scope);
    if (isRefusal(target)) {
      for (const server of group) results.set(key(server), { ...server, error: target.error, reason: target.reason });
      continue;
    }
    try {
      const { value: outcomes, path } = await setRemoteMcpServersEnabled(
        context.driver,
        target,
        group.map((server) => server.name),
        enabled,
        enabled ? webPasswordRefusal(context.internals) : undefined,
      );
      for (const outcome of outcomes) {
        const server = { scope, name: outcome.name };
        const failure = outcomeRefusal(outcome, path);
        results.set(key(server), failure ? { ...server, error: failure.error, reason: failure.reason } : server);
      }
    } catch (error) {
      const failure = writeRefusal(error);
      for (const server of group) results.set(key(server), { ...server, error: failure.error, reason: failure.reason });
    }
  }
  forget(context);
  return done({ results: servers.map((server) => results.get(key(server)) ?? server) });
}

/** Removes one server and answers with the undo token; the entry itself stays in this process. */
export async function removeRemoteServer(context: RemoteMcpContext, server: McpServerRef): Promise<RemoteMcpResult> {
  const target = await writeTarget(context, server.scope);
  if (isRefusal(target)) return target;
  let removed: Awaited<ReturnType<typeof removeRemoteMcpServer>>;
  try {
    removed = await removeRemoteMcpServer(context.driver, target, server.name);
  } catch (error) {
    return writeRefusal(error);
  }
  const { token, expiresAt } = holdRemovedEntry({
    ...server,
    path: removed.path,
    ...(target.scope === "project" ? { cwd: target.cwd } : {}),
    entry: removed.value.entry,
    index: removed.value.index,
  });
  forget(context);
  return done({ undo: { ...server, token, path: removed.path, expiresInMs: Math.max(0, expiresAt - Date.now()) } });
}

/** Puts a removed entry back where it stood, under the same checks as any write. */
export async function undoRemoteRemoval(context: RemoteMcpContext, token: string): Promise<RemoteMcpResult> {
  const held = takeRemovedEntry(token);
  if (!held) {
    return refused(410, "undo-unavailable", "Nothing to undo: the removal is unknown, already undone, or older than 60 seconds");
  }
  const server = { scope: held.scope, name: held.name };
  let failure: RemoteMcpRefusal | undefined;
  try {
    // A project entry's folder must still be trusted: the same gate as the write
    // that would have removed it, read from the snapshot this request already has.
    const target = await writeTarget(context, held.scope, held.scope === "project" ? held.cwd : undefined);
    if (isRefusal(target)) failure = target;
    else await insertRemoteMcpServer(context.driver, target, held.name, held.entry, held.index);
  } catch (error) {
    failure = isMcpConfigWriteError(error) && error.reason === "name-taken"
      ? refused(409, "undo-name-taken", `${error.path} defines "${held.name}" again, so the removal is not undone`, {
          path: error.path,
          name: held.name,
        })
      : writeRefusal(error);
  }
  if (failure) {
    // Still undoable once the cause is fixed, for the time it has left.
    returnRemovedEntry(held);
    return failure;
  }
  forget(context);
  return done({ restored: server });
}

/**
 * Signs out of a server as `pi mcp logout` does: the records of its URL are
 * deleted from the device's `mcp-auth.json`, and every sign-in run of that URL in
 * this process is barred from writing there again.
 */
export async function signOutRemoteServer(context: RemoteMcpContext, server: McpServerRef): Promise<RemoteMcpResult> {
  const target = await writeTarget(context, server.scope);
  if (isRefusal(target)) return target;
  const { name } = server;
  const read = readRemoteMcpEntry(
    fileText(context, server.scope),
    entryPath(context, server.scope),
    server.scope,
    name,
    context.internals,
  );
  if (!read.ok) {
    const params = { path: read.path, ...(read.reason === "server-missing" ? { name } : {}) };
    if (read.reason === "unreadable") return refused(500, "internal", read.error ?? "", params);
    return refused(409, (read.reason ?? "server-missing") as McpRefusalReason, read.error ?? "", params);
  }
  if (!isRecord(read.value)) {
    return refused(409, "entry-not-object", `${read.path} defines MCP server "${name}" as something other than an object`, { name });
  }
  // A project override signs in and out as the global server it changes: same name, same URL.
  let config = read.config;
  if (server.scope === "project" && isMcpOverrideEntry(read.value)) {
    const globalRead = readRemoteMcpEntry(
      context.globalText,
      remoteGlobalMcpPath(context.agentDir),
      "global",
      name,
      context.internals,
    );
    config = remoteOverrideConfig(globalRead.ok ? globalRead.config : undefined, read.value);
  }
  if (!config) return refused(409, "server-invalid", `MCP server "${name}" cannot be read`, { name });
  const url = mcpOAuthUrl(config);
  if (url === undefined) {
    return refused(409, "sign-in-not-oauth", `MCP server "${name}" does not use OAuth: only an HTTP server without an Authorization header does`, { name });
  }
  const { key, legacyKey } = mcpOAuthStoreKeys(name, url);
  noteMcpSignOut(key);
  let removed = false;
  try {
    const authPath = `${context.agentDir}/mcp-auth.json`;
    const text = (await readRemoteFiles(context.driver, [authPath])).get(authPath);
    const parsed = text === undefined ? {} : JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const states = { ...parsed };
      for (const candidate of [key, legacyKey]) {
        if (Object.hasOwn(states, candidate)) {
          delete states[candidate];
          removed = true;
        }
      }
      // The store's own bytes (`serializeStates()`): plain JSON, two-space, one trailing newline.
      if (removed) await writeRemoteFile(context.driver, authPath, JSON.stringify(states, null, 2) + NEWLINE);
    }
  } catch (error) {
    return refused(500, "internal", errorMessage(error), { name });
  }
  forgetMcpEntryStatuses({ scope: server.scope, sourcePath: read.path, name });
  forget(context);
  return done({ signedOut: { ...server, removed } });
}

/** The names a device's file defines now, for a name the add must not take. */
function namesInFile(context: RemoteMcpContext, scope: McpScope): string[] {
  return remoteNamesInFile(fileText(context, scope), entryPath(context, scope), scope);
}

function addRefusal({ status, reason, error, name, suggestedName, notes, names, fields }: McpAddRefusal): RemoteMcpRefusal {
  return refused(status, reason, error, {
    ...(name !== undefined ? { name } : {}),
    ...(suggestedName !== undefined ? { suggestedName } : {}),
    ...(notes ? { notes } : {}),
    ...(names ? { names } : {}),
    ...(fields ? { fields } : {}),
  });
}

function readAddRequest(body: Record<string, unknown>): McpAddRequest | RemoteMcpRefusal {
  const scope = body.scope === "global" || body.scope === "project" ? body.scope : undefined;
  const values = readMcpAddValues(body.values);
  const secretReferences = readMcpAddSecretReferences(body.secretReferences);
  const server = body.server === undefined ? 0 : body.server;
  const confirm = body.confirmHostEnv === undefined ? [] : body.confirmHostEnv;
  if (
    typeof body.text !== "string" || body.text.length > MCP_ADD_MAX_TEXT || !scope || !values || !secretReferences
    || typeof server !== "number" || !Number.isInteger(server) || server < 0
    || (body.name !== undefined && (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 1024))
    || (body.rawPi !== undefined && typeof body.rawPi !== "boolean")
    || (body.trustFolder !== undefined && typeof body.trustFolder !== "boolean")
    || !Array.isArray(confirm) || confirm.length > 100 || !confirm.every((entry) => typeof entry === "string")
  ) {
    return refused(400, "invalid-request", `add needs text (at most ${MCP_ADD_MAX_TEXT} characters), scope, and optionally values, secretReferences, server, name, rawPi, trustFolder and confirmHostEnv`);
  }
  return {
    text: body.text,
    values,
    secretReferences,
    server,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    scope,
    rawPi: body.rawPi === true,
    confirmHostEnv: confirm as string[],
  };
}

/**
 * Adds a pasted server: `prepareMcpAdd()` parses the text again, fills in the
 * values and checks the result; then it is appended to its file. A project
 * server goes only to a folder a decision trusts, except with `trustFolder` for
 * a fresh folder, which is trusted first and then written, as one step.
 */
export async function addRemoteServer(context: RemoteMcpContext, body: Record<string, unknown>): Promise<RemoteMcpResult> {
  const request = readAddRequest(body);
  if ("ok" in request) return request;
  const { scope } = request;
  if (scope === "project" && !context.cwd) return refused(400, "invalid-request", "A project server needs the project's cwd");
  const trustFolder = scope === "project" && body.trustFolder === true && context.cwd !== null;
  // Where it may go is said first: a confirmation asked for a server the folder then refuses would be asked for nothing.
  const target = trustFolder ? undefined : await writeTarget(context, scope);
  if (target && isRefusal(target)) return target;
  if (trustFolder && context.cwd) {
    const breadth = remoteTrustBreadth(context.trust, context.cwd, context.agentDir);
    if (breadth) {
      return refused(409, "trust-too-broad", `Trusting ${context.cwd} would also trust ${breadth.path}`, {
        breadth: { kind: breadth.kind, path: breadth.path },
      });
    }
    if (!remoteFolderIsFresh(context.trust, context.cwd)) {
      const status = remoteProjectTrustStatus(context.trust, context.cwd);
      return refused(409, "folder-not-fresh", `${context.cwd} is not a fresh folder, so trusting it is a decision of its own`, { trust: status });
    }
  }
  const prepared = prepareMcpAdd(request, { takenNames: namesInFile(context, scope), internals: context.internals });
  if (!prepared.ok) return addRefusal(prepared);
  const { name, entry } = prepared;

  if (trustFolder && context.cwd) {
    const cwd = context.cwd;
    const projectTarget = { scope: "project" as const, cwd };
    try {
      await setRemoteTrust(context.driver, context.agentDir, cwd, true);
    } catch (error) {
      return refused(409, "trust-unreadable", errorMessage(error));
    }
    try {
      const written = await insertRemoteMcpServer(context.driver, projectTarget, name, entry);
      invalidateRemoteModels(context.deviceId);
      forget(context);
      return done({
        added: { scope, name, path: written.path },
        trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false },
        trustedFolder: true,
      });
    } catch (error) {
      const failure = insertRefusal(error, context, scope);
      // The write's own reason still says why nothing was added; the trust is taken back.
      try {
        await setRemoteTrust(context.driver, context.agentDir, cwd, null);
      } catch (rollbackError) {
        return refused(failure.status, failure.reason, `${failure.error}; the folder stays trusted, since taking the trust back failed: ${errorMessage(rollbackError)}`, {
          ...failure.params,
          trustKept: true,
          trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false },
        });
      }
      return failure;
    }
  }

  if (!target || isRefusal(target)) return refused(500, "internal", "No file to write to");
  let path: string;
  try {
    ({ path } = await insertRemoteMcpServer(context.driver, target, name, entry));
  } catch (error) {
    return insertRefusal(error, context, scope);
  }
  invalidateRemoteModels(context.deviceId);
  forget(context);
  const trust = scope === "project" && context.cwd ? remoteProjectTrustStatus(context.trust, context.cwd) : undefined;
  return done({ added: { scope, name, path }, ...(trust && trust.decisionError === undefined ? { trust } : {}) });
}

/** A failed insert as the add answers it: a name taken meanwhile gets a free one to suggest. */
function insertRefusal(error: unknown, context: RemoteMcpContext, scope: McpScope): RemoteMcpRefusal {
  if (isMcpConfigWriteError(error) && error.reason === "name-taken" && error.serverName !== undefined) {
    const suggestedName = suggestFreeName(error.serverName, namesInFile(context, scope));
    return refused(409, "name-taken", error.message, { path: error.path, name: error.serverName, suggestedName });
  }
  return writeRefusal(error);
}

/** The entries a device's file defines, for the overview the route answers with. */
export function remoteMcpFiles(context: RemoteMcpContext): { files: McpResponse["files"] } {
  const files = [describeRemoteMcpFile(context.globalText, remoteGlobalMcpPath(context.agentDir), "global").info];
  if (context.cwd) files.push(describeRemoteMcpFile(context.projectText, remoteProjectMcpPath(context.cwd), "project").info);
  return { files };
}

/** The path a target names, for a caller that only wants to say where it wrote. */
export { remoteMcpTargetPath };
