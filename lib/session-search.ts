import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SessionInfo } from "./types";
import type { IHostDriver } from "./gateway/types/host-driver";
import { shellQuote } from "./shell-quote";

const MAX_FILES = 500;
const MAX_RESULTS = 30;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const TIME_BUDGET_MS = 3000;

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

// ponytail: scan recent files without an index; add indexing if measured latency warrants it.
export async function searchSessionContents(
  sessions: readonly SessionInfo[],
  query: string,
  requestSignal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  // Escape every operator: this is literal search, with offsets in the original text.
  const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const deadline = Date.now() + TIME_BUDGET_MS;
  const timeout = AbortSignal.timeout(TIME_BUDGET_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  const candidates = sessions
    .filter((session) => !session.transient && session.path)
    .sort((a, b) => b.modified.localeCompare(a.modified));

  for (const [index, session] of candidates.entries()) {
    if (index >= MAX_FILES || response.results.length >= MAX_RESULTS || signal.aborted || Date.now() >= deadline) {
      response.truncated = true;
      break;
    }
    const stream = createReadStream(session.path, { encoding: "utf8", end: MAX_FILE_BYTES - 1, signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let found = false;
    try {
      for await (const line of lines) {
        if (signal.aborted || Date.now() >= deadline) {
          response.truncated = true;
          break;
        }
        if (line.length > MAX_LINE_CHARS) {
          response.truncated = true;
          continue;
        }
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
        const content: unknown = entry.message.content;
        const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
        const textBlocks = blocks.flatMap((block, blockIndex) => block?.type === "text" && typeof block.text === "string" ? [{ text: block.text as string, blockIndex }] : []);
        const text = textBlocks.map((block) => block.text).join("\n");
        const match = matcher.exec(text);
        if (!match) continue;
        const start = match.index;
        const end = start + match[0].length;
        let blockOffset = 0;
        const matchedBlock = textBlocks.find((block) => {
          const blockEnd = blockOffset + block.text.length;
          blockOffset = blockEnd + 1;
          return start <= blockEnd;
        });
        response.results.push({
          session,
          ...(typeof entry.id === "string" ? { entryId: entry.id } : {}),
          blockIndex: matchedBlock!.blockIndex,
          before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
          match: text.slice(start, end).replace(/\s+/g, " "),
          after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
        });
        found = true;
        break;
      }
    } catch {
      // Missing/unreadable files and interrupted reads must not hide other results.
      response.truncated = true;
    } finally {
      lines.close();
      stream.destroy();
    }
    if (!found && stream.bytesRead >= MAX_FILE_BYTES) response.truncated = true;
  }
  return response;
}

/**
 * Remote counterpart of {@link searchSessionContents}.
 *
 * The local scanner streams files with `createReadStream`, which cannot see a
 * device. The device is asked to grep its own transcripts instead — one round
 * trip for the whole catalogue — and the matching lines are fed through the
 * same JSON parsing and snippet logic below, so a remote hit is shaped exactly
 * like a local one.
 */
export async function searchRemoteSessionContents(
  driver: IHostDriver,
  sessions: readonly SessionInfo[],
  query: string,
  signal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  const candidates = sessions
    .filter((session) => !session.transient && session.path)
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, MAX_FILES);
  if (candidates.length === 0) return response;

  const paths = candidates.map((session) => session.path);
  const script = [
    `for f in ${paths.map((path) => shellQuote(path)).join(" ")}; do`,
    `  [ -f "$f" ] || continue`,
    `  grep -F -i -m ${MAX_RESULTS + 1} -- ${shellQuote(needle)} "$f" 2>/dev/null | while IFS= read -r line; do`,
    `    printf 'R\t%s\t%s\n' "$f" "$line"`,
    `  done`,
    `done`,
  ].join("\n");
  let result: { stdout: string };
  try {
    result = await driver.exec(`printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`, [], { timeoutMs: TIME_BUDGET_MS * 4 });
  } catch {
    return { results: [], truncated: true };
  }
  if (signal?.aborted) return { results: [], truncated: true };

  const byPath = new Map(candidates.map((session) => [session.path, session]));
  const deadline = Date.now() + TIME_BUDGET_MS;
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("R\t")) continue;
    if (response.results.length >= MAX_RESULTS || Date.now() >= deadline) {
      response.truncated = true;
      break;
    }
    const rest = line.slice(2);
    const tab = rest.indexOf("\t");
    if (tab < 0) continue;
    const session = byPath.get(rest.slice(0, tab));
    if (!session) continue;
    const raw = rest.slice(tab + 1);
    if (raw.length > MAX_LINE_CHARS) {
      response.truncated = true;
      continue;
    }
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
    const content: unknown = entry.message.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const textBlocks = blocks.flatMap((block, blockIndex) => block?.type === "text" && typeof block.text === "string" ? [{ text: block.text as string, blockIndex }] : []);
    const text = textBlocks.map((block) => block.text).join("\n");
    const start = text.toLowerCase().indexOf(needle.toLowerCase());
    if (start < 0) continue;
    const end = start + needle.length;
    let blockOffset = 0;
    const matchedBlock = textBlocks.find((block) => {
      const blockEnd = blockOffset + block.text.length;
      blockOffset = blockEnd + 1;
      return start <= blockEnd;
    });
    response.results.push({
      session,
      ...(typeof entry.id === "string" ? { entryId: entry.id } : {}),
      blockIndex: matchedBlock!.blockIndex,
      before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
      match: text.slice(start, end).replace(/\s+/g, " "),
      after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
    });
  }
  return response;
}
