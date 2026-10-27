import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { serializeByKey } from "@/lib/key-serializer";
import { readRegularFileText } from "@/lib/regular-file";

// Which hosts the user has switched on.
//
// The list in `~/.ssh/config` is what ssh *can* reach, not what this gateway
// should hold open: a config with twenty stanzas would otherwise mean twenty
// devices in the switcher, each one a machine the user never asked to serve
// from a browser. So the file below records the few that were turned on, and
// everything else is offered but inert until then.
//
// It is separate from `devices.json` on purpose. That file is the reverse
// tunnels the user typed in — an editable list with names, users and keys —
// while this one is a set of ids the gateway derives from a file ssh owns. A
// single `enabled: true` flag inside `devices.json` would mean writing a copy
// of every discovered host into it, which is the duplication the discovery
// path exists to avoid.
//
// Lives beside pi's own files so a checkout stays clean and a second Pi Web
// process on the same machine sees the same answer.

const MAX_BYTES = 512 * 1024;
const QUEUE_KEY: symbol = Symbol.for("pi-web:enabled-hosts-write-queue");
const LOCK_OPTIONS = {
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  realpath: false,
};

export function enabledHostsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-enabled-hosts.json");
}

interface Document {
  /** `false` means "every discovered host is offered"; the file says so explicitly. */
  defaultEnabled: boolean;
  enabled: string[];
  disabled: string[];
}

const EMPTY: Document = { defaultEnabled: false, enabled: [], disabled: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function parse(text: string | undefined): Document {
  if (text === undefined) return EMPTY;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  if (!isRecord(raw)) return EMPTY;
  return {
    defaultEnabled: raw.defaultEnabled === true,
    enabled: strings(raw.enabled),
    disabled: strings(raw.disabled),
  };
}

function serialize(document: Document): string {
  return `${JSON.stringify(
    {
      defaultEnabled: document.defaultEnabled,
      enabled: [...new Set(document.enabled)].sort(),
      disabled: [...new Set(document.disabled)].sort(),
    },
    null,
    2,
  )}\n`;
}

// One stat per read: the switcher and the settings pane both ask on a timer.
const cache = new Map<string, { mtimeMs: number; size: number; ino: number; document: Document }>();

function load(path: string): Document {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    cache.delete(path);
    return EMPTY;
  }
  const cached = cache.get(path);
  if (
    cached
    && cached.mtimeMs === stats.mtimeMs
    && cached.size === stats.size
    && cached.ino === stats.ino
  ) {
    return cached.document;
  }
  const document = parse(readRegularFileText(path, MAX_BYTES));
  cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, document });
  return document;
}

/** Never throws: an unreadable or corrupt file reads as "nothing is enabled". */
export function readEnabledHosts(path?: string): Document {
  try {
    return load(path ?? enabledHostsPath());
  } catch {
    return EMPTY;
  }
}

/**
 * Whether the switcher may offer this host.
 *
 * A device the user saved in `devices.json` is always on — that file is the
 * request itself. Everything else follows the set.
 */
export function isHostEnabled(id: string, path?: string): boolean {
  const document = readEnabledHosts(path);
  if (document.enabled.includes(id)) return true;
  if (document.disabled.includes(id)) return false;
  return document.defaultEnabled;
}

/**
 * Turn one host on or off.
 *
 * The id is removed from the opposite list as it is added to this one, so the
 * two lists cannot both claim the same host and leave the answer dependent on
 * the order they are read in.
 */
export function setHostEnabled(id: string, enabled: boolean, path?: string): Promise<void> {
  const target = path ?? enabledHostsPath();
  return serializeByKey(QUEUE_KEY, target, async () => {
    mkdirSync(dirname(target), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(target, LOCK_OPTIONS);
    } catch {
      // A lock we cannot take must not swallow the click: fall through and
      // write anyway. A lost race costs one flag, not a device.
      release = async () => {};
    }
    try {
      const current = parse(readRegularFileText(target, MAX_BYTES));
      const next: Document = {
        defaultEnabled: current.defaultEnabled,
        enabled: current.enabled.filter((entry) => entry !== id),
        disabled: current.disabled.filter((entry) => entry !== id),
      };
      (enabled ? next.enabled : next.disabled).push(id);
      writePrivateFileAtomicSync(target, serialize(next));
      cache.delete(target);
    } finally {
      try {
        await release();
      } catch {
        // Already reported by the lock's own onCompromised.
      }
    }
  });
}
