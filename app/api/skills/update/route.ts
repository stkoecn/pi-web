import { NextResponse } from "next/server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { runNpx } from "@/lib/npx";
import type { SkillInstallScope } from "@/lib/api-types";
import { buildSkillUpdateArgs } from "@/lib/skill-updates";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const deviceId = getRequestDeviceId(req);
  try {
    const body = await req.json() as {
      cwd?: unknown;
      package?: unknown;
      scope?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const pkg = typeof body.package === "string" ? body.package : "";
    const scope = body.scope === "global" || body.scope === "project"
      ? body.scope as SkillInstallScope
      : undefined;
    if (!cwd || !pkg || !scope) {
      return NextResponse.json({ error: "cwd, package, and scope are required" }, { status: 400 });
    }
    // A device's folders are neither on this machine nor subject to its
    // allow-list; the device's own listing already decided what may be read.
    if (!isRemoteDevice(deviceId)) {
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }

    const { skills } = isRemoteDevice(deviceId)
      ? { skills: (await (await import("@/lib/remote-settings")).readRemoteSkills(deviceId, cwd)).skills }
      : await loadSkillsWithInstallInfo(cwd);
    const skill = skills.find(
      (item) => item.install?.package === pkg && item.install.scope === scope,
    );
    if (!skill?.install) {
      return NextResponse.json({ error: "Installed skill not found" }, { status: 404 });
    }
    if (!skill.install.canCheckForUpdates) {
      return NextResponse.json({ error: "This skill cannot be updated automatically" }, { status: 400 });
    }

    // The update runs the same `skills add` the CLI uses for an install, on the
    // machine that owns the skill: a device's copy must not be replaced by
    // whatever this host happens to have.
    let output: string;
    if (isRemoteDevice(deviceId)) {
      const { updateRemoteSkill } = await import("@/lib/remote-skill-writes");
      output = (await updateRemoteSkill(deviceId, { install: skill.install, cwd })).output;
    } else {
      const { stdout, stderr } = await runNpx(buildSkillUpdateArgs(skill.install), {
        timeout: 60_000,
        cwd: scope === "project" ? cwd : undefined,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      output = `${stdout}${stderr}`;
    }

    // Re-read from where the update ran: the device's listing is cached, so a
    // stale one would report the version that was just replaced.
    const refreshed = isRemoteDevice(deviceId)
      ? await (await import("@/lib/remote-settings")).readRemoteSkills(deviceId, cwd, { force: true })
      : await loadSkillsWithInstallInfo(cwd);
    const updatedSkill = refreshed.skills.find(
      (item) => item.install?.package === pkg && item.install.scope === scope,
    );
    return NextResponse.json({
      success: true,
      skill: updatedSkill,
      output: output.slice(-500),
    });
  } catch (error: unknown) {
    if ((error as { code?: unknown } | null)?.code === "device-offline") {
      return NextResponse.json({ error: String(error) }, { status: 503 });
    }
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${detail.stdout ?? ""}${detail.stderr ?? ""}`;
    return NextResponse.json(
      { error: output || detail.message || String(error) },
      { status: 500 },
    );
  }
}
