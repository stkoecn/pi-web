import { NextResponse } from "next/server";
import { disambiguateProjectPaths } from "@/lib/gateway/project-disambiguation";
import { getGateway } from "@/lib/gateway/singleton";
import { isRemoteDevice, LOCAL_DEVICE_ID } from "@/lib/device-context";
import { getCanonicalHostId, isLocalHostId } from "@/lib/gateway/host-identity";
import { listAllSessions } from "@/lib/session-reader";
import { readSessionUiState } from "@/lib/session-ui-state";
import { sessionDisplayTitle } from "@/lib/session-fork-name";
import {
  readGlobalMeshDescriptions,
  setProjectDescription,
  setSessionDescription,
  readProjectTeamConfig,
  toggleProjectEnabledForContacts,
  isProjectEnabledForContacts,
} from "@/lib/gateway/team-mesh-config";

// GET /api/mesh/roster - Get entire host-project-session topology with descriptions & enabled status
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const targetDevice = url.searchParams.get("deviceId");
    const currentCwd = url.searchParams.get("currentCwd") || "";

    const gateway = getGateway();
    const globalDesc = readGlobalMeshDescriptions();

    // Read per-project team config if currentCwd is provided
    const projectTeamCfg = currentCwd ? readProjectTeamConfig(currentCwd) : { version: 1 as const, enabledProjects: [] };
    const enabledSet = new Set(projectTeamCfg.enabledProjects.map((k) => k.toLowerCase()));

    // Collect devices - ensure unique deviceIds, mapped to canonical host ID for local
    const canonicalLocal = getCanonicalHostId();
    const deviceEntries = gateway.listDevices();
    const allDeviceIds = Array.from(new Set([canonicalLocal, ...deviceEntries.map((d) => isLocalHostId(d.id) ? canonicalLocal : d.id)]));

    const result: Array<{
      deviceId: string;
      online: boolean;
      projects: Array<{
        path: string;
        alias?: string;
        description: string;
        enabled: boolean;
        disambiguatedLabel?: string;
        sessions: Array<{
          id: string;
          name?: string;
          title?: string;
          description: string;
          updatedAt?: number;
          messageCount?: number;
        }>;
      }>;
    }> = [];

    const deviceIdsToScan = targetDevice ? [isLocalHostId(targetDevice) ? canonicalLocal : targetDevice] : allDeviceIds;

    for (const devId of deviceIdsToScan) {
      const isLocal = isLocalHostId(devId);
      const devEntry = !isLocal ? gateway.registry.get(devId) : null;
      const isOnline = isLocal || Boolean(devEntry?.driver.isAlive());

      const projectMap = new Map<string, Array<{
        id: string;
        name?: string;
        title?: string;
        description: string;
        updatedAt?: number;
        messageCount?: number;
      }>>();

      const devDesc = globalDesc.projectDescriptions[devId] || {};
      const devSessDesc = globalDesc.sessionDescriptions[devId] || {};

      // Read sessions if online
      let projectRenames: Record<string, string> = {};
      if (isOnline) {
        try {
          if (isLocal) {
            const uiState = readSessionUiState();
            projectRenames = uiState?.projectNames || {};
            const archivedSessions = uiState?.sessions || {};
            const sessions = await listAllSessions().catch(() => []);
            for (const s of sessions) {
              const isArchived = Boolean(archivedSessions[s.id]?.archivedAt);
              if (isArchived) continue;

              const cwd = (s.cwd || "default").replace(/\\/g, "/");
              if (!projectMap.has(cwd)) projectMap.set(cwd, []);
              const desc = devSessDesc[s.id] || "";
              const title = sessionDisplayTitle(s);
              projectMap.get(cwd)!.push({
                id: s.id,
                name: s.name,
                title,
                description: desc,
                updatedAt: s.modified ? new Date(s.modified).getTime() : undefined,
                messageCount: s.messageCount,
              });
            }
          } else {
            const { listRemoteSessions, readRemoteSessionUiState } = await import("@/lib/remote-session-store");
            // Do not force a slow full scan if cached catalog exists, reducing network latency
            const remoteUiState = await readRemoteSessionUiState(devId).catch(() => ({ projectNames: {}, sessions: {} }));
            projectRenames = remoteUiState.projectNames || {};
            const archivedSessions: Record<string, { archivedAt?: number }> = remoteUiState.sessions || {};
            const sessions = await listRemoteSessions(devId).catch(() => []);
            for (const s of sessions) {
              const isArchived = Boolean(archivedSessions[s.id]?.archivedAt);
              if (isArchived) continue;

              const cwd = (s.cwd || "default").replace(/\\/g, "/");
              if (!projectMap.has(cwd)) projectMap.set(cwd, []);
              const desc = devSessDesc[s.id] || "";
              const title = sessionDisplayTitle(s);
              projectMap.get(cwd)!.push({
                id: s.id,
                name: s.name,
                title,
                description: desc,
                updatedAt: s.modified ? new Date(s.modified).getTime() : undefined,
                messageCount: s.messageCount,
              });
            }
          }
        } catch (e) {
          console.error(`[mesh/roster] Failed to list sessions for ${devId}:`, e);
        }
      }

      // Also ensure any configured project descriptions show up even if no current sessions
      for (const pPath of Object.keys(devDesc)) {
        if (!projectMap.has(pPath)) projectMap.set(pPath, []);
      }

      // Compute automatic disambiguation labels for projects on this device
      const allPaths = Array.from(projectMap.keys());
      const disambiguatedLabels = disambiguateProjectPaths(allPaths);

      const projects = Array.from(projectMap.entries()).map(([pPath, sessions]) => {
        const customName = projectRenames[pPath] || projectRenames[pPath.replace(/\\/g, "/")];
        const projKey = `${devId}:${pPath}`.toLowerCase();
        const isEnabled = enabledSet.has(projKey);
        const projDesc = devDesc[pPath] || "";

        return {
          path: pPath,
          alias: customName,
          description: projDesc,
          enabled: isEnabled,
          disambiguatedLabel: disambiguatedLabels.get(pPath) || pPath.split("/").pop() || pPath,
          sessions,
        };
      });

      result.push({
        deviceId: devId,
        online: isOnline,
        projects,
      });
    }

    return NextResponse.json({ success: true, roster: result });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

// POST /api/mesh/roster - Set descriptions or toggle enabled projects
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      action: "set_project_description" | "set_session_description" | "toggle_project_enabled";
      deviceId: string;
      projectPath?: string;
      sessionId?: string;
      description?: string;
      currentCwd?: string;
      enabled?: boolean;
    };

    if (body.action === "set_project_description") {
      if (!body.deviceId || !body.projectPath) {
        return NextResponse.json({ error: "Missing deviceId or projectPath" }, { status: 400 });
      }
      const targetDev = isLocalHostId(body.deviceId) ? getCanonicalHostId() : body.deviceId;
      setProjectDescription(targetDev, body.projectPath, body.description || "");
      return NextResponse.json({ success: true });
    }

    if (body.action === "set_session_description") {
      if (!body.deviceId || !body.sessionId) {
        return NextResponse.json({ error: "Missing deviceId or sessionId" }, { status: 400 });
      }
      const targetDev = isLocalHostId(body.deviceId) ? getCanonicalHostId() : body.deviceId;
      setSessionDescription(targetDev, body.sessionId, body.description || "");
      return NextResponse.json({ success: true });
    }

    if (body.action === "toggle_project_enabled") {
      if (!body.currentCwd || !body.deviceId || !body.projectPath || body.enabled === undefined) {
        return NextResponse.json({ error: "Missing required fields for toggle_project_enabled" }, { status: 400 });
      }
      const targetDev = isLocalHostId(body.deviceId) ? getCanonicalHostId() : body.deviceId;
      toggleProjectEnabledForContacts(body.currentCwd, targetDev, body.projectPath, body.enabled);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
