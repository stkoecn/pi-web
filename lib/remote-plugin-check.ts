import "server-only";
import type { PluginScope, PluginUpdateResult } from "@/lib/api-types";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { checkPluginUpdates } from "@/lib/plugin-updates";
import { getGateway } from "@/lib/gateway/singleton";
import { getRemoteAgentDir } from "@/lib/remote-settings";
import { cachedRemoteProjectTrust } from "@/lib/remote-trust";

/**
 * Update checks for a device's packages.
 *
 * Where a package is installed is a question only the device can answer: pi
 * resolves a source against its own agent directory, its own project folder and
 * its own package-manager roots, and a `packages` entry may even be a relative
 * path (`../../../../tmp/pitest/pkg` is how the CLI records a local install).
 * Recomputing that here would be a second, subtly different implementation.
 *
 * So the device runs the same SDK code this host runs, over its own files, and
 * prints one JSON line. The comparison against the registry or the remote branch
 * then stays the single implementation in `lib/plugin-updates.ts`; only the two
 * file reads it needs (`package.json`, and whether a path exists) are answered by
 * the device.
 */

const LIST_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 20_000;

/** What the device prints: the packages it configures, and how it invokes npm. */
interface DevicePackageList {
  agentDir: string;
  packages: { source: string; scope: "user" | "project"; filtered: boolean; installedPath?: string }[];
  npmCommand?: string[];
  error?: string;
}

/**
 * The module the device runs.
 *
 * It has to find the SDK the way the device's own `pi` does — the CLI is a
 * symlink into the package, and the package's `index.js` sits beside `bundle/`
 * or one level up — because the device's node_modules is not ours and its
 * layout is whatever the installer produced.
 */
const LIST_SCRIPT = `
const sdk = await import("file://" + process.env.PIWEB_DIST + "/index.js");
const agentDir = sdk.getAgentDir();
const settingsManager = sdk.SettingsManager.create(process.env.PIWEB_CWD, agentDir, {
  projectTrusted: process.env.PIWEB_TRUSTED === "1",
});
const manager = new sdk.DefaultPackageManager({
  cwd: process.env.PIWEB_CWD,
  agentDir,
  settingsManager,
});
process.stdout.write(JSON.stringify({
  agentDir,
  packages: manager.listConfiguredPackages(),
  npmCommand: settingsManager.getNpmCommand(),
}));
`;

/** The shell wrapper: find the device's own SDK, then run the module above. */
function listCommand(cwd: string, trusted: boolean): string {
  const script = Buffer.from(LIST_SCRIPT, "utf8").toString("base64");
  return [
    // `pi` is usually installed into a per-user bin directory that a non-login
    // shell has not added to PATH yet; the CLI itself lives there, so it has to
    // be found the same way the user's own shell finds it.
    // A user-level install puts `pi` under `$HOME/.local/node/bin`, which is not
    // on the PATH sshd gives an `exec` request.
    `export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"`,
    `PI=$(command -v pi) || exit 9`,
    `PI=$(readlink -f "$PI" 2>/dev/null || echo "$PI")`,
    `D=$(dirname "$PI")`,
    `[ -f "$D/index.js" ] || D=$(dirname "$D")`,
    // `export`, not a bare assignment: an assignment on its own line is gone by
    // the time the next line runs, which left the module reading `undefined`.
    `export PIWEB_DIST="$D"`,
    `export PIWEB_CWD=${shellQuote(cwd)}`,
    `export PIWEB_TRUSTED=${trusted ? "1" : "0"}`,
    `node --input-type=module -e "$(printf %s ${script} | base64 -d)"`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The device's own package list, or the reason it could not be read. */
export async function readDevicePackageList(
  driver: IHostDriver,
  cwd: string,
  trusted: boolean,
): Promise<DevicePackageList> {
  const result = await driver.exec(
    `printf %s ${Buffer.from(listCommand(cwd, trusted), "utf8").toString("base64")} | base64 -d | sh`,
    [],
    { timeoutMs: LIST_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `pi could not be found on the device (exit ${result.exitCode})`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim()) as DevicePackageList;
  return parsed;
}

/**
 * Check a device's packages for updates.
 *
 * `filter` narrows to one package, the same way the local route's does, and an
 * empty answer for a named package means the device does not configure it.
 */
export async function checkRemotePluginUpdates(
  deviceId: string,
  cwd: string,
  filter?: { source?: string; scope?: PluginScope },
): Promise<PluginUpdateResult[]> {
  const driver = await getGateway().getOnlineDriver(deviceId);
  // The device's trust decides which of its project packages are live; asking it
  // is what makes the list match what pi on that machine would load.
  const trust = await cachedRemoteProjectTrust(deviceId, cwd);
  const list = await readDevicePackageList(driver, cwd, trust?.trusted === true);

  return checkPluginUpdates(
    cwd,
    filter,
    {
      packages: list.packages,
      npmCommand: list.npmCommand,
      // The registry lookup and the git comparison run on the device, so they
      // see the device's network, its credentials and its git config.
      runCommand: async (command, args, options) => {
        const result = await driver.exec(command, args, {
          cwd: options.cwd,
          ...(options.env ? { env: options.env as Record<string, string> } : {}),
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `${command} exited with ${result.exitCode}`);
        }
        return result.stdout;
      },
      // The shared code builds these paths with this host's `path.join`, which
      // on Windows turns `/a/b` into `\a\b`. The device is POSIX, so undo that
      // before asking it about the file.
      readFile: async (path) => {
        const buffer = await driver.readFile(posixPath(path));
        return buffer.toString("utf8");
      },
      exists: async (path) => {
        try {
          await driver.stat(posixPath(path));
          return true;
        } catch {
          return false;
        }
      },
    },
  );
}

/**
 * A device path with forward slashes.
 *
 * `lib/plugin-updates.ts` is shared with this host and joins paths with
 * `path.join`, which is Windows-shaped here. The device is not.
 */
function posixPath(value: string): string {
  return value.replace(/[\\]/g, "/");
}

/** The agent directory of a device, for callers that only need paths. */
export async function deviceAgentDir(deviceId: string): Promise<string> {
  return getRemoteAgentDir(deviceId);
}
