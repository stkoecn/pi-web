import "server-only";
import { getGateway } from "@/lib/gateway/singleton";
import { buildSkillUpdateArgs, checkSkillUpdates } from "@/lib/skill-updates";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";
import { readRemoteFiles, writeRemoteFile } from "@/lib/remote-settings-file";
import { setDisableModelInvocation } from "@/lib/skill-frontmatter";
import type { SkillInstallScope, SkillToggleResult, SkillUpdateResult } from "@/lib/api-types";

/**
 * Installing and updating skills on a *remote* device.
 *
 * `/api/skills/{install,update,check}` all answer 501 for a device, because the
 * local implementations run `npx skills …` through `child_process` on the machine
 * hosting pi-web and then re-read the results off its filesystem. Both halves are
 * wrong for a device: the CLI has to run there (`npx` may not even exist here) and
 * the results land in that device's own `~/.agents/skills`.
 *
 * So this module runs the same CLI over the gateway and answers with the shapes
 * the local routes produce. The command vocabulary is pi's own and shared with
 * `lib/skill-updates.ts` — `buildSkillUpdateArgs()` builds update arguments on
 * both sides so the two cannot drift.
 *
 * Nothing here trusts a path from the client: every path is either derived from
 * the device itself (`$HOME`, the agent dir) or comes from a lock file the device
 * just told us about.
 */

// CSI sequences in general, not just colours: the CLI also emits cursor moves
// (`\x1b[1G`), erases (`\x1b[J`) and hide-cursor (`\x1b[?25l`), which would
// otherwise land in the message the panel shows.
const ANSI_RE = /\x1B\[[0-9;?]*[A-Za-z]/g;
/** Installing a skill clones a repository; a WAN device needs room to finish. */
const INSTALL_TIMEOUT_MS = 180_000;

export class RemoteSkillsError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "RemoteSkillsError";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function driverFor(deviceId: string): Promise<IHostDriver> {
  return getGateway().getOnlineDriver(deviceId);
}

/**
 * Run one command on the device with its output combined and ANSI-stripped.
 *
 * `driver.exec` takes argv and quotes it for a POSIX shell, so the CLI never
 * sees an option that came from a request body as anything but data.
 */
async function runOnDevice(
  driver: IHostDriver,
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  try {
    const result = await driver.exec(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    };
  } catch (error) {
    // `driver.exec` rejects with the command's own captured output when the exit
    // status is non-zero on some drivers; keep whatever it produced.
    const detail = error as { stdout?: string; stderr?: string; message?: string; code?: unknown };
    if (typeof detail.stdout === "string" || typeof detail.stderr === "string") {
      return { stdout: detail.stdout ?? "", stderr: detail.stderr ?? "", exitCode: 1 };
    }
    throw error;
  }
}

/** The `skills` CLI arguments for one install, and whether it is global. */
export function skillInstallArgs(pkg: string, scope: SkillInstallScope): string[] {
  const args = ["skills", "add", pkg, "-y", "--agent", "pi"];
  if (scope === "global") args.push("-g");
  return args;
}

/** Strip terminal control sequences so a panel can show the CLI's message. */
export function stripAnsi(output: string): string {
  return output.replace(ANSI_RE, "");
}

/**
 * Whether the CLI reported a successful install.
 *
 * The local route (`app/api/skills/install/route.ts`) decides on this same
 * sentence rather than on the exit status, because the CLI exits 0 after
 * refusing a package. The remote path must not be more permissive than the local
 * one, so the same words decide here.
 */
export function installSucceeded(output: string): boolean {
  return /Installation complete|Installed \d+ skill/.test(output);
}

/**
 * Install one skill on the device.
 *
 * The CLI reports success in its own words, and there is no exit status to trust
 * across versions, so the same textual check the local route uses decides. The
 * project scope runs inside `cwd`, which is what makes the CLI write the project
 * lock file next to the project rather than into the device's home.
 */
export async function installSkillOn(
  driver: IHostDriver,
  options: { package: string; scope: SkillInstallScope; cwd?: string },
): Promise<{ output: string }> {
  const result = await runOnDevice(driver, "npx", skillInstallArgs(options.package, options.scope), {
    ...(options.scope === "project" && options.cwd ? { cwd: options.cwd } : {}),
    env: { FORCE_COLOR: "0" },
  });
  const output = stripAnsi(result.stdout + result.stderr);
  if (!installSucceeded(output)) {
    throw new RemoteSkillsError(output.slice(-300) || "Install failed", 500);
  }
  return { output };
}

export async function installRemoteSkill(
  deviceId: string,
  options: { package: string; scope: SkillInstallScope; cwd?: string },
): Promise<{ output: string }> {
  return installSkillOn(await driverFor(deviceId), options);
}

/**
 * Re-run the installing command for an unmodified skill and report what happened.
 *
 * The update is the install: the skills CLI has no separate upgrade verb, which
 * is why `buildSkillUpdateArgs()` returns the same `skills add` with the ref the
 * lock file recorded. Only the install info is sent over, never a path, so a
 * caller cannot aim this at an arbitrary directory.
 */
export async function updateSkillOn(
  driver: IHostDriver,
  options: { install: Parameters<typeof buildSkillUpdateArgs>[0]; cwd?: string },
): Promise<{ output: string }> {
  const result = await runOnDevice(driver, "npx", buildSkillUpdateArgs(options.install), {
    ...(options.install.scope === "project" && options.cwd ? { cwd: options.cwd } : {}),
    env: { FORCE_COLOR: "0" },
  });
  const output = stripAnsi(`${result.stdout}${result.stderr}`);
  if (result.exitCode !== 0) {
    throw new RemoteSkillsError(output.slice(-300) || "Update failed", 500);
  }
  return { output };
}

export async function updateRemoteSkill(
  deviceId: string,
  options: { install: Parameters<typeof buildSkillUpdateArgs>[0]; cwd?: string },
): Promise<{ output: string }> {
  return updateSkillOn(await driverFor(deviceId), options);
}

/**
 * Compare the given installs against their upstreams.
 *
 * This half needs no device at all: the comparison is GitHub and skills.sh API
 * calls, and the version hashes came from the device's own lock files. Only the
 * `GITHUB_TOKEN` handling and the skippable set are decided here.
 */
export async function checkRemoteSkillUpdates(
  installs: Parameters<typeof checkSkillUpdates>[0],
  options: { githubToken?: string } = {},
): Promise<SkillUpdateResult[]> {
  return checkSkillUpdates(installs, {
    ...(options.githubToken ? { githubToken: options.githubToken } : {}),
  });
}

/**
 * Whether a path may be edited as a skill on a device.
 *
 * The local route checks the path against the allowed file roots of *this*
 * machine, which can never contain a device path. The device equivalent is
 * narrower on purpose: every skill root pi loads is a directory named `skills`
 * (`<agentDir>/skills`, `~/.agents/skills`, `<project>/.pi/skills`), and the
 * route only edits frontmatter at the top of a Markdown file. Requiring both
 * keeps a request from aiming the edit at `settings.json` or `auth.json` in the
 * same agent directory.
 *
 * Symlinks are why this is a shape check rather than a root prefix: a skill
 * installed from a project is usually a symlink into that project, so its real
 * path is outside the agent directory but still inside a `skills` directory.
 */
export function isDeviceSkillPath(filePath: string): boolean {
  if (!filePath.startsWith("/")) return false;
  if (!filePath.toLowerCase().endsWith(".md")) return false;
  return filePath.split("/").includes("skills");
}

/**
 * Toggle `disable-model-invocation` in one or more skill files on the device.
 *
 * Every file is read in one round trip and only the files whose frontmatter
 * actually changes are written, so an "enable all" over twenty skills costs one
 * read instead of twenty, and a skill already in the requested state keeps its
 * mtime (the local route makes the same promise).
 */
export async function toggleSkillsOn(
  driver: IHostDriver,
  filePaths: readonly string[],
  disable: boolean,
): Promise<SkillToggleResult[]> {
  const results: SkillToggleResult[] = [];
  const targets: string[] = [];
  for (const filePath of filePaths) {
    if (!isDeviceSkillPath(filePath)) {
      results.push({ filePath, error: "Not a skill file" });
      continue;
    }
    targets.push(filePath);
  }
  if (targets.length === 0) return results;

  const contents = await readRemoteFiles(driver, targets);
  await Promise.all(targets.map(async (filePath) => {
    const content = contents.get(filePath);
    if (content === undefined) {
      results.push({ filePath, error: "file not found" });
      return;
    }
    try {
      const updated = setDisableModelInvocation(content, disable);
      if (updated !== content) await writeRemoteFile(driver, filePath, updated);
      results.push({ filePath });
    } catch (error) {
      results.push({ filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }));
  // Writes finish in parallel, so the answers are put back in request order:
  // the panel pairs each result with the row it came from.
  const byPath = new Map(results.map((result) => [result.filePath, result]));
  return filePaths.map((filePath) => byPath.get(filePath) ?? { filePath, error: "Not attempted" });
}
