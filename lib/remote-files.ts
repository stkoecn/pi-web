import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { isHiddenOutsideGit, type FileTreeHiddenReason } from "@/lib/file-tree-visibility";
import { shellQuote } from "@/lib/shell-quote";
import { gunzipSync } from "node:zlib";

/**
 * Remote file access for a gateway device.
 *
 * Every function here exists so the device branch of `/api/files` can answer
 * with the SAME payload the local branch produces — the viewer, the explorer
 * and the upload dialog are shared code, so a different shape silently breaks
 * them (a remote `read` once returned `{text}` where the viewer expected
 * `{content, nextOffset, truncated}` and rendered an empty file).
 *
 * Shell round trips are used instead of SFTP wherever the answer is text:
 * measured on a 257 ms-RTT link, `driver.exec` through the persistent shell
 * costs ~300 ms while an SFTP `readdir` costs 1.1-4.2 s. Binary payloads still
 * go through SFTP (`driver.readFile` / `writeFile`).
 */

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
  hidden?: FileTreeHiddenReason;
}

export interface RemoteStat {
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * Run a POSIX script on the device with `sh`, regardless of the login shell.
 *
 * `driver.exec` sends its string to the device's shell as-is, and on macOS that
 * is zsh — which ABORTS on an unmatched glob (`zsh:1: no matches found: ..?*`)
 * where sh/bash leave the pattern literal. Encoding the script means the login
 * shell only ever sees an opaque base64 blob, so quoting, globs and `$` inside
 * the script behave the same on every device.
 */
async function runRemoteScript(
  driver: IHostDriver,
  script: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return driver.exec(`printf %s ${encoded} | base64 -d | sh`, [], { timeoutMs });
}

/**
 * A listing is expensive (one shell round trip per directory) and the explorer
 * re-lists on every finished tool call and on every window focus. Keeping the
 * last answer for a few seconds means those refreshes cost nothing while a file
 * written by a tool still shows up on the next real refresh.
 */
/** Delimits the size report that precedes a file slice's bytes. */
const SLICE_SIZE_MARKER = "@@piweb-size@@";
const LIST_CACHE_TTL_MS = 4_000;
const LIST_CACHE_LIMIT = 200;
interface ListCacheEntry { entries: RemoteEntry[]; at: number }
const listCache: Map<string, ListCacheEntry> =
  (globalThis as { __piWebRemoteListCache?: Map<string, ListCacheEntry> }).__piWebRemoteListCache ?? new Map();
(globalThis as { __piWebRemoteListCache?: Map<string, ListCacheEntry> }).__piWebRemoteListCache = listCache;

/** Forget cached listings: after a write, or for one device when it reconnects. */
export function invalidateRemoteListCache(deviceId?: string): void {
  if (!deviceId) { listCache.clear(); return; }
  for (const key of listCache.keys()) {
    if (key.startsWith(`${deviceId}\u0000`)) listCache.delete(key);
  }
}

/** One round trip: entry names, types, sizes, mtimes and git-ignored names. */
export async function listRemoteDirectory(
  driver: IHostDriver,
  directory: string,
  options: { showHidden?: boolean; force?: boolean } = {},
): Promise<RemoteEntry[]> {
  // The cache holds the FULL listing, hidden entries included, so the two
  // visibility settings share one round trip instead of evicting each other.
  const cacheKey = `${driver.deviceId}\u0000${directory}`;
  const cached = listCache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
    return filterHidden(cached.entries, options.showHidden);
  }
  // Globs rather than `ls` so a name with a space needs no quoting, and `-d`
  // rather than parsing `ls -l` so nothing depends on the column layout.
  // Ignored names are asked of the device's own git so the remote tree hides
  // exactly what the local tree hides.
  const script = [
    `cd ${shellQuote(directory)} 2>/dev/null || exit 4`,
    `if stat -f '%z' . >/dev/null 2>&1; then __bsd=1; else __bsd=0; fi`,
    `__names=\${TMPDIR:-/tmp}/.piweb-ls-$$`,
    `: > "$__names"`,
    `for p in .[!.]* ..?* *; do`,
    `  [ -e "$p" ] || [ -L "$p" ] || continue`,
    `  if [ -d "$p" ]; then __t=d; else __t=f; fi`,
    `  if [ "$__bsd" = 1 ]; then set -- $(stat -f '%z %m' "$p" 2>/dev/null); else set -- $(stat -c '%s %Y' "$p" 2>/dev/null); fi`,
    `  printf 'E\\t%s\\t%s\\t%s\\t%s\\n' "$__t" "\${1:-0}" "\${2:-0}" "$p"`,
    `  printf './%s\\n' "$p" >> "$__names"`,
    `done`,
    `if git rev-parse --git-dir >/dev/null 2>&1; then`,
    `  git check-ignore --no-index --stdin < "$__names" 2>/dev/null | while IFS= read -r g; do printf 'I\\t%s\\n' "$g"; done`,
    `fi`,
    `rm -f "$__names"`,
  ].join("\n");

  const result = await runRemoteScript(driver, script, 20_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "No such directory");
  }

  const ignored = new Set<string>();
  const entries: RemoteEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("I\t")) {
      const name = line.slice(2).replace(/^\.\//, "");
      ignored.add(name);
      continue;
    }
    if (!line.startsWith("E\t")) continue;
    const [, type, size, mtime, ...rest] = line.split("\t");
    const name = rest.join("\t");
    if (!name) continue;
    entries.push({
      name,
      isDir: type === "d",
      size: Number(size) || 0,
      modified: mtime ? new Date(Number(mtime) * 1000).toISOString() : "",
    });
  }

  const withHidden = entries.map((entry) => {
    const hidden: FileTreeHiddenReason | null = ignored.has(entry.name)
      ? "ignored"
      : isHiddenOutsideGit(entry.name) ? "excluded" : null;
    return hidden ? { ...entry, hidden } : entry;
  });

  // Dirs first, then files, both alphabetically — the local branch's order.
  withHidden.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  listCache.set(cacheKey, { entries: withHidden, at: Date.now() });
  if (listCache.size > LIST_CACHE_LIMIT) {
    const oldest = [...listCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) listCache.delete(oldest[0]);
  }
  return filterHidden(withHidden, options.showHidden);
}

/** Apply the visibility switch to a cached full listing. */
function filterHidden(entries: readonly RemoteEntry[], showHidden: boolean | undefined): RemoteEntry[] {
  return showHidden
    ? entries.filter((entry) => entry.hidden !== "always")
    : entries.filter((entry) => !entry.hidden);
}

/** `stat` for one device path; null when it does not exist. */
export async function statRemotePath(
  driver: IHostDriver,
  targetPath: string,
): Promise<RemoteStat | null> {
  const quoted = shellQuote(targetPath);
  const script = [
    `if [ -d ${quoted} ]; then __d=1; else __d=0; fi`,
    `if stat -f '%z %m' ${quoted} >/dev/null 2>&1; then set -- $(stat -f '%z %m' ${quoted}); else set -- $(stat -c '%s %Y' ${quoted}); fi`,
    `printf 'S\\t%s\\t%s\\t%s\\n' "$__d" "\${1:-0}" "\${2:-0}"`,
  ].join("\n");
  const result = await runRemoteScript(driver, script, 20_000);
  if (result.exitCode !== 0) return null;
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("S\t"));
  if (!line) return null;
  const [, isDir, size, mtime] = line.split("\t");
  return {
    isDirectory: isDir === "1",
    size: Number(size) || 0,
    mtimeMs: (Number(mtime) || 0) * 1000,
  };
}

/**
 * Bytes of `[offset, offset + length)` as base64.
 *
 * `head | tail` instead of `dd bs=1` so a 256 KB preview is two reads rather
 * than a quarter million syscalls. Base64 keeps the payload free of the
 * newlines and control bytes the shell framing has to survive.
 */
export async function readRemoteSlice(
  driver: IHostDriver,
  targetPath: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const quoted = shellQuote(targetPath);
  // Size and bytes in ONE round trip: the caller has already stat'ed the file
  // through SFTP (300-900 ms), and a second channel for the bytes doubled the
  // cost of simply opening a file. `stat` prints its size on a marker line so
  // the caller learns the real size even when the slice is capped.
  const script = [
    `if stat -f '%z' ${quoted} >/dev/null 2>&1; then __size=$(stat -f '%z' ${quoted}); else __size=$(stat -c '%s' ${quoted}); fi`,
    `printf '%s%s\n' '${SLICE_SIZE_MARKER}' "$__size"`,
    offset > 0
      ? `head -c ${offset + length} ${quoted} | tail -c +${offset + 1} | base64`
      : `head -c ${length} ${quoted} | base64`,
  ].join("\n");
  const result = await runRemoteScript(driver, script, 60_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to read file");
  }
  const markerAt = result.stdout.indexOf(SLICE_SIZE_MARKER);
  const payload = markerAt >= 0
    ? result.stdout.slice(markerAt + SLICE_SIZE_MARKER.length).replace(/^\d+\n?/, "")
    : result.stdout;
  return Buffer.from(payload.replace(/\s+/g, ""), "base64");
}

/**
 * Size of a remote file, without a second round trip when it was just read.
 *
 * `readRemoteSlice` reports the size alongside the bytes, so a text preview can
 * be answered by a single command instead of an SFTP stat followed by a read.
 */
export async function readRemoteSliceWithSize(
  driver: IHostDriver,
  targetPath: string,
  offset: number,
  length: number,
): Promise<{ bytes: Buffer; size: number }> {
  return readRemoteSliceInternal(driver, targetPath, offset, length);
}

/**
 * Slice a remote file, reporting its size in the same command.
 *
 * `size` is `-1` when the path is not a regular file (a directory, or nothing
 * at all). Distinguishing that without a second round trip is why the script
 * tests the type itself: `head -c` on a directory still succeeds on some
 * platforms and would otherwise look like an empty file.
 */
async function readRemoteSliceInternal(
  driver: IHostDriver,
  targetPath: string,
  offset: number,
  length: number,
): Promise<{ bytes: Buffer; size: number }> {
  const quoted = shellQuote(targetPath);
  const script = [
    `if [ ! -e ${quoted} ]; then printf '%s-1\\n' '${SLICE_SIZE_MARKER}'; exit 0; fi`,
    `if [ -d ${quoted} ]; then printf '%s-2\\n' '${SLICE_SIZE_MARKER}'; exit 0; fi`,
    `if stat -f '%z' ${quoted} >/dev/null 2>&1; then __size=$(stat -f '%z' ${quoted}); else __size=$(stat -c '%s' ${quoted}); fi`,
    `printf '%s%s\\n' '${SLICE_SIZE_MARKER}' "$__size"`,
    offset > 0
      ? `head -c ${offset + length} ${quoted} | tail -c +${offset + 1} | base64`
      : `head -c ${length} ${quoted} | base64`,
  ].join("\n");
  const result = await runRemoteScript(driver, script, 60_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to read file");
  }
  const markerAt = result.stdout.indexOf(SLICE_SIZE_MARKER);
  if (markerAt < 0) {
    return { bytes: Buffer.alloc(0), size: -1 };
  }
  const afterMarker = result.stdout.slice(markerAt + SLICE_SIZE_MARKER.length);
  const newlineAt = afterMarker.indexOf("\n");
  const sizeText = (newlineAt >= 0 ? afterMarker.slice(0, newlineAt) : afterMarker).trim();
  const payload = newlineAt >= 0 ? afterMarker.slice(newlineAt + 1) : "";
  const size = Number(sizeText);
  return {
    bytes: Buffer.from(payload.replace(/\s+/g, ""), "base64"),
    size: Number.isFinite(size) ? size : -1,
  };
}

/**
 * Text file contents, deflated on the device before it crosses the link.
 *
 * JSONL transcripts are highly repetitive — measured on a real 1.2 MB macOS
 * transcript, `gzip -c | base64` put 312 KiB on the wire instead of 1178 KiB
 * and finished in 136 ms instead of 375 ms; on a 64 KB set of small
 * transcripts the ratio was 6.2x. The `base64` wrapper keeps the payload free
 * of the newlines and control bytes the shell framing must survive.
 *
 * `gzip` is assumed present (it is on every Unix-like device pi runs on); when
 * it is missing the command fails and the plain path below is used, so this
 * degrades to the previous behaviour instead of breaking the read.
 */
export async function readRemoteTextFile(
  driver: IHostDriver,
  filePath: string,
): Promise<string> {
  const quoted = shellQuote(filePath);
  const compressed = await driver.exec(`gzip -c ${quoted} | base64`, [], { timeoutMs: 60_000 });
  if (compressed.exitCode === 0) {
    const bytes = Buffer.from(compressed.stdout.replace(/\s+/g, ""), "base64");
    if (bytes.length > 0) {
      try {
        return gunzipSync(bytes).toString("utf8");
      } catch {
        // A truncated stream must not lose the file: fall through to plain.
      }
    }
  }
  const plain = await driver.exec(`base64 ${quoted}`, [], { timeoutMs: 60_000 });
  if (plain.exitCode !== 0) {
    throw new Error(plain.stderr.trim() || `cannot read ${filePath} (exit ${plain.exitCode})`);
  }
  return Buffer.from(plain.stdout.replace(/\s+/g, ""), "base64").toString("utf8");
}

/** Whole file as bytes, over SFTP. */
export async function readRemoteBuffer(
  driver: IHostDriver,
  targetPath: string,
): Promise<Buffer> {
  return driver.readFile(targetPath);
}

/** Existence check for a batch of names in one directory, in one round trip. */
export async function inspectRemoteUploadTargets(
  driver: IHostDriver,
  directory: string,
  fileNames: readonly string[],
): Promise<{ conflicts: string[]; nonReplaceable: string[] }> {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];
  if (fileNames.length === 0) return { conflicts, nonReplaceable };

  const quoted = shellQuote(directory);
  const script = [
    `cd ${quoted} 2>/dev/null || exit 0`,
    `for n in ${fileNames.map((name) => shellQuote(name)).join(" ")}; do`,
    `  if [ -e "$n" ] || [ -L "$n" ]; then`,
    `    if [ -f "$n" ] && [ ! -L "$n" ]; then printf 'C\\t%s\\n' "$n"; else printf 'N\\t%s\\n' "$n"; fi`,
    `  fi`,
    `done`,
  ].join("\n");
  const result = await runRemoteScript(driver, script, 20_000);
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("C\t")) conflicts.push(line.slice(2));
    else if (line.startsWith("N\t")) {
      conflicts.push(line.slice(2));
      nonReplaceable.push(line.slice(2));
    }
  }
  return { conflicts, nonReplaceable };
}
