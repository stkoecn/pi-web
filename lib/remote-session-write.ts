import "server-only";
import { randomUUID } from "node:crypto";
import { getGateway } from "@/lib/gateway/singleton";
import { shellQuote } from "@/lib/shell-quote";
import {
	invalidateRemoteSession,
	invalidateRemoteSessionCache,
	openRemoteSessionManager,
} from "@/lib/remote-session-store";

/**
 * Renaming a session on a remote device.
 *
 * A title is stored as a `session_info` entry appended to the transcript, which
 * is exactly what the TUI does, so the rename is one appended line rather than a
 * rewrite: rewriting the file would need the whole transcript over the wire and
 * would race a `pi` that is still appending to it.
 *
 * The entry id is generated here for the same reason the session manager does
 * it: it must not collide with an id already in the file, and the file itself is
 * the only authority on that. Eight hex characters is what pi uses, so the
 * seven-byte prefix keeps ids the same shape as the rest of the transcript.
 */
export async function renameRemoteSession(
	deviceId: string,
	sessionId: string,
	name: string,
): Promise<"renamed" | "missing"> {
	const manager = await openRemoteSessionManager(deviceId, sessionId);
	if (!manager) return "missing";

	// pi collapses line breaks itself; a title is one line by definition.
	const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
	const existing = new Set(manager.sm.getEntries().map((entry) => entry.id));
	let entryId = randomUUID().slice(0, 8);
	while (existing.has(entryId)) entryId = randomUUID().slice(0, 8);

	const entry = {
		type: "session_info",
		id: entryId,
		parentId: manager.sm.getLeafId(),
		timestamp: new Date().toISOString(),
		name: sanitizedName,
	};

	// The newline before the payload is conditional: appending it to a file that
	// already ends with one would leave a blank line, and a blank line is an
	// unparsable transcript entry for every reader of this format.
	const script = `
f=${shellQuote(manager.filePath)}
[ -f "$f" ] || exit 3
if [ -n "$(tail -c 1 "$f")" ]; then printf '\\n' >> "$f" || exit 4; fi
printf '%s\\n' ${shellQuote(JSON.stringify(entry))} >> "$f" || exit 5
`;
	const driver = getGateway().getOnlineDriver(deviceId);
	const result = await driver.exec(
		`printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
		[],
		{ timeoutMs: 20_000 },
	);
	if (result.exitCode === 3) return "missing";
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `Failed to rename the session (exit ${result.exitCode})`);
	}

	// The list is served from a catalogue whose entries carry the old name, and
	// the cached manager still holds a transcript without this entry. Clearing
	// the catalogue costs one rescan, which is cheaper than showing a stale
	// title for the next fifteen seconds and lying about what was just saved.
	invalidateRemoteSession(deviceId, sessionId);
	invalidateRemoteSessionCache(deviceId);
	return "renamed";
}
