import { NextResponse } from "next/server";
import { statSync, type Stats } from "fs";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { allowFileRoot } from "@/lib/file-access";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";

function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const body = await req.json() as { cwd?: unknown; deviceId?: string };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const deviceId = body.deviceId || searchParams.get("deviceId") || req.headers.get("x-device-id");

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    if (deviceId && deviceId !== "localhost") {
      const { getGateway } = await import("@/lib/gateway/singleton");
      const driver = await getGateway().getOrConnectDriver(deviceId);
      try {
        const stat = await driver.stat(cwd);
        if (!stat.isDirectory) {
          return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
        }
        return NextResponse.json({
          normalized: cwd,
          projectRoot: cwd,
          projectKey: `device:${deviceId}:${cwd}`,
        });
      } catch {
        return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
      }
    }

    const normalizedCwd = normalizeCwd(cwd);
    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    allowFileRoot(normalizedCwd);
    const project = await resolveProject(normalizedCwd);
    return NextResponse.json({
      success: true,
      cwd: normalizedCwd,
      projectRoot: project.projectRoot,
      projectKey: projectIdentityKey(project.projectRoot),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
