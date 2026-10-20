/**
 * Remote session storage, read through the gateway.
 *
 * Everything here exists so a remote device can be served by the SAME builders
 * the local host uses (`buildSessionList`, `buildSessionContext`,
 * `computeSessionStats`, `computeSessionRevision`). The only thing that differs
 * is where the bytes come from: SFTP instead of `node:fs`.
 *
 * Round-trip budget matters more than anything else on this path. A per-file
 * SSH exec costs ~40-200 ms, so listing N sessions serially used to cost
 * seconds. Every call below is one round trip, and results are cached by file
 * fingerprint (size + mtime) so an unchanged transcript is never re-read.
 */

import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { getGateway } from "@/lib/gateway/singleton";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { readRemoteTextFile } from "@/lib/remote-files";
import type { SessionInfo } from "@/lib/types";
import { attachSessionProjectInfo } from "@/lib/session-reader";

/** How long a device's session catalogue is trusted before re-listing. */
const REMOTE_LIST_TTL_MS = 15_000;
/** How long a fetched transcript is trusted before re-reading it. */
const REMOTE_CONTENT_TTL_MS = 60_000;
/** Sessions listed per device. Newest first, so the cap keeps the useful ones. */
const REMOTE_LIST_LIMIT = 200;
const REMOTE_CACHE_LIMIT = 24;

export interface RemoteSessionFile {
	/** Absolute path on the remote host. */
	path: string;
	sessionId: string;
	cwd: string;
	size: number;
	mtimeMs: number;
}

export interface RemoteSessionManager {
	sm: SessionManager;
	filePath: string;
	sessionId: string;
	cwd: string;
	size: number;
	mtimeMs: number;
}

interface CatalogueEntry {
	file: RemoteSessionFile;
	messageCount: number;
	firstMessage: string;
	name?: string;
}

interface CatalogueCache {
	ts: number;
	/** True when only headers were read; `messageCount` is 0 for every row. */
	deferred: boolean;
	entries: CatalogueEntry[];
}

interface ContentCache {
	ts: number;
	size: number;
	mtimeMs: number;
	content: string;
}

declare global {
	var __piWebRemoteCatalogue: Map<string, CatalogueCache> | undefined;
	var __piWebRemoteContent: Map<string, ContentCache> | undefined;
	var __piWebRemoteManagers: Map<string, { size: number; mtimeMs: number; manager: RemoteSessionManager }> | undefined;
}

const catalogues: Map<string, CatalogueCache> =
	globalThis.__piWebRemoteCatalogue ?? (globalThis.__piWebRemoteCatalogue = new Map());
const contents: Map<string, ContentCache> =
	globalThis.__piWebRemoteContent ?? (globalThis.__piWebRemoteContent = new Map());
const managers: Map<string, { size: number; mtimeMs: number; manager: RemoteSessionManager }> =
	globalThis.__piWebRemoteManagers ?? (globalThis.__piWebRemoteManagers = new Map());

function trimCache<T>(cache: Map<string, T>) {
	while (cache.size > REMOTE_CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/** Drop everything cached for a device (or for every device). */
export function invalidateRemoteSessionCache(deviceId?: string) {
	if (!deviceId) {
		catalogues.clear();
		contents.clear();
		managers.clear();
		return;
	}
	catalogues.delete(deviceId);
	for (const key of [...contents.keys()]) {
		if (key.startsWith(`${deviceId}\u0000`)) contents.delete(key);
	}
	for (const key of [...managers.keys()]) {
		if (key.startsWith(`${deviceId}\u0000`)) managers.delete(key);
	}
}

/**
 * The device's driver for a read the user is waiting on.
 *
 * `getDriverForRequest` still waits out a first connect (a page load may
 * legitimately arrive before the pool's first handshake) but answers at once
 * for a device whose connection dropped, instead of adding ten seconds to a
 * request that the pool's own reconnect is going to satisfy later anyway.
 */
async function getDriver(deviceId: string): Promise<IHostDriver> {
	return getGateway().getDriverForRequest(deviceId);
}

/**
 * Run a shell script on the device.
 *
 * The script is base64-encoded and piped into `sh`, because every attempt to
 * quote a multi-line script inline runs into a second layer of shell quoting
 * (`exec` already joins argv with double quotes). Base64 makes the payload
 * opaque to the remote shell, so the script can use quotes freely.
 */
async function runScript(driver: IHostDriver, script: string): Promise<string> {
	const encoded = Buffer.from(script, "utf8").toString("base64");
	const res = await driver.exec(`printf %s ${encoded} | base64 -d | sh`);
	if (res.exitCode !== 0 && !res.stdout) {
		throw new Error(res.stderr.trim() || `remote script failed (exit ${res.exitCode})`);
	}
	return res.stdout;
}

/**
 * Transcript text, over the persistent shell instead of SFTP.
 *
 * SFTP costs ~1-2.4 s for a single 8 KB file on a 257 ms-RTT link (channel
 * setup plus per-packet round trips), while a shell command over an already-open
 * `sh` costs ~0.3 s. `readRemoteTextFile` also deflates the payload on the
 * device first, which cut a 1.2 MB transcript from 1178 KiB to 312 KiB.
 */
async function readTextFile(driver: IHostDriver, filePath: string): Promise<string> {
	return readRemoteTextFile(driver, filePath);
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const t = new Date(value).getTime();
	return Number.isNaN(t) ? undefined : t;
}

function firstTextOf(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } =>
			!!block && typeof block === "object"
			&& (block as { type?: unknown }).type === "text"
			&& typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join(" ");
}

/**
 * One round trip for the whole catalogue: path, size, mtime, the session header
 * (line 1), a message count, and the first user message / session name.
 *
 * `$HOME` is expanded by the remote shell in the same script, so there is no
 * separate "where are the sessions" call. `grep -c` over a JSONL counts entries
 * whose `"type":"message"` appears in the line, which is exactly the transcript
 * count the local scanner reports.
 *
 * Layout per file:
 *   @@<size> <mtime> <path>\n<header line>\n@@first <json prefix>\n@@name <json prefix>\n@@count <n>\n
 * A file with no messages prints no `@@first`.
 *
 * Everything here must stay POSIX/BSD-safe: the devices include macOS, where
 * `find -printf` and `base64 -w0` do not exist. So the size/mtime come from
 * `stat` (probing `-f` vs `-c` once per run) and the path is emitted LAST, so
 * the numeric prefix can be split off without caring whether a cwd-derived
 * directory name contains spaces.
 */
async function scanCatalogue(
	driver: IHostDriver,
	options: { withDetails?: boolean } = {},
): Promise<{ files: RemoteSessionFile[]; details: Map<string, DetailRow> }> {
	const details = new Map<string, DetailRow>();
	const script = `
__dir="$HOME/.pi/agent/sessions"
[ -d "$__dir" ] || exit 0
if stat -f '%z' "$__dir" >/dev/null 2>&1; then __bsd=1; else __bsd=0; fi
find "$__dir" -name '*.jsonl' -type f 2>/dev/null | head -n ${REMOTE_LIST_LIMIT} | while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [ "$__bsd" = 1 ]; then set -- $(stat -f '%z %m' "$path" 2>/dev/null); else set -- $(stat -c '%s %Y' "$path" 2>/dev/null); fi
  printf '@@%s %s %s\\n' "$1" "$2" "$path"
  head -n 1 "$path"
  ${options.withDetails ? `awk '/"type":"message"/{c++} first=="" && /"role":"user"/{print "@@first " substr($0,1,600); first=1} /"type":"session_info"/{print "@@name " substr($0,1,600)} END{print "@@count " c+0}' "$path"` : `printf '@@count 0\\n'`}
done
`;
	const stdout = await runScript(driver, script);
	const files: RemoteSessionFile[] = [];

	let currentPath: string | null = null;
	let currentFile: RemoteSessionFile | null = null;
	let pending: DetailRow = { messageCount: 0, firstMessage: "" };
	const flush = () => {
		if (currentFile) files.push(currentFile);
		if (currentPath) details.set(currentPath, pending);
		pending = { messageCount: 0, firstMessage: "" };
	};

	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("@@")) {
			if (line.startsWith("@@first ")) {
				const parsed = safeParse(line.slice(8));
				const message = parsed?.message;
				if (typeof message === "object" && message) pending.firstMessage = firstTextOf(message);
				continue;
			}
			if (line.startsWith("@@count ")) {
				const n = Number(line.slice(8));
				pending.messageCount = Number.isFinite(n) ? n : 0;
				continue;
			}
			if (line.startsWith("@@name ")) {
				const parsed = safeParse(line.slice(7));
				if (typeof parsed?.name === "string" && parsed.name.trim()) pending.name = parsed.name.trim();
				continue;
			}
			// New file: `@@<size> <mtime> <path>`. The numeric prefix is split off
			// first so a path containing spaces needs no quoting or escaping.
			flush();
			const header = line.slice(2);
			const firstSpace = header.indexOf(" ");
			const secondSpace = firstSpace === -1 ? -1 : header.indexOf(" ", firstSpace + 1);
			if (secondSpace === -1) {
				currentPath = null;
				currentFile = null;
				continue;
			}
			const size = Number(header.slice(0, firstSpace));
			const mtimeMs = Number(header.slice(firstSpace + 1, secondSpace)) * 1000;
			const relPath = header.slice(secondSpace + 1);
			if (!relPath.endsWith(".jsonl")) {
				currentPath = null;
				currentFile = null;
				continue;
			}
			const base = relPath.slice(relPath.lastIndexOf("/") + 1);
			const sessionId = base.replace(/\.jsonl$/, "").split("_").pop();
			if (!sessionId) {
				currentPath = null;
				currentFile = null;
				continue;
			}
			currentPath = relPath;
			currentFile = {
				path: relPath,
				sessionId,
				cwd: "",
				size: Number.isFinite(size) ? size : 0,
				mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
			};
			continue;
		}
		if (currentFile && !pending.header && line.startsWith("{")) {
			const parsed = safeParse(line);
			if (parsed && parsed.type === "session") pending.header = parsed;
		}
	}
	flush();
	return { files, details };
}

/** Per-file detail decoded from the catalogue script's `@@` lines. */
interface DetailRow {
	header?: Record<string, unknown>;
	messageCount: number;
	firstMessage: string;
	name?: string;
}

function safeParse(line: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(line);
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/**
 * The session catalogue for a remote device, shaped exactly like
 * `listAllSessions()` so the sidebar cannot tell the two apart.
 *
 * `deferDetails` mirrors the local `?summary=1` path: header and stat only, no
 * transcript scan, so the first paint is a single round trip.
 */
export async function listRemoteSessions(
	deviceId: string,
	options: { force?: boolean; deferDetails?: boolean } = {},
): Promise<SessionInfo[]> {
	const cached = catalogues.get(deviceId);
	// A deferred catalogue (headers only) is still usable for the first paint but
	// must be upgraded on the next full read; never serve it to a caller that
	// asked for details.
	const usable = cached
		&& !options.force
		&& Date.now() - cached.ts < REMOTE_LIST_TTL_MS
		&& (options.deferDetails || !cached.deferred);
	if (usable) return buildSessionInfos(cached.entries);

	const driver = await getDriver(deviceId);
	const { files, details } = await scanCatalogue(driver, { withDetails: !options.deferDetails });

	const entries: CatalogueEntry[] = [];
	for (const file of files) {
		const detail = details.get(file.path);
		const header = detail?.header;
		const cwd = typeof header?.cwd === "string" ? header.cwd : "";
		const sessionId = typeof header?.id === "string" ? header.id : file.sessionId;
		entries.push({
			file: { ...file, cwd, sessionId },
			messageCount: detail?.messageCount ?? 0,
			firstMessage: detail?.firstMessage ?? "",
			...(detail?.name ? { name: detail.name } : {}),
		});
	}

	catalogues.set(deviceId, { ts: Date.now(), deferred: Boolean(options.deferDetails), entries });
	trimCache(catalogues);
	return buildSessionInfos(entries);
}

function buildSessionInfos(entries: CatalogueEntry[]): Promise<SessionInfo[]> {
	return attachSessionProjectInfo(entries.map((entry) => ({
		path: entry.file.path,
		id: entry.file.sessionId,
		cwd: entry.file.cwd,
		...(entry.name ? { name: entry.name } : {}),
		created: new Date(entry.file.mtimeMs || Date.now()).toISOString(),
		modified: new Date(entry.file.mtimeMs || Date.now()).toISOString(),
		messageCount: entry.messageCount,
		firstMessage: entry.firstMessage || "(no messages)",
		transient: false,
	})));
}

/** Locate one session file on the device without trusting the client's path. */
export async function findRemoteSessionFile(
	deviceId: string,
	sessionId: string,
): Promise<RemoteSessionFile | null> {
	const cached = catalogues.get(deviceId);
	if (cached) {
		const hit = cached.entries.find((e) => e.file.sessionId === sessionId);
		if (hit) return hit.file;
	}
	const sessions = await listRemoteSessions(deviceId, { force: true, deferDetails: true });
	const match = sessions.find((s) => s.id === sessionId);
	if (!match) return null;
	const refreshed = catalogues.get(deviceId);
	const entry = refreshed?.entries.find((e) => e.file.sessionId === sessionId);
	return entry?.file ?? {
		path: match.path,
		sessionId: match.id,
		cwd: match.cwd,
		size: 0,
		mtimeMs: new Date(match.modified).getTime() || Date.now(),
	};
}

/** Raw transcript text, cached by fingerprint so repeat reads cost nothing. */
export async function readRemoteSessionContent(
	deviceId: string,
	file: RemoteSessionFile,
	options: { force?: boolean } = {},
): Promise<string> {
	const key = `${deviceId}\u0000${file.path}`;
	const cached = contents.get(key);
	if (
		cached && !options.force
		&& cached.size === file.size && cached.mtimeMs === file.mtimeMs
		&& Date.now() - cached.ts < REMOTE_CONTENT_TTL_MS
	) {
		return cached.content;
	}
	const driver = await getDriver(deviceId);
	const content = await readTextFile(driver, file.path);
	contents.set(key, { ts: Date.now(), size: file.size, mtimeMs: file.mtimeMs, content });
	trimCache(contents);
	return content;
}

/** Drop the cached transcript + manager for one session, keeping the catalogue. */
export function invalidateRemoteSession(deviceId: string, sessionId: string) {
	const prefix = `${deviceId}\u0000`;
	managers.delete(`${prefix}${sessionId}`);
	// Transcripts are keyed by path, so resolve the path from the catalogue.
	const entry = catalogues.get(deviceId)?.entries.find((e) => e.file.sessionId === sessionId);
	if (entry) contents.delete(`${prefix}${entry.file.path}`);
}

/**
 * A `SessionManager` backed by the remote transcript. `SessionManager.inMemory`
 * gives us `getEntries/getLeafId/getHeader/getTree/getSessionName` with the same
 * semantics as an opened local file, so every downstream builder works
 * unchanged.
 */
export async function openRemoteSessionManager(
	deviceId: string,
	sessionId: string,
	options: { force?: boolean } = {},
): Promise<RemoteSessionManager | null> {
	const file = await findRemoteSessionFile(deviceId, sessionId);
	if (!file) return null;
	const key = `${deviceId}\u0000${sessionId}`;
	const cached = managers.get(key);
	if (!options.force && cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
		return cached.manager;
	}

	const content = await readRemoteSessionContent(deviceId, file, { force: options.force });
	const entries = parseSessionEntries(content);
	const sm = SessionManager.inMemory(file.cwd || "/", undefined, entries);
	const manager: RemoteSessionManager = {
		sm,
		filePath: file.path,
		sessionId,
		cwd: file.cwd || "/",
		size: file.size,
		mtimeMs: file.mtimeMs,
	};
	managers.set(key, { size: file.size, mtimeMs: file.mtimeMs, manager });
	trimCache(managers);
	return manager;
}
