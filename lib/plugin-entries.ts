import type { PackageSource } from "@earendil-works/pi-coding-agent";
import { parseNpmSource } from "@/lib/npm-source";

/**
 * What a plugin entry in `settings.json` means, apart from who writes it.
 *
 * `packages` in a settings file is a list of strings or objects; an object with
 * all four resource lists empty is how pi records "installed but switched off",
 * and an object with filters is how a package's resources are narrowed by hand.
 * The local route and the remote one must agree on every one of those readings —
 * a device's `settings.json` is the same file — so the rules live here, free of
 * `SettingsManager` and of any file system.
 */

/** The source a `packages` entry names, whichever of the two forms it uses. */
export function getPackageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

/** Whether this entry is pi's "installed, switched off" form. */
export function isDisabledPackage(entry: PackageSource): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) && entry.extensions.length === 0 &&
    Array.isArray(entry.skills) && entry.skills.length === 0 &&
    Array.isArray(entry.prompts) && entry.prompts.length === 0 &&
    Array.isArray(entry.themes) && entry.themes.length === 0
  );
}

/**
 * An enabled entry that is an object: it filters the package's resources, or
 * sets `autoload`. Disabling replaces its resource lists, and Pi Web keeps no
 * copy, so enabling it again cannot bring the filters back.
 */
export function hasEntrySettings(entry: PackageSource): boolean {
  return typeof entry === "object" && !isDisabledPackage(entry);
}

export const FILTERED_PACKAGE_ERROR =
  "Has resource filters, which disabling would remove; use the package's own switch";

export interface PackagesDisabledEdit {
  next: PackageSource[];
  /** Sources this list does not configure. */
  missing: Set<string>;
  /** Sources left enabled because disabling them would drop their filters. */
  kept: Set<string>;
  changed: boolean;
}

/**
 * Switch the given packages of one scope on or off, returning the list to write.
 *
 * An entry already in the requested state is left exactly as it is, and enabling
 * keeps every key except the emptied resource lists (`autoload` on a project
 * entry, say), so neither drops what the entry configures. A source that is the
 * only key of an object entry collapses back to the plain string pi writes for a
 * package with nothing configured.
 */
export function applyPackagesDisabled(
  entries: readonly PackageSource[],
  sources: readonly string[],
  disabled: boolean,
  { keepEntrySettings = false }: { keepEntrySettings?: boolean } = {},
): PackagesDisabledEdit {
  const missing = new Set(sources);
  const kept = new Set<string>();
  let changed = false;
  const next = entries.map((entry): PackageSource => {
    const source = getPackageSource(entry);
    if (!sources.includes(source)) return entry;
    missing.delete(source);
    if (isDisabledPackage(entry) === disabled) return entry;
    if (disabled && keepEntrySettings && hasEntrySettings(entry)) {
      kept.add(source);
      return entry;
    }
    changed = true;
    if (disabled) {
      return {
        ...(typeof entry === "string" ? { source: entry } : entry),
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
    }
    if (typeof entry === "string") return source;
    const rest = { ...entry };
    delete rest.extensions;
    delete rest.skills;
    delete rest.prompts;
    delete rest.themes;
    return Object.keys(rest).length > 1 ? rest : source;
  });
  return { next, missing, kept, changed };
}

/** The version a source pins, when it pins one; `npm:` specs and `git:` refs alike. */
export function configuredVersionOf(source: string): string | undefined {
  const npm = parseNpmSource(source);
  if (npm) return npm.version;
  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    const lastAt = source.lastIndexOf("@");
    const lastSlash = source.lastIndexOf("/");
    const lastColon = source.lastIndexOf(":");
    if (lastAt > Math.max(lastSlash, lastColon)) return source.slice(lastAt + 1) || undefined;
  }
  return undefined;
}
