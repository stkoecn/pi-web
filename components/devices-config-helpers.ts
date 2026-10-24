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

/**
 * A host `~/.ssh/config` names, offered rather than saved.
 *
 * It has no `hasPassword` and no mode because nothing about it is the gateway's
 * yet: it is what `ssh <alias>` would do. `configured` is true when
 * `devices.json` already describes the same id, in which case this row is the
 * saved device and the discovery adds nothing.
 */
export interface SshDiscoveredHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  configured: boolean;
  /**
   * Set when `ssh` would need something the gateway cannot do, such as
   * `ProxyJump`. The row still fills the form - the address is right - but
   * the pane says the connection will not come up as written.
   */
  unsupported?: string;
}

export interface DevicesResponse {
  devices: DeviceRuntimeInfo[];
  configPath: string;
  configs: DeviceConfigEntry[];
  issues: DeviceFileIssue[];
  /** The file the hosts were read from, for the pane's subtitle. */
  sshConfigPath?: string;
  sshHosts?: SshDiscoveredHost[];
  /** Hosts the parser could not use (a missing key, a bad port, ProxyJump). */
  sshProblems?: string[];
  sshError?: string;
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

/**
 * A device the gateway cannot dial: one that dials in.
 *
 * There is no address, port or password here because there is nothing to dial
 * and nobody types a secret the device already holds. A host the gateway
 * reaches is read from `~/.ssh/config` instead, where ssh keeps its own
 * credentials — so this form is only ever about the one direction ssh cannot
 * describe.
 */
export interface DeviceDraft {
  id: string;
  name: string;
  username: string;
  privateKeyPath: string;
  defaultCwd: string;
}

/** The gateway's own pairing key: the device authorises it, so nothing is typed. */
export const PAIRING_KEY_PATH = "~/.pi/gateway_ed25519";

export function emptyDraft(): DeviceDraft {
  return {
    id: "",
    name: "",
    username: "",
    privateKeyPath: PAIRING_KEY_PATH,
    defaultCwd: "",
  };
}

export function draftFromConfig(config: DeviceConfigEntry): DeviceDraft {
  return {
    id: config.id,
    name: config.name ?? "",
    username: config.username,
    privateKeyPath: config.privateKeyPath ?? PAIRING_KEY_PATH,
    defaultCwd: config.defaultCwd ?? "",
  };
}

/** Fields a save sends. `mode` is not a choice: this pane only writes tunnels. */
export function draftToBody(draft: DeviceDraft): Record<string, unknown> {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    mode: "reverse_tunnel",
    username: draft.username.trim(),
    // Sent even when blank: the path is visible in the form, so clearing it is
    // what the user asked for.
    privateKeyPath: draft.privateKeyPath.trim(),
    defaultCwd: draft.defaultCwd.trim(),
  };
}

/**
 * The first thing wrong with a draft, as an i18n key, or null when it can be
 * sent. The server validates everything again; this is only here so the common
 * mistakes do not need a round trip to be reported.
 */
export function draftProblem(draft: DeviceDraft): string | null {
  if (!draft.id.trim()) return "devices.problem.id";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(draft.id.trim())) return "devices.problem.idFormat";
  if (!draft.username.trim()) return "devices.problem.username";
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
