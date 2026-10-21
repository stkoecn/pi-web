import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { addWorktree, findCurrentWorktreePath, listWorktrees, removeWorktree, resolveProject, worktreeRemovalRequiresForce } from "@/lib/worktree";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { projectIdentityKey } from "@/lib/project-identity";
import { isRemoteDevice } from "@/lib/device-context";
import { DeviceOfflineError } from "@/lib/gateway/singleton";

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be inspected or mutated through this endpoint. */
async function checkCwdAllowed(cwd: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

// GET /api/worktrees?cwd=  →  { projectRoot, projectKey, isGit, isTopLevel, currentWorktreePath, worktrees }
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = url.searchParams.get("cwd");
    const deviceId = url.searchParams.get("deviceId") || req.headers.get("x-device-id");
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }

    if (deviceId && deviceId !== "localhost") {
      const { getGateway } = await import("@/lib/gateway/singleton");
      const { listRemoteWorktrees, remoteRepoRoot, worktreeForPath } = await import("@/lib/remote-worktree");
      const driver = await getGateway().getOrConnectDriver(deviceId);
      try {
        const root = await remoteRepoRoot(driver, cwd);
        const worktrees = await listRemoteWorktrees(driver, cwd);
        // `isTopLevel` and `currentWorktreePath` are answered from git's own
        // list rather than guessed: a session opened inside a linked worktree
        // must see that worktree selected in the switcher, not the main
        // checkout it belongs to.
        return NextResponse.json({
          projectRoot: root,
          projectKey: root,
          isGit: true,
          isTopLevel: worktrees.some((worktree) => worktree.path.replace(/\/+$/, "") === cwd.replace(/\/+$/, "")),
          currentWorktreePath: worktreeForPath(worktrees, cwd),
          worktrees,
        });
      } catch {
        // Not a repository (or the device lost git mid-request): report the
        // directory itself so the UI can show "this project has no worktrees".
        return NextResponse.json({
          projectRoot: cwd,
          projectKey: cwd,
          isGit: false,
          isTopLevel: true,
          currentWorktreePath: cwd,
          worktrees: [],
        });
      }
    }

    const denied = await checkCwdAllowed(cwd);
    if (denied) return denied;

    const project = await resolveProject(cwd);
    let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
    let currentWorktreePath: string | null = null;
    let isGit = true;
    try {
      // For a removed-worktree cwd (session of a deleted worktree), fall back
      // to the inferred project root so the switcher still shows the project.
      worktrees = await listWorktrees(existsSync(cwd) ? cwd : project.projectRoot);
      currentWorktreePath = findCurrentWorktreePath(worktrees, cwd);
    } catch {
      isGit = false;
    }
    // Every listed path is a git-verified worktree of this project; allow the
    // file explorer to browse them even before they have any session (the
    // in-memory allowlist from addWorktree does not survive server restarts).
    for (const w of worktrees) allowFileRoot(w.path);
    return NextResponse.json({
      projectRoot: project.projectRoot,
      projectKey: projectIdentityKey(project.projectRoot),
      isGit,
      isTopLevel: project.isTopLevel,
      currentWorktreePath,
      worktrees,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/worktrees  body: { cwd, branch }  →  { path, branch }
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; branch?: string; deviceId?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.branch || typeof body.branch !== "string") {
      return NextResponse.json({ error: "branch is required" }, { status: 400 });
    }
    // A remote project's worktrees live on the device: git runs there, and the
    // returned path is a path on that machine (which is what sessions use), not
    // a local one. The local allow-list does not apply — no local path is read.
    if (isRemoteDevice(body.deviceId)) {
      const { getGateway } = await import("@/lib/gateway/singleton");
      const { addRemoteWorktree } = await import("@/lib/remote-worktree");
      try {
        const driver = await getGateway().getOnlineDriver(body.deviceId);
        return NextResponse.json(await addRemoteWorktree(driver, body.cwd, body.branch));
      } catch (error) {
        if (error instanceof DeviceOfflineError) throw error;
        return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;
    if (!existsSync(body.cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }

    const result = await addWorktree(body.cwd, body.branch);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/worktrees  body: { cwd, path, force? }
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; path?: string; force?: boolean; deviceId?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.path || typeof body.path !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    if (isRemoteDevice(body.deviceId)) {
      const { getGateway } = await import("@/lib/gateway/singleton");
      const { removeRemoteWorktree } = await import("@/lib/remote-worktree");
      try {
        const driver = await getGateway().getOnlineDriver(body.deviceId);
        await removeRemoteWorktree(driver, body.cwd, body.path, body.force === true);
        return NextResponse.json({ success: true });
      } catch (error) {
        if (error instanceof DeviceOfflineError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        // Same force/plain split as the local branch: git refuses a dirty or
        // submodule-bearing worktree without --force, and the UI offers it only
        // when the refusal says that is what would help.
        const needsForce = worktreeRemovalRequiresForce(message);
        return NextResponse.json({ error: message, dirty: needsForce }, { status: needsForce ? 409 : 400 });
      }
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;

    await removeWorktree(body.cwd, body.path, body.force === true);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Git refuses some worktree removals without --force, including worktrees
    // with submodule state. Surface that so the UI can offer confirmation.
    const dirty = worktreeRemovalRequiresForce(message);
    return NextResponse.json({ error: message, dirty }, { status: dirty ? 409 : 400 });
  }
}
