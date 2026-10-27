import "server-only";
import { getGateway } from "@/lib/gateway/singleton";
import { shellQuote } from "@/lib/shell-quote";
import { sanitizeBranchForDir } from "@/lib/worktree";
import type { WorktreeInfo } from "@/lib/worktree";
import type { IHostDriver } from "@/lib/gateway/types/host-driver";

/**
 * Worktrees of a *remote* device.
 *
 * `lib/worktree.ts` shells out to `git` on the machine running pi-web, which is
 * the wrong machine as soon as the UI is addressed at a gateway device. Every
 * operation here runs the same git command on the device instead, and the caller
 * gets the shapes the local implementation returns so the UI does not have to
 * care which side answered.
 *
 * One deliberate difference: a device's git is invoked through a POSIX shell, so
 * paths are quoted rather than passed as argv. Branch names and repository paths
 * can contain characters a naive `exec` string would reinterpret.
 */

/** How long a worktree checkout may take; large repos take minutes. */
const WORKTREE_TIMEOUT_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 60_000;

export class RemoteGitError extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message);
    this.name = "RemoteGitError";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(driver: IHostDriver, command: string, timeoutMs = GIT_TIMEOUT_MS): Promise<CommandResult> {
  const result = await driver.exec(command, [], { timeoutMs });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
}

/** `${shellQuote(cmd)}` with output capture and the exit status kept apart. */
function gitCommand(cwd: string, args: readonly string[]): string {
  return `git -C ${shellQuote(cwd)} ${args.map((arg) => shellQuote(arg)).join(" ")}`;
}

/**
 * Main repository root of a cwd on the device.
 *
 * The git *common* directory is the parent of the main checkout's `.git`, and for
 * a linked worktree it is still the main repo's `.git` — which is why worktrees
 * created from anywhere inside a repository land in one place instead of nesting.
 */
export async function remoteRepoRoot(driver: IHostDriver, cwd: string): Promise<string> {
  const result = await run(driver, `${gitCommand(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])} 2>/dev/null`);
  const commonDir = result.stdout.trim();
  if (result.exitCode !== 0 || !commonDir) {
    throw new RemoteGitError(`Not a git repository: ${cwd}`);
  }
  // `.../.git` → the checkout that owns it; a bare repo's common dir is itself.
  const withoutSlash = commonDir.replace(/\/+$/, "");
  return withoutSlash.endsWith("/.git") ? withoutSlash.slice(0, -"/.git".length) : withoutSlash;
}

/**
 * Worktrees of the repository containing `cwd`, parsed from
 * `git worktree list --porcelain`.
 *
 * Prunable entries are skipped for the same reason the local implementation skips
 * them: their gitdir is gone, so selecting one opens a directory that git will
 * refuse to operate on.
 */
export async function listRemoteWorktrees(driver: IHostDriver, cwd: string): Promise<WorktreeInfo[]> {
  const result = await run(driver, `${gitCommand(cwd, ["worktree", "list", "--porcelain"])} 2>/dev/null`);
  if (result.exitCode !== 0) throw new RemoteGitError(`Not a git repository: ${cwd}`);
  return parseWorktreePorcelain(result.stdout);
}

/** Pure parser for `git worktree list --porcelain`, exported for tests. */
export function parseWorktreePorcelain(stdout: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: (Partial<WorktreeInfo> & { prunable?: boolean }) | null = null;
  const flush = () => {
    if (current?.path && !current.prunable) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? null,
        // The first surviving block is the main checkout; `git` always lists it
        // first, so a skipped prunable entry must not make a linked worktree
        // look like the main one.
        isMain: worktrees.length === 0,
      });
    }
    current = null;
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.startsWith("worktree ")) {
      flush();
      current = { path: trimmed.slice("worktree ".length).trim() };
    } else if (trimmed.startsWith("branch ") && current) {
      current.branch = trimmed.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (trimmed.startsWith("prunable") && current) {
      current.prunable = true;
    } else if (trimmed.trim() === "") {
      flush();
    }
  }
  flush();
  return worktrees;
}

/** The listed worktree whose path is `cwd` (after resolving links), if any. */
export function worktreeForPath(worktrees: readonly WorktreeInfo[], cwd: string): string | null {
  const target = cwd.replace(/\/+$/, "");
  const found = worktrees.find((worktree) => worktree.path.replace(/\/+$/, "") === target);
  return found?.path ?? null;
}

/**
 * Create a worktree on the device, mirroring `addWorktree`'s choices: the
 * directory sits beside the main checkout in `<repo>-worktrees/<branch>`, an
 * existing branch is checked out as-is, and a new one starts from the
 * already-fetched remote tip when there is one.
 *
 * No fetch happens here on purpose — creating a worktree must not depend on the
 * network, matching the local behaviour.
 */
export async function addRemoteWorktree(
  driver: IHostDriver,
  cwd: string,
  branch: string,
): Promise<{ path: string; branch: string }> {
  const trimmed = branch.trim();
  if (!trimmed) throw new RemoteGitError("Branch name is required");
  const dirName = sanitizeBranchForDir(trimmed);
  if (!dirName) throw new RemoteGitError(`Invalid branch name: ${branch}`);

  const repoRoot = await remoteRepoRoot(driver, cwd);
  const baseDir = `${repoRoot.replace(/\/+$/, "")}-worktrees`;
  const worktreePath = `${baseDir}/${dirName}`;

  if ((await run(driver, `test -e ${shellQuote(worktreePath)} && echo yes`)).stdout.trim() === "yes") {
    throw new RemoteGitError(`Directory already exists: ${worktreePath}`);
  }

  const scoped = (args: readonly string[]) => gitCommand(repoRoot, args);
  const exists = async (ref: string): Promise<boolean> =>
    (await run(driver, `${scoped(["rev-parse", "--verify", "--quiet", ref])} >/dev/null 2>&1 && echo yes`)).stdout.trim() === "yes";

  // One command for the whole sequence: mkdir, then either reuse the branch or
  // create it. Each step is guarded so a failure stops instead of continuing
  // with a half-made directory, and the exit status carries the git message.
  const branchExists = await exists(`refs/heads/${trimmed}`);
  const startFrom = branchExists ? null : ((await exists(`refs/remotes/origin/${trimmed}`)) ? `refs/remotes/origin/${trimmed}` : null);
  const addArgs = branchExists
    ? ["worktree", "add", "--", worktreePath, trimmed]
    : ["worktree", "add", "-b", trimmed, "--", worktreePath, ...(startFrom ? [startFrom] : [])];
  const script = [
    `mkdir -p ${shellQuote(baseDir)} || exit 3`,
    `${scoped(addArgs)} || exit 4`,
  ].join("\n");

  const result = await driver.exec(
    `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`,
    [],
    { timeoutMs: WORKTREE_TIMEOUT_MS },
  );
  if ((result.exitCode ?? 0) !== 0) {
    const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim();
    throw new RemoteGitError(detail || `git worktree add failed (exit ${result.exitCode})`);
  }
  return { path: worktreePath, branch: trimmed };
}

/**
 * Remove a worktree on the device.
 *
 * The path is matched against git's own list first (the same guard the local
 * version has), so a typo cannot make git remove a directory that is not a
 * worktree of this repository, and the main checkout is refused.
 */
export async function removeRemoteWorktree(
  driver: IHostDriver,
  cwd: string,
  worktreePath: string,
  force = false,
): Promise<void> {
  const worktrees = await listRemoteWorktrees(driver, cwd);
  const target = worktrees.find((worktree) => worktree.path.replace(/\/+$/, "") === worktreePath.replace(/\/+$/, ""));
  if (!target) throw new RemoteGitError(`Not a worktree of this repository: ${worktreePath}`);
  if (target.isMain) throw new RemoteGitError("Cannot remove the main worktree");

  const args = ["worktree", "remove", ...(force ? ["--force"] : []), target.path];
  const result = await run(driver, gitCommand(cwd, args), WORKTREE_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new RemoteGitError(result.stderr.trim() || result.stdout.trim() || `git worktree remove failed (exit ${result.exitCode})`);
  }
}

export type { WorktreeInfo };
