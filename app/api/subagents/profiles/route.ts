import { NextResponse } from "next/server";
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";
import { existsSync } from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  deleteSubagentProfile,
  listSubagentProfileSources,
  saveSubagentProfile,
  type SubagentProfile,
  type SubagentWritableScope,
} from "@/lib/subagents";
import { writeDisabledBuiltInSubagent } from "@/lib/subagent-settings";

export const dynamic = "force-dynamic";

async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("Valid cwd required");
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Access denied");
  return cwd;
}

function validateScope(scope: unknown): SubagentWritableScope {
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
  return scope;
}

/** A built-in has no file to save or delete, but its switch is persisted all the same. */
function validateToggleScope(scope: unknown): SubagentWritableScope | "builtin" {
  if (scope === "builtin") return scope;
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global, project, or builtin");
  return scope;
}

export async function GET(req: Request) {
  const deviceId = getRequestDeviceId(req);
  if (isRemoteDevice(deviceId)) {
    // Profiles are files on the device; the local loader would read this host.
    try {
      const { readRemoteSubagentProfiles } = await import("@/lib/remote-settings");
      const requested = new URL(req.url).searchParams.get("cwd");
      const target = requested || (await (await import("@/lib/device-home")).deviceHomeOrDefault(deviceId));
      return NextResponse.json(await readRemoteSubagentProfiles(deviceId, target));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }
  try {
    const cwd = await validateCwd(new URL(req.url).searchParams.get("cwd"));
    return NextResponse.json({ profiles: listSubagentProfileSources(cwd) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PUT(req: Request) {
  const deviceId = getRequestDeviceId(req);
  try {
    const body = await req.json() as {
      cwd?: unknown;
      scope?: unknown;
      profile?: Omit<SubagentProfile, "scope" | "filePath">;
    };
    const scope = validateScope(body.scope);
    if (!body.profile || typeof body.profile.name !== "string") {
      return NextResponse.json({ error: "profile required" }, { status: 400 });
    }
    if (isRemoteDevice(deviceId)) {
      // The profile is a file on the device, rendered by the same composer the
      // local save runs, so both paths write the same bytes.
      const { getGateway } = await import("@/lib/gateway/singleton");
      const { getRemoteAgentDir } = await import("@/lib/remote-settings");
      const { writeRemoteSubagentProfile } = await import("@/lib/remote-subagents");
      const agentDir = await getRemoteAgentDir(deviceId);
      const target = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;
      const driver = getGateway().getOnlineDriver(deviceId);
      const profile = await writeRemoteSubagentProfile(driver, {
        agentDir,
        cwd: target ?? (await (await import("@/lib/device-home")).deviceHomeOrDefault(deviceId)),
        scope,
        profile: body.profile,
      });
      return NextResponse.json({ profile });
    }
    const cwd = await validateCwd(body.cwd);
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, body.profile) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PATCH(req: Request) {
  const deviceId = getRequestDeviceId(req);
  try {
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown; enabled?: unknown };
    const scope = validateToggleScope(body.scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled required" }, { status: 400 });
    const name = body.name;
    if (isRemoteDevice(deviceId)) {
      const { getGateway } = await import("@/lib/gateway/singleton");
      const { getRemoteAgentDir } = await import("@/lib/remote-settings");
      const { toggleRemoteSubagentProfile } = await import("@/lib/remote-subagents");
      const agentDir = await getRemoteAgentDir(deviceId);
      const driver = getGateway().getOnlineDriver(deviceId);
      const target = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;
      const profile = await toggleRemoteSubagentProfile(driver, {
        agentDir,
        cwd: target ?? (await (await import("@/lib/device-home")).deviceHomeOrDefault(deviceId)),
        scope,
        name,
        enabled: body.enabled,
      });
      return NextResponse.json({ profile });
    }
    const cwd = await validateCwd(body.cwd);
    const source = listSubagentProfileSources(cwd).find((profile) =>
      profile.scope === scope && profile.name.toLowerCase() === name.toLowerCase()
    );
    if (!source) return NextResponse.json({ error: "Agent profile not found" }, { status: 404 });
    if (scope === "builtin") {
      writeDisabledBuiltInSubagent(source.name, !body.enabled);
      return NextResponse.json({ profile: { ...source, enabled: body.enabled } });
    }
    const profile: Omit<SubagentProfile, "scope" | "filePath"> = {
      name: source.name,
      displayName: source.displayName,
      description: source.description,
      systemPrompt: source.systemPrompt,
      tools: source.tools,
      ...(source.extensionTools !== undefined ? { extensionTools: [...source.extensionTools] } : {}),
      ...(source.disallowedExtensionTools !== undefined ? { disallowedExtensionTools: [...source.disallowedExtensionTools] } : {}),
      loadSkills: source.loadSkills,
      ...(source.skills !== undefined ? { skills: [...source.skills] } : {}),
      loadExtensions: source.loadExtensions,
      ...(source.extensions !== undefined ? { extensions: [...source.extensions] } : {}),
      codemode: source.codemode,
      mcp: source.mcp,
      promptMode: source.promptMode,
      model: source.model,
      thinking: source.thinking,
      maxTurns: source.maxTurns,
      inheritContext: source.inheritContext,
      runInBackground: source.runInBackground,
      color: source.color,
      isolation: source.isolation,
      persistSession: source.persistSession,
      enabled: source.enabled,
    };
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, { ...profile, enabled: body.enabled }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function DELETE(req: Request) {
  const deviceId = getRequestDeviceId(req);
  try {
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown };
    const scope = validateScope(body.scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    if (isRemoteDevice(deviceId)) {
      const { getGateway } = await import("@/lib/gateway/singleton");
      const { getRemoteAgentDir } = await import("@/lib/remote-settings");
      const { deleteRemoteSubagentProfile } = await import("@/lib/remote-subagents");
      const agentDir = await getRemoteAgentDir(deviceId);
      const driver = getGateway().getOnlineDriver(deviceId);
      const target = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;
      await deleteRemoteSubagentProfile(driver, {
        agentDir,
        cwd: target ?? (await (await import("@/lib/device-home")).deviceHomeOrDefault(deviceId)),
        scope,
        name: body.name,
      });
      return NextResponse.json({ ok: true });
    }
    const cwd = await validateCwd(body.cwd);
    deleteSubagentProfile(cwd, scope, body.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}
