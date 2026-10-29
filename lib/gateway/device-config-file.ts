import fs from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import type { ActiveDeviceConfig } from "./types/device";

/**
 * `devices.json`: the list of SSH hosts this gateway attaches to.
 *
 * The file lives in the repository root and is read once at startup, which used
 * to mean every change needed a restart. This module is the single reader and
 * writer, so the API can persist an add or a remove and then hand the parsed
 * list back to the SSH pool to connect or drop, and the Reload button in the UI
 * has one definition of "what the file says".
 */

export const DEVICES_FILE_NAME = "devices.json";

/** The device id a shell and the UI can use: a slug, so it survives URLs and paths. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function devicesConfigPath(): string {
  return path.resolve(process.cwd(), DEVICES_FILE_NAME);
}

/** One entry the file had but could not use, so the UI can say which and why. */
export interface DeviceFileIssue {
  /** Position in the file's array, counting from 0. */
  index: number;
  id?: string;
  reason: string;
}

export interface DevicesFileRead {
  path: string;
  /** The file exists and parsed. `false` with no `error` means no file yet. */
  exists: boolean;
  configs: ActiveDeviceConfig[];
  issues: DeviceFileIssue[];
  /** Set when the whole file is unusable (bad JSON, not an array, unreadable). */
  error?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * One file entry as a config, or the reason it is not one.
 *
 * Validation is strict on purpose: a half-valid entry would be connected with
 * a guessed port or user, which fails as a confusing authentication error
 * instead of as "this line is wrong".
 *
 * The two modes need different fields. An `active_ssh` entry is a host the
 * gateway dials, so `host` and `port` are required. A `reverse_tunnel` entry is
 * a machine that dials *in*, so it has no address of its own to dial: only the
 * identity (`id`, which must match the tunnel's SSH username) and the
 * credentials for the connection the tunnel carries.
 */
export function parseDeviceEntry(
  value: unknown,
): { config: ActiveDeviceConfig } | { reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "entry is not an object" };
  }
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  if (!id) return { reason: "missing id" };
  if (!DEVICE_ID_PATTERN.test(id)) {
    return { reason: `id "${id}" may use only letters, digits, dot, dash and underscore` };
  }
  const mode = raw.mode === "reverse_tunnel" ? "reverse_tunnel" : "active_ssh";
  const username = asString(raw.username);
  if (!username) return { reason: "missing username" };

  // A tunnel entry's address is always the gateway's own loopback: the port is
  // chosen when the device connects, so whatever `host`/`port` it carries would
  // be a guess. Rejecting the file over an address it cannot use would make the
  // entry look wrong when it is only irrelevant.
  const host = mode === "reverse_tunnel" ? (asString(raw.host) ?? "127.0.0.1") : asString(raw.host);
  if (!host) return { reason: "missing host" };

  const defaultPort = mode === "reverse_tunnel" ? 0 : 22;
  const port = raw.port === undefined ? defaultPort : Number(raw.port);
  const portValid = mode === "reverse_tunnel"
    ? port === 0 || (Number.isInteger(port) && port >= 1 && port <= 65535)
    : Number.isInteger(port) && port >= 1 && port <= 65535;
  if (!portValid) {
    return { reason: `port ${String(raw.port)} is not between 1 and 65535` };
  }

  const privateKeyPath = asString(raw.privateKeyPath);
  const password = asString(raw.password);
  if (privateKeyPath && password) {
    // Both work, but which one is used is the kind of ambiguity that shows up
    // as "the key was right and it still failed".
    return { reason: "set either privateKeyPath or password, not both" };
  }

  const config: ActiveDeviceConfig = {
    id,
    name: asString(raw.name) ?? id,
    host,
    port,
    username,
    mode,
  };
  if (privateKeyPath) config.privateKeyPath = privateKeyPath;
  if (password) config.password = password;
  if (asString(raw.defaultCwd)) config.defaultCwd = asString(raw.defaultCwd);
  return { config };
}

/** Read and validate the device file. Never throws: the caller decides what a broken file means. */
export function readDevicesFile(filePath: string = devicesConfigPath()): DevicesFileRead {
  const result: DevicesFileRead = { path: filePath, exists: false, configs: [], issues: [] };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
    result.exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    return { ...result, error: `cannot read ${filePath}: ${message(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ...result, error: `${DEVICES_FILE_NAME} is not valid JSON: ${message(error)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ...result, error: `${DEVICES_FILE_NAME} must contain an array of devices` };
  }

  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const parsedEntry = parseDeviceEntry(entry);
    if ("reason" in parsedEntry) {
      const id = entry && typeof entry === "object" ? asString((entry as { id?: unknown }).id) : undefined;
      result.issues.push({ index, id, reason: parsedEntry.reason });
      return;
    }
    if (seen.has(parsedEntry.config.id)) {
      result.issues.push({ index, id: parsedEntry.config.id, reason: `duplicate id "${parsedEntry.config.id}"` });
      return;
    }
    seen.add(parsedEntry.config.id);
    result.configs.push(parsedEntry.config);
  });
  return result;
}

/** The fields a file entry carries, in the order they are written. */
const WRITTEN_FIELDS = ["id", "name", "host", "port", "username", "privateKeyPath", "password", "mode", "defaultCwd"] as const;

/**
 * A config as the file stores it.
 *
 * `privateKey` (the key's contents) is deliberately not written: this file is
 * tracked by git, and a private key pasted into it would be committed. A device
 * added with inline key contents therefore works until the process restarts,
 * and the API tells the caller so.
 */
function serializeDevice(config: ActiveDeviceConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of WRITTEN_FIELDS) {
    const value = config[field];
    if (value === undefined || value === null || value === "") continue;
    // `mode: active_ssh` is the default, so writing it all the time would be noise.
    if (field === "mode" && value === "active_ssh") continue;
    out[field] = value;
  }
  return out;
}

function detectEol(filePath: string): string {
  try {
    const current = fs.readFileSync(filePath, "utf8");
    return current.includes("\r\n") ? "\r\n" : "\n";
  } catch {
    return "\n";
  }
}

/**
 * Replace the file's contents atomically.
 *
 * The end-of-line style of the existing file is kept: this file is tracked by
 * git, and rewriting every line to the other convention would bury a one-device
 * change under a whole-file diff.
 */
export function writeDevicesFile(configs: ActiveDeviceConfig[], filePath: string = devicesConfigPath()): void {
  const eol = detectEol(filePath);
  const body = configs.map((config) => serializeDevice(config));
  const json = JSON.stringify(body, null, 2).replace(/\n/g, eol) + eol;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writePrivateFileAtomicSync(filePath, json);
}

/** What an add or an edit sent; every field the form may set. */
export interface DeviceConfigInput {
  id?: unknown;
  name?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  privateKeyPath?: unknown;
  password?: unknown;
  defaultCwd?: unknown;
  mode?: unknown;
}

/** A config as the browser may see it: the secret itself is never sent, only whether one is set. */
export type PublicDeviceConfig = Omit<ActiveDeviceConfig, "password" | "privateKey"> & { hasPassword: boolean };

export function publicDeviceConfig(config: ActiveDeviceConfig): PublicDeviceConfig {
  const { password, privateKey: _privateKey, ...rest } = config;
  return { ...rest, hasPassword: Boolean(password) };
}

const EDITABLE_TEXT_FIELDS = ["name", "host", "username", "privateKeyPath", "password", "defaultCwd"] as const;

/**
 * Apply an edit to an existing config.
 *
 * A field the body leaves out keeps its current value, and a field the body
 * sends as `""` clears it. Without this the form would have to send the
 * password it was never given back on every save, and a device saved from the
 * settings pane would silently lose its credentials.
 */
function mergeConfig(current: ActiveDeviceConfig, input: DeviceConfigInput): { config: ActiveDeviceConfig } | { reason: string } {
  const merged: Record<string, unknown> = {
    id: current.id,
    name: current.name,
    host: current.host,
    port: current.port,
    username: current.username,
  };
  if (current.privateKeyPath !== undefined) merged.privateKeyPath = current.privateKeyPath;
  if (current.password !== undefined) merged.password = current.password;
  if (current.defaultCwd !== undefined) merged.defaultCwd = current.defaultCwd;
  if (current.mode !== undefined && current.mode !== "active_ssh") merged.mode = current.mode;

  for (const field of EDITABLE_TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return { reason: `${field} must be text` };
    if (value.trim().length === 0) delete merged[field];
    else merged[field] = value.trim();
  }

  // Mutually exclusive credentials: if a new password is provided without a new key,
  // clear any legacy keyPath; and if a new keyPath is provided without a new password,
  // clear any legacy password.
  if (typeof input.password === "string" && input.password.trim().length > 0 && !input.privateKeyPath) {
    delete merged.privateKeyPath;
  } else if (typeof input.privateKeyPath === "string" && input.privateKeyPath.trim().length > 0 && !input.password) {
    delete merged.password;
  }

  if (input.port !== undefined) {
    const port = typeof input.port === "string" ? Number(input.port.trim() === "" ? NaN : input.port) : input.port;
    if (typeof port !== "number" || Number.isNaN(port)) return { reason: `port ${String(input.port)} is not a number` };
    merged.port = port;
  }
  // A mode switch is a real edit: an `active_ssh` device that becomes
  // `reverse_tunnel` must stop being dialled out for, and vice versa.
  if (input.mode !== undefined) {
    if (input.mode !== "active_ssh" && input.mode !== "reverse_tunnel") {
      return { reason: `mode must be "active_ssh" or "reverse_tunnel"` };
    }
    merged.mode = input.mode;
  }

  return parseDeviceEntry(merged);
}

function toConfig(input: DeviceConfigInput, id: string): { config: ActiveDeviceConfig } | { reason: string } {
  const entry: Record<string, unknown> = { id };
  for (const field of ["name", "host", "port", "username", "privateKeyPath", "password", "defaultCwd", "mode"] as const) {
    const value = input[field];
    if (typeof value === "string" && value.trim().length > 0) entry[field] = value.trim();
    else if (typeof value === "number") entry[field] = value;
  }
  return parseDeviceEntry(entry);
}

/** Add a device to a list, refusing a duplicate id. Returns the new list. */
export function addDeviceToConfigs(
  configs: readonly ActiveDeviceConfig[],
  input: DeviceConfigInput,
): { configs: ActiveDeviceConfig[]; config: ActiveDeviceConfig } | { reason: string } {
  const id = asString(input.id);
  const idProblem = !id
    ? "missing id"
    : !DEVICE_ID_PATTERN.test(id)
      ? `id "${id}" may use only letters, digits, dot, dash and underscore`
      : configs.some((config) => config.id === id)
        ? `device "${id}" already exists`
        : null;
  if (idProblem || !id) return { reason: idProblem ?? "missing id" };

  const parsed = toConfig(input, id);
  if ("reason" in parsed) return parsed;
  return { configs: [...configs, parsed.config], config: parsed.config };
}

/**
 * Edit a device in place, keeping its position in the file.
 *
 * The id may not change: it is the key the registry, the URL and every saved
 * session use, so a rename would orphan them. Renaming means add + remove.
 */
export function updateDeviceInConfigs(
  configs: readonly ActiveDeviceConfig[],
  input: DeviceConfigInput,
): { configs: ActiveDeviceConfig[]; config: ActiveDeviceConfig } | { reason: string } {
  const id = asString(input.id);
  if (!id) return { reason: "missing id" };
  const index = configs.findIndex((config) => config.id === id);
  if (index < 0) return { reason: `no device "${id}"` };

  const parsed = mergeConfig(configs[index], input);
  if ("reason" in parsed) return parsed;
  const next = [...configs];
  next[index] = parsed.config;
  return { configs: next, config: parsed.config };
}

export function removeDeviceFromConfigs(
  configs: readonly ActiveDeviceConfig[],
  id: string,
): { configs: ActiveDeviceConfig[] } | { reason: string } {
  if (id === "localhost") return { reason: "cannot remove localhost" };
  const next = configs.filter((config) => config.id !== id);
  if (next.length === configs.length) return { reason: `no device "${id}"` };
  return { configs: next };
}

/**
 * Whether two configs open the same connection.
 *
 * Only the fields ssh2 receives are compared. A device's display name or its
 * default folder can change in Settings while it stays connected — dropping the
 * connection for those would kill its shells, terminals and open sessions for
 * something the remote host never sees. `host`, `port`, `username` and the
 * credential are what a reconnect would actually send.
 */
export function sameConnection(a: ActiveDeviceConfig, b: ActiveDeviceConfig): boolean {
  return a.host === b.host
    && a.port === b.port
    && a.username === b.username
    && (a.privateKeyPath ?? "") === (b.privateKeyPath ?? "")
    && (a.password ?? "") === (b.password ?? "")
    && String(a.privateKey ?? "") === String(b.privateKey ?? "")
    && (a.mode ?? "active_ssh") === (b.mode ?? "active_ssh");
}
