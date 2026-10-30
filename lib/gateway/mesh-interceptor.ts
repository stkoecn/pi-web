import { sendMeshMessage } from "./mesh-router";

/**
 * Regex matching mesh reply blocks:
 * :::mesh-reply[target]
 * content...
 * :::
 *
 * Case-insensitive for tag, supports whitespace around target and newlines.
 */
const MESH_REPLY_REGEX = /:::mesh-reply\[\s*([^\]]+?)\s*\]\r?\n([\s\S]*?)\r?\n?:::/gi;

// Keep track of dispatched reply hashes to avoid duplicate dispatch on replay or re-render
const dispatchedReplyHashes = new Set<string>();

/**
 * Inspect assistant text or message events on the RPC channel.
 * If a `:::mesh-reply[target]...:::` block is found, extract and dispatch it
 * through `sendMeshMessage`, routing it back through the existing gateway connection.
 */
export async function interceptMeshReplyFromText(
  text: string,
  sourceSessionId?: string,
  sourceDeviceId?: string,
): Promise<number> {
  if (!text || !text.includes(":::mesh-reply")) {
    return 0;
  }

  const matches = [...text.matchAll(MESH_REPLY_REGEX)];
  if (matches.length === 0) return 0;

  let dispatchedCount = 0;

  for (const match of matches) {
    const target = match[1]?.trim();
    const replyBody = match[2]?.trim();

    if (!target || !replyBody) continue;

    // Deduplicate so re-scanning the same completed message doesn't send duplicate replies
    const hash = `${sourceSessionId || ""}|${target}|${replyBody}`;
    if (dispatchedReplyHashes.has(hash)) {
      continue;
    }
    dispatchedReplyHashes.add(hash);

    // Limit memory size of deduplication set
    if (dispatchedReplyHashes.size > 2000) {
      const firstEntry = dispatchedReplyHashes.values().next().value;
      if (firstEntry) dispatchedReplyHashes.delete(firstEntry);
    }

    try {
      console.log(`[MeshInterceptor] Intercepted mesh-reply from ${sourceSessionId} to ${target}`);
      await sendMeshMessage({
        target,
        message: replyBody,
        mode: "followup",
        currentDeviceId: sourceDeviceId,
        senderContext: {
          deviceId: sourceDeviceId,
          sessionId: sourceSessionId,
        },
      });
      dispatchedCount++;
    } catch (err) {
      console.error(`[MeshInterceptor] Error dispatching intercepted reply to ${target}:`, err);
    }
  }

  return dispatchedCount;
}
