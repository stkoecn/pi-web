/**
 * Disambiguates a list of file/project paths so each has a unique, human-friendly,
 * safe short identifier for UI labels and mesh routing.
 *
 * Examples:
 * - ["/home/windsing/work/pi-web", "/home/windsing/personal/pi-web"]
 *   => {
 *     "/home/windsing/work/pi-web": "work/pi-web",
 *     "/home/windsing/personal/pi-web": "personal/pi-web"
 *   }
 * - ["/home/windsing/pi-web", "/home/windsing/chat-agent"]
 *   => {
 *     "/home/windsing/pi-web": "pi-web",
 *     "/home/windsing/chat-agent": "chat-agent"
 *   }
 */
export function disambiguateProjectPaths(paths: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (!paths || paths.length === 0) return result;

  // Split paths into non-empty segments
  const splitPaths = paths.map((rawPath) => {
    const normalized = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const segments = normalized.split("/").filter(Boolean);
    return {
      rawPath,
      normalized,
      segments,
    };
  });

  // Start with segment depth = 1 (just basename)
  for (const item of splitPaths) {
    result.set(item.rawPath, item.segments[item.segments.length - 1] || item.rawPath);
  }

  // Iteratively find collisions and increase segment depth for collided paths
  let hasCollision = true;
  let depth = 1;
  const maxDepth = Math.max(...splitPaths.map((p) => p.segments.length), 1);

  while (hasCollision && depth < maxDepth) {
    const labelToPaths = new Map<string, string[]>();
    for (const [raw, label] of result.entries()) {
      const list = labelToPaths.get(label) || [];
      list.push(raw);
      labelToPaths.set(label, list);
    }

    hasCollision = false;
    for (const [label, collided] of labelToPaths.entries()) {
      if (collided.length > 1) {
        hasCollision = true;
        // Increase depth for these collided items
        for (const raw of collided) {
          const item = splitPaths.find((p) => p.rawPath === raw);
          if (item) {
            const segs = item.segments.slice(-Math.min(depth + 1, item.segments.length));
            result.set(raw, segs.join("/") || item.rawPath);
          }
        }
      }
    }
    depth++;
  }

  return result;
}
