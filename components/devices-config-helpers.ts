/**
 * The device editor's form state and the request body it sends.
 *
 * Kept out of the component because the interesting part is not the markup: it
 * is deciding which fields an edit sends. `PUT /api/devices` keeps a field the
 * body leaves out and clears a field the body sends as `""`, so a save that
 * echoed back a password the browser was never given would erase it.
 */

/** A saved device as `/api/devices` reports it: no secret, only whether one exists. */
export interface DeviceConfigEntry {
  id: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  defaultCwd?: string;
  mode?: "active_ssh" | "reverse_tunnel";
  hasPassword: boolean;
}

/** One device as the gateway currently sees it. */
export interface DeviceRuntimeInfo {
  id: string;
  name: string;
  mode: "active_ssh" | "reverse_tunnel";
  remoteAddr?: string;
  status: "online" | "offline" | "connecting";
}

export interface DeviceFileIssue {
  index: number;
  id?: string;
  reason: string;
}

export interface DevicesResponse {
  devices: DeviceRuntimeInfo[];
  configPath: string;
  configs: DeviceConfigEntry[];
  issues: DeviceFileIssue[];
  fileError?: string;
}

export interface DeviceReloadResponse {
  success?: boolean;
  path: string;
  configuredIds?: string[];
  issues?: DeviceFileIssue[];
  sync?: { connected: string[]; removed: string[]; unchanged: string[] };
  error?: string;
}

/** Every field the editor holds, as text: an input's value, never a parsed number. */
export interface DeviceDraft {
  id: string;
  name: string;
  /**
   * Which half of the gateway owns this device. A dialled device has an address
   * to reach; a dialled-in one does not, and asking for a host it cannot have
   * is the difference between "wrong password" and an unfillable form.
   */
  mode: "active_ssh" | "reverse_tunnel";
  host: string;
  port: string;
  username: string;
  privateKeyPath: string;
  password: string;
  defaultCwd: string;
  /** Whether the saved device already has a password this form never received. */
  hasPassword: boolean;
}

const DEFAULT_PORT = "22";

export function emptyDraft(): DeviceDraft {
  return {
    id: "",
    name: "",
    mode: "active_ssh",
    host: "",
    port: DEFAULT_PORT,
    username: "",
    privateKeyPath: "",
    password: "",
    defaultCwd: "",
    hasPassword: false,
  };
}

export function draftFromConfig(config: DeviceConfigEntry): DeviceDraft {
  return {
    id: config.id,
    name: config.name ?? "",
    mode: config.mode === "reverse_tunnel" ? "reverse_tunnel" : "active_ssh",
    host: config.host,
    port: String(config.port ?? DEFAULT_PORT),
    username: config.username,
    privateKeyPath: config.privateKeyPath ?? "",
    // Never echoed: the server does not send it, and a blank field means "keep
    // the saved one", which is exactly what leaving it out does.
    password: "",
    defaultCwd: config.defaultCwd ?? "",
    hasPassword: Boolean(config.hasPassword),
  };
}

/** Fields a save sends. Blank password means "leave the saved one alone". */
export function draftToBody(draft: DeviceDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    mode: draft.mode,
    host: draft.host.trim(),
    port: draft.port.trim(),
    username: draft.username.trim(),
    // Sent even when blank: the path is visible in the form, so clearing it is
    // what the user asked for. The password is not, so it is treated differently.
    privateKeyPath: draft.privateKeyPath.trim(),
    defaultCwd: draft.defaultCwd.trim(),
  };
  if (draft.password !== "") body.password = draft.password;
  return body;
}

/**
 * The first thing wrong with a draft, as an i18n key, or null when it can be
 * sent. The server validates everything again; this is only here so the common
 * mistakes do not need a round trip to be reported.
 */
export function draftProblem(draft: DeviceDraft): string | null {
  if (!draft.id.trim()) return "devices.problem.id";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(draft.id.trim())) return "devices.problem.idFormat";
  // A dialled-in device has no address of its own until it connects: the gateway
  // learns the address when the tunnel arrives, so demanding a host and port
  // here would ask for values the user cannot know.
  const dialled = draft.mode !== "reverse_tunnel";
  if (dialled && !draft.host.trim()) return "devices.problem.host";
  if (!draft.username.trim()) return "devices.problem.username";
  if (dialled) {
    const port = Number(draft.port.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "devices.problem.port";
  }
  return null;
}

/** True when this id already exists, so the form must edit rather than add. */
export function isSavedId(configs: readonly DeviceConfigEntry[], id: string): boolean {
  const trimmed = id.trim();
  return configs.some((config) => config.id === trimmed);
}

export function reloadSummary(sync: DeviceReloadResponse["sync"]): string | null {
  if (!sync) return null;
  const changed = sync.connected.length + sync.removed.length;
  return changed === 0 ? "unchanged" : "changed";
}
