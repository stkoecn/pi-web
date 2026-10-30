import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { sendMeshMessage } from "./mesh-router";
import {
  readProjectTeamConfig,
  readGlobalMeshDescriptions,
  parseProjectKey,
} from "./team-mesh-config";
import { getGateway } from "./singleton";
import { isRemoteDevice, LOCAL_DEVICE_ID } from "../device-context";
import { getCanonicalHostId, isLocalHostId } from "./host-identity";
import { listAllSessions } from "../session-reader";
import { readSessionUiState } from "../session-ui-state";
import { sessionDisplayTitle } from "../session-fork-name";

export const MESH_EXTENSION_NAME = "pi-web-mesh";

export function createMeshExtension(currentDeviceId = getCanonicalHostId(), currentSessionId?: string, currentCwd?: string): InlineExtension {
  const hostId = isLocalHostId(currentDeviceId) ? getCanonicalHostId() : currentDeviceId;
  return {
    name: MESH_EXTENSION_NAME,
    factory: async (pi) => {
      // 1. send_session_message tool
      pi.registerTool(defineTool({
        name: "send_session_message",
        label: "Send Session Message",
        description: "Send a message to another session or start a new session on this host or any connected remote host. Target format: 'sessionId.host' (e.g. '01a18806-xxxx-xxxx.wshome' or '442d76a5.wsnas') or '@project.host' to start a new session.",
        parameters: Type.Object({
          target: Type.String({
            description: "Destination target in the format 'sessionId.host' (e.g. '01a18806-xxxx-xxxx.wshome', using the target specified in [From target][reply by using send_session_message]) or '@project.host' to start a new session.",
          }),
          message: Type.String({
            description: "The instructions, context, or question to send to the target session.",
          }),
          mode: Type.Optional(Type.Union([
            Type.Literal("followup"),
            Type.Literal("steer"),
            Type.Literal("silent"),
          ], {
            description: "Delivery mode: 'followup' (default, queues after current turn), 'steer' (interrupts agent immediately), or 'silent' (notification only).",
          })),
        }),
        async execute(_toolCallId, params) {
          try {
            const result = await sendMeshMessage({
              target: params.target,
              message: params.message,
              mode: params.mode || "followup",
              currentDeviceId: hostId,
              senderContext: {
                deviceId: hostId,
                sessionId: currentSessionId,
                cwd: currentCwd,
              },
            });
            return {
              content: [{
                type: "text",
                text: `Message successfully dispatched to ${result.targetSessionId} on host "${result.targetDeviceId}" (mode: ${result.mode}, newSession: ${result.createdNewSession}).`,
              }],
              details: undefined,
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Failed to deliver mesh message to "${params.target}": ${error instanceof Error ? error.message : String(error)}`,
              }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));

      // 2. list_session_contact tool
      pi.registerTool(defineTool({
        name: "list_session_contact",
        label: "List Session Contacts",
        description: "List available sessions and their descriptions from projects explicitly enabled in the current project's team configuration (.pi/team-mesh.json). By default, projects are disabled until enabled in Settings > Team. Use this tool to discover reachable peer sessions for cross-session collaboration.",
        parameters: Type.Object({}),
        async execute(_toolCallId) {
          try {
            if (!currentCwd) {
              return {
                content: [{
                  type: "text",
                  text: "No current project directory (cwd) is associated with this session. Cannot read team contacts configuration.",
                }],
                details: undefined,
              };
            }

            const projectCfg = readProjectTeamConfig(currentCwd);
            if (!projectCfg.enabledProjects || projectCfg.enabledProjects.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: `No external or local projects are currently enabled for contact in this project.\n` +
                    `You can enable projects in Team Settings (saved to ${currentCwd}/.pi/team-mesh.json).`,
                }],
                details: undefined,
              };
            }

            const globalDesc = readGlobalMeshDescriptions();
            const gateway = getGateway();

            interface ContactEntry {
              target: string;
              sessionId: string;
              host: string;
              projectPath: string;
              projectDescription?: string;
              sessionTitle?: string;
              sessionDescription?: string;
              messageCount?: number;
              lastActive?: string;
            }

            const contacts: ContactEntry[] = [];

            for (const key of projectCfg.enabledProjects) {
              const { deviceId, projectPath } = parseProjectKey(key);
              const isLocal = isLocalHostId(deviceId);
              const devEntry = !isLocal ? gateway.registry.get(deviceId) : null;
              const isOnline = isLocal || Boolean(devEntry?.driver.isAlive());

              if (!isOnline) {
                continue;
              }

              const normProj = projectPath.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
              const pDesc = globalDesc.projectDescriptions[deviceId]?.[projectPath] ||
                globalDesc.projectDescriptions[deviceId]?.[projectPath.replace(/\\/g, "/")] ||
                "";

              const devSessDesc = globalDesc.sessionDescriptions[deviceId] || {};

              try {
                if (isLocal) {
                  const uiState = readSessionUiState();
                  const archivedSessions = uiState?.sessions || {};
                  const all = await listAllSessions().catch(() => []);
                  for (const s of all) {
                    if (s.id === currentSessionId) continue;
                    if (archivedSessions[s.id]?.archivedAt) continue;

                    const sNorm = (s.cwd || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
                    if (sNorm !== normProj) continue;

                    const sDesc = devSessDesc[s.id] || "";
                    const title = sessionDisplayTitle(s);
                    contacts.push({
                      target: `${s.id}.${deviceId}`,
                      sessionId: s.id,
                      host: deviceId,
                      projectPath: s.cwd || projectPath,
                      projectDescription: pDesc || undefined,
                      sessionTitle: title,
                      sessionDescription: sDesc || undefined,
                      messageCount: s.messageCount,
                      lastActive: s.modified ? new Date(s.modified).toISOString() : undefined,
                    });
                  }
                } else {
                  const { listRemoteSessions } = await import("../remote-session-store");
                  const all = await listRemoteSessions(deviceId).catch(() => []);
                  for (const s of all) {
                    if (s.id === currentSessionId) continue;
                    const sNorm = (s.cwd || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
                    if (sNorm !== normProj) continue;

                    const sDesc = devSessDesc[s.id] || "";
                    const title = sessionDisplayTitle(s);
                    contacts.push({
                      target: `${s.id}.${deviceId}`,
                      sessionId: s.id,
                      host: deviceId,
                      projectPath: s.cwd || projectPath,
                      projectDescription: pDesc || undefined,
                      sessionTitle: title,
                      sessionDescription: sDesc || undefined,
                      messageCount: s.messageCount,
                      lastActive: s.modified ? new Date(s.modified).toISOString() : undefined,
                    });
                  }
                }
              } catch (e) {
                console.error(`[list_session_contact] Error listing sessions for ${key}:`, e);
              }
            }

            if (contacts.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: `Found ${projectCfg.enabledProjects.length} enabled project(s), but no active sessions were found (or target hosts are offline).\nEnabled projects: ${projectCfg.enabledProjects.join(", ")}`,
                }],
                details: undefined,
              };
            }

            const formatted = contacts.map((c, i) => {
              const lines = [
                `[${i + 1}] Target: ${c.target}`,
                `    Host: ${c.host}`,
                `    Project: ${c.projectPath}${c.projectDescription ? ` (${c.projectDescription})` : ""}`,
                `    Session: "${c.sessionTitle || c.sessionId}"`,
              ];
              if (c.sessionDescription) {
                lines.push(`    Description: ${c.sessionDescription}`);
              }
              if (c.messageCount !== undefined) {
                lines.push(`    Messages: ${c.messageCount}`);
              }
              if (c.lastActive) {
                lines.push(`    Last Active: ${c.lastActive}`);
              }
              return lines.join("\n");
            }).join("\n\n");

            return {
              content: [{
                type: "text",
                text: `Available Session Contacts (${contacts.length}):\n\n${formatted}\n\nTo send a message, use send_session_message with the Target shown above.`,
              }],
              details: undefined,
            };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Failed to list session contacts: ${error instanceof Error ? error.message : String(error)}`,
              }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));
    },
  };
}
