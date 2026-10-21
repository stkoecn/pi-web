import { parseJsonc } from "@/lib/jsonc";
import type { DefaultPreferencesEdit } from "@/lib/default-preferences";

/**
 * Pure half of the remote default-preferences write.
 *
 * Kept apart from `lib/remote-default-preferences.ts` for one reason: that module
 * talks to a device over SSH (`server-only`, gateway singletons), while the rules
 * that decide *what* gets written are pure functions worth testing directly.
 */

export interface ParsedSettings {
  value: Record<string, unknown> | null;
  error?: string;
}

/**
 * Parse a settings file body.
 *
 * Comments and trailing commas are accepted because pi's own loader tolerates
 * them upstream (`SettingsManager` strips them on read); an unparseable file is
 * reported rather than replaced, since it holds settings this module cannot see.
 */
export function parseSettingsObject(text: string): ParsedSettings {
  if (!text.trim()) return { value: null };
  try {
    const parsed = parseJsonc(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, error: "not a JSON object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Merge the edit into the settings object the way `SettingsManager` does.
 *
 * Only the keys being changed are touched. A key the edit does not mention —
 * including ones this module knows nothing about — survives untouched, which is
 * what makes it safe to write a file users also edit by hand.
 */
export function mergeDefaultPreferences(
  current: Record<string, unknown> | null,
  edit: DefaultPreferencesEdit,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  if (edit.model) {
    next.defaultProvider = edit.model.provider;
    next.defaultModel = edit.model.modelId;
  }
  if (edit.thinkingLevel) next.defaultThinkingLevel = edit.thinkingLevel;
  return next;
}

/** Project settings keys that would hide this edit on the device. */
export function shadowingRemoteProjectKeys(
  project: Record<string, unknown> | null,
  edit: DefaultPreferencesEdit,
): string[] {
  if (!project) return [];
  const keys: string[] = [];
  if (edit.model) {
    if (project.defaultProvider !== undefined) keys.push("defaultProvider");
    if (project.defaultModel !== undefined) keys.push("defaultModel");
  }
  if (edit.thinkingLevel && project.defaultThinkingLevel !== undefined) keys.push("defaultThinkingLevel");
  return keys;
}

/** The keys a given edit actually writes, in the order they appear in the file. */
export function writtenKeys(edit: DefaultPreferencesEdit): string[] {
  const keys: string[] = [];
  if (edit.model) keys.push("defaultProvider", "defaultModel");
  if (edit.thinkingLevel) keys.push("defaultThinkingLevel");
  return keys;
}

/**
 * Serialize the merged settings with a trailing newline.
 *
 * `JSON.stringify` never emits one, so it is added here: POSIX text files end
 * with a newline, `SettingsManager` writes one through the same shape, and a file
 * without it makes the next append (this module's included) land on the last
 * line. The `previous` argument is unused by the current shape and kept out
 * deliberately — "match the old habit" is how a missing newline propagates.
 */
export function serializeSettings(merged: Record<string, unknown>): string {
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** The string values in a settings object, as the API reports them. */
export function readDefaultsFromSettings(value: Record<string, unknown> | null): {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
} {
  const str = (key: string): string | null => {
    const raw = value?.[key];
    return typeof raw === "string" && raw ? raw : null;
  };
  return {
    defaultProvider: str("defaultProvider"),
    defaultModel: str("defaultModel"),
    defaultThinkingLevel: str("defaultThinkingLevel"),
  };
}
