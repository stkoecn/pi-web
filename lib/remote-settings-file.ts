import "server-only";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { shellQuote } from "@/lib/shell-quote";

/**
 * Reading and writing a device's own `~/.pi/agent/*.json` files over SSH.
 *
 * Two callers (default preferences, `enabledModels`) need the same two
 * operations against the same files, and both pay a full round trip per call on
 * a WAN device. The batching below is the whole point: one command reads every
 * file a panel needs, so a route that checks both the global and the project
 * settings file costs one RTT instead of two.
 */

/** Delimits one file's content inside a batched read. */
const FILE_MARKER = "@@piweb-file@@";

/**
 * Read several files in ONE round trip.
 *
 * Each section is delimited by a marker line holding the index; a missing file
 * simply has no section, so the caller can tell "absent" (empty) from "empty
 * file" (present, zero bytes).
 */
export async function readRemoteFiles(
  driver: IHostDriver,
  paths: readonly string[],
  timeoutMs = 20_000,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (paths.length === 0) return found;
  // Base64 rather than `cat`: a marker-delimited text stream cannot say whether
  // the last line ended with a newline, so a read-then-write cycle grew the file
  // by one blank line each time. Base64 is exact and cannot contain the marker.
  const script = paths
    .map((path, index) => {
      const quoted = shellQuote(path);
      return [
        `if [ -f ${quoted} ]; then`,
        `  printf '%s%s\n' '${FILE_MARKER}' '${index}'`,
        `  base64 < ${quoted}`,
        `fi`,
      ].join("\n");
    })
    .join("\n");
  const result = await driver.exec(
    `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
    [],
    { timeoutMs },
  );
  if (result.exitCode !== 0) return found;
  const pattern = new RegExp(`^${FILE_MARKER}([0-9]+)$`);
  let current: { path: string; encoded: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const decoded = Buffer.from(current.encoded.join(""), "base64").toString("utf8");
    found.set(current.path, decoded);
    current = null;
  };
  for (const line of result.stdout.split("\n")) {
    const match = pattern.exec(line);
    if (match) {
      flush();
      const path = paths[Number(match[1])];
      current = path === undefined ? null : { path, encoded: [] };
      continue;
    }
    if (current) current.encoded.push(line.trim());
  }
  flush();
  return found;
}

/**
 * Replace a file's contents, creating its directory when needed.
 *
 * Written to a temp file next to the target and then copied over it with
 * `cat >`: a plain `mv` would replace the inode and lose the file's mode, and a
 * half-written settings file makes every later session on that device fail to
 * load. `cat >` also keeps this a single write for a file this small.
 */
export async function writeRemoteFile(
  driver: IHostDriver,
  path: string,
  contents: string,
  timeoutMs = 20_000,
): Promise<void> {
  const slash = path.lastIndexOf("/");
  const dir = slash > 0 ? path.slice(0, slash) : ".";
  const tmpPath = `${path}.piweb-${Date.now()}.tmp`;
  const payload = Buffer.from(contents, "utf8").toString("base64");
  const script = [
    `mkdir -p ${shellQuote(dir)} || exit 4`,
    `printf %s ${shellQuote(payload)} | base64 -d > ${shellQuote(tmpPath)} || exit 5`,
    `cat ${shellQuote(tmpPath)} > ${shellQuote(path)} || { rm -f ${shellQuote(tmpPath)}; exit 6; }`,
    `rm -f ${shellQuote(tmpPath)} || exit 7`,
  ].join("\n");
  const result = await driver.exec(
    `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
    [],
    { timeoutMs },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Failed to write ${path} (exit ${result.exitCode})`);
  }
}
