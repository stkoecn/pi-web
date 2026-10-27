import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "@/lib/file-fuzzy";
import { isHiddenOutsideGit } from "@/lib/file-tree-visibility";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { getGateway } from "@/lib/gateway/singleton";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { shellQuote } from "@/lib/shell-quote";

const execFileAsync = promisify(execFile);

/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      // The file tree's name list, only for this non-git fallback. Git repos
      // rely on .gitignore instead (matches the TUI's fd behavior).
      if (isHiddenOutsideGit(d.name)) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: false };
}

/**
 * Listing for a gateway device.
 *
 * The local path uses `git ls-files` then a synchronous readdir walk; both are
 * meaningless for a remote cwd, so the device is asked to produce the same
 * newline-separated relative list with its own tools. One round trip: git when
 * the directory is a repository, otherwise `find` capped to the same limits.
 */
async function listRemoteWithGit(driver: IHostDriver, cwd: string): Promise<FileListing | null> {
  const quoted = shellQuote(cwd);
  try {
    // Exit 3 means "not a repository", so the caller falls back to the walk. The
    // repository test has to happen before the pipe: `git | head` reports
    // `head`'s status, which is always 0, and an empty listing would then look
    // like a repository with no files.
    const result = await driver.exec(
      `cd ${quoted} 2>/dev/null || exit 4; ` +
      `git rev-parse --git-dir >/dev/null 2>&1 || exit 3; ` +
      `git ls-files --cached --others --exclude-standard -z 2>/dev/null | head -c 67108864`,
      [],
      { timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0) return null;
    const all = result.stdout.split("\0").filter(Boolean);
    if (all.length > GIT_HARD_CAP) return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    return { files: all, hardTruncated: false };
  } catch {
    return null;
  }
}

async function listRemoteWithWalk(driver: IHostDriver, cwd: string): Promise<FileListing> {
  const quoted = shellQuote(cwd);
  // BFS-ish: `find -maxdepth` bounded, hidden names filtered the way the local
  // walk filters them (dotfiles outside git are skipped).
  const result = await driver.exec(
    `cd ${quoted} 2>/dev/null && find . -maxdepth ${MAX_WALK_DEPTH} -type f 2>/dev/null | head -n ${WALK_HARD_CAP + 1}`,
    [],
    { timeoutMs: 20_000 },
  );
  if (result.exitCode !== 0) return { files: [], hardTruncated: false };
  const files = result.stdout
    .split("\n")
    .map((line) => line.replace(/^\.\//, "").trim())
    .filter((line) => line && line.split("/").every((part) => !isHiddenOutsideGit(part)));
  const hardTruncated = files.length > WALK_HARD_CAP;
  return { files: hardTruncated ? files.slice(0, WALK_HARD_CAP) : files, hardTruncated };
}

// GET /api/file-index?cwd=/abs/path[&q=query]
// Without q: { files: string[] (relative to cwd, capped at MAX_FILES),
// truncated: boolean } — the client-side index for local filtering.
// With q: { matches: { path, isDir }[] } — ranked against the FULL listing so
// repos larger than MAX_FILES still find deep files (cap applied after
// matching, like the TUI passing the query to fd).
// Guarded by the same allow-list as /api/files.
export async function GET(req: NextRequest) {
  try {
    const cwd = req.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    const query = req.nextUrl.searchParams.get("q")?.slice(0, MAX_QUERY_LENGTH) ?? "";

    const deviceId = getRequestDeviceId(req);
    if (isRemoteDevice(deviceId)) {
      // A remote cwd is not on this filesystem, so the allow-list below would
      // always refuse it. The device's own paths are the whole namespace there.
      const driver = await getGateway().getOrConnectDriver(deviceId);
      const key = `${deviceId}\u0000${cwd}`;
      const cache = getIndexCache();
      const now = Date.now();
      let cached = cache.get(key);
      if (!cached || cached.expiresAt <= now) {
        const listing = (await listRemoteWithGit(driver, cwd)) ?? await listRemoteWithWalk(driver, cwd);
        for (const [cacheKey, entry] of cache) {
          if (entry.expiresAt <= now) cache.delete(cacheKey);
        }
        if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
        cached = { listing, expiresAt: now + CACHE_TTL_MS };
        cache.set(key, cached);
      }
      if (query) {
        cached.entries ??= buildEntriesFromFiles(cached.listing.files);
        return NextResponse.json({ matches: filterFileEntries(cached.entries, query) });
      }
      const { files, hardTruncated } = cached.listing;
      return NextResponse.json({
        files: files.slice(0, MAX_FILES),
        truncated: hardTruncated || files.length > MAX_FILES,
      });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const cache = getIndexCache();
    const now = Date.now();
    let cached = cache.get(cwd);
    if (!cached || cached.expiresAt <= now) {
      const listing = (await listWithGit(cwd)) ?? listWithWalk(cwd);
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cached = { listing, expiresAt: now + CACHE_TTL_MS };
      cache.set(cwd, cached);
    }

    if (query) {
      cached.entries ??= buildEntriesFromFiles(cached.listing.files);
      return NextResponse.json({ matches: filterFileEntries(cached.entries, query) });
    }

    const { files, hardTruncated } = cached.listing;
    return NextResponse.json({
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
