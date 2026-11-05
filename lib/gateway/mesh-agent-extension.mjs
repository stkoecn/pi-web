/**
 * Standalone mesh extension for pi coding agent sessions.
 * Injected automatically by pi-web gateway via `pi --mode rpc -e <path>`.
 *
 * Capabilities:
 * 1. Provides `send_session_message` and `list_session_contact` tools to ANY session (local or remote).
 * 2. Defaults to "realtime" delivery mode, blocking execution until receiving a response or 300s timeout.
 * 3. Uses reverse bridge (http://127.0.0.1:29564) over SSH tunnel for synchronous bi-directional RPC.
 * 4. Falls back to writing RPC stdout frame `mesh_outbound` if bridge is offline.
 * 5. Offline resilience: saves to `~/.pi/agent/mesh/outbox` if completely unreachable.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function getOutboxDir() {
  const dir = path.join(getAgentDir(), "mesh", "outbox");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function emitOutboundFrame(payload) {
  const frame = JSON.stringify({
    type: "mesh_outbound",
    target: payload.target,
    message: payload.message,
    mode: payload.mode,
    sender: payload.sender,
    senderContext: payload.senderContext,
    data: payload,
  }) + "\n";
  try {
    process.stdout.write(frame);
  } catch {}
  try {
    process.stderr.write(frame);
  } catch {}
}

function saveToOutbox(payload) {
  try {
    const outbox = getOutboxDir();
    const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
    fs.writeFileSync(path.join(outbox, filename), JSON.stringify(payload, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

let runtimeSessionId = process.env.PI_SESSION_ID || null;

export default function(pi) {
  if (pi.on) {
    pi.on("session_start", (event) => {
      const sid = event?.session?.id || event?.sessionId;
      if (sid) runtimeSessionId = sid;
    });
  }
  // 1. send_session_message tool
  pi.registerTool({
    name: "send_session_message",
    label: "Send Session Message",
    description: "Send a message to another session or start a new session on this host or any connected remote host. In 'realtime' mode (default), the CALLER/SENDER is blocked waiting for the recipient's reply. The sender unblocks as soon as any message arrives from the recipient (or user) or upon timeout (300s), and the reply is returned directly as the tool result. NOTE: The recipient MUST reply by calling send_session_message back to the sender; simply outputting text will NOT be received by the sender. Other delivery modes: 'steer' (interrupts and prioritizes processing immediately without blocking the sender), 'followup' (queues after current tasks finish without blocking the sender), or 'silent' (notification only, no reply expected). Each mode automatically attaches an explicit header informing the recipient of the blocking state and reply protocol.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Destination target in format 'sessionId.host' (e.g. '01a18806-xxxx-xxxx.wshome' or '442d76a5.wsnas', as shown in the [From replyTarget] prompt header) or '@project.host' or 'host:absolutePath' to start a new session.",
        },
        message: {
          type: "string",
          description: "The instructions, context, or question to send to the target session. When replying to an incoming cross-session message, you MUST call this tool with your reply text instead of merely outputting assistant text.",
        },
        mode: {
          type: "string",
          enum: ["realtime", "steer", "followup", "silent"],
          description: "Delivery mode: 'realtime' (default; sender is blocked waiting for recipient to reply via send_session_message, unblocking on any reply or timeout), 'steer' (sender is NOT blocked; interrupts recipient immediately), 'followup' (sender is NOT blocked; queues after recipient finishes current task), or 'silent' (notification only, no reply expected).",
        },
      },
      required: ["target", "message"],
    },
    async execute(_toolCallId, params) {
      const target = (params.target || "").trim();
      const message = params.message;
      const mode = params.mode || "realtime";

      // Detect current device identity
      const currentHost = process.env.PI_WEB_DEVICE_ID || os.hostname();
      const currentSess = runtimeSessionId || process.env.PI_SESSION_ID || undefined;

      const payload = {
        target,
        message,
        mode,
        createdAt: Date.now(),
        sender: {
          host: currentHost,
          sessionId: currentSess,
          cwd: process.cwd(),
        },
        senderContext: {
          deviceId: currentHost,
          sessionId: currentSess,
          cwd: process.cwd(),
          isToolCall: true,
        },
      };

      try {
        let result = null;
        let bridgeError = null;
        try {
          // Attempt through reverse bridge for synchronous response
          const bridgePort = process.env.PI_MESH_BRIDGE_PORT || "29564";
          const res = await fetch(`http://127.0.0.1:${bridgePort}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            result = await res.json();
          } else {
            let errText = "";
            try {
              const errJson = await res.json();
              errText = errJson.error || errJson.message || JSON.stringify(errJson);
            } catch {
              errText = await res.text();
            }
            bridgeError = `Bridge returned HTTP ${res.status}: ${errText}`;
          }
        } catch (_) {
          // Network error or reverse bridge not open
        }

        // 1. Explicit HTTP failure from bridge
        if (bridgeError) {
          return {
            content: [{
              type: "text",
              text: `Failed to deliver mesh message to \"${target}\": ${bridgeError}`,
            }],
            details: undefined,
          };
        }

        // 2. Explicit dispatch failure reported by gateway
        if (result && result.success === false) {
          return {
            content: [{
              type: "text",
              text: `Failed to deliver mesh message to \"${target}\": ${result.error || "Unknown gateway dispatch failure"}`,
            }],
            details: undefined,
          };
        }

        // 3. Fallback when bridge is offline (not listening)
        if (!result) {
          const emitted = emitOutboundFrame(payload);
          if (!emitted) {
            saveToOutbox(payload);
          }
          return {
            content: [{
              type: "text",
              text: `Reverse bridge is offline. Message queued via outbound RPC channel to \"${target}\" (mode: ${mode}). Note: Synchronous reply is unavailable in queued mode.`,
            }],
            details: undefined,
          };
        }

        const replySection = result?.reply
          ? `\n\n[Response received from ${result.targetSessionId || target}]:\n${result.reply}`
          : "";
        return {
          content: [{
            type: "text",
            text: `Message dispatched to \"${target}\" (mode: ${mode}).${replySection}`,
          }],
          details: undefined,
        };
      } catch (err) {
        // Fallback: save to local outbox for pi-web gateway to drain on next sync
        const saved = saveToOutbox(payload);
        return {
          content: [{
            type: "text",
            text: saved
              ? `Channel currently unreachable. Message saved to local outbox and will be delivered once gateway reconnects to ${currentHost}.`
              : `Failed to deliver message: ${err instanceof Error ? err.message : String(err)}`,
          }],
          details: undefined,
        };
      }
    },
  });

  // 2. list_session_contact tool
  pi.registerTool({
    name: "list_session_contact",
    label: "List Session Contacts",
    description: "List available sessions and their descriptions from projects explicitly enabled in the current project's team configuration (.pi/team-mesh.json). By default, projects are disabled until enabled in Settings > Team. Use this tool to discover reachable peer sessions for cross-session collaboration.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const configPath = path.join(process.cwd(), ".pi", "team-mesh.json");
      let content = "No team-mesh.json found in current project.";
      if (fs.existsSync(configPath)) {
        try {
          content = fs.readFileSync(configPath, "utf8");
        } catch {}
      }
      return {
        content: [{
          type: "text",
          text: content,
        }],
      };
    },
  });
}
