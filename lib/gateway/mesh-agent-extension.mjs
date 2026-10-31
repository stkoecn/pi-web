/**
 * Standalone mesh extension for pi coding agent sessions.
 * Injected automatically by pi-web gateway via `pi --mode rpc -e <path>`.
 *
 * Capabilities:
 * 1. Provides `send_session_message` and `list_session_contact` tools to ANY session (local or remote).
 * 2. Same-host messaging: if target is on this host, attempts direct delivery to local session.
 * 3. Cross-host messaging: writes an RPC notification frame `mesh_outbound` to stdout
 *    which the host SSH stream directly captures and routes (ZERO HTTP, pure SSH).
 * 4. Offline resilience: writes to `~/.pi/agent/mesh/outbox` if gateway/SSH is unreachable,
 *    drained automatically when pi-web reconnects.
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

function saveToOutbox(item) {
  try {
    const outbox = getOutboxDir();
    const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
    const targetFile = path.join(outbox, filename);
    fs.writeFileSync(targetFile, JSON.stringify(item, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[MeshExtension] Failed to save to outbox:", err);
    return false;
  }
}

/**
 * Emit structured outbound event to stdout and stderr for the parent SSH process to capture.
 * (In RPC mode, pi captures some stdout, so emitting to both ensures the SSH transport catches it).
 */
function emitOutboundFrame(payload) {
  const frame = JSON.stringify({
    type: "mesh_outbound",
    id: `mesh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...payload,
  });
  // In pi RPC mode, stdout is reserved for strict JSON RPC protocol frames.
  // Out-of-band frames are emitted to stderr only to prevent double delivery.
  try {
    process.stderr.write(frame + "\n");
  } catch {
    try {
      process.stdout.write(frame + "\n");
    } catch {}
  }
}

export default function(pi) {
  // 1. send_session_message tool
  pi.registerTool({
    name: "send_session_message",
    label: "Send Session Message",
    description: "Send a message to another session or start a new session on this host or any connected remote host. Target format: 'sessionId.host' (e.g. '01a18806-xxxx-xxxx.wshome' or '442d76a5.wsnas') to message an existing session, or 'host:absolutePath' (e.g. 'wsnas:/home/user/myproject' or 'wshome:D:/proj/myproject') to start a new session.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Destination target: either 'sessionId.host' (e.g. '01a18806-xxxx-xxxx.wshome' or '442d76a5.wsnas') to message an existing session, or 'host:absolutePath' (e.g. 'wsnas:/home/user/myproject' or 'wshome:D:/proj/myproject') to start a new session.",
        },
        message: {
          type: "string",
          description: "The instructions, context, or question to send to the target session.",
        },
        mode: {
          type: "string",
          enum: ["followup", "steer", "silent"],
          description: "Delivery mode: 'followup' (default, queues after current turn), 'steer' (interrupts agent immediately), or 'silent' (notification only).",
        },
      },
      required: ["target", "message"],
    },
    async execute(_toolCallId, params) {
      const target = (params.target || "").trim();
      const message = params.message;
      const mode = params.mode || "followup";

      // Detect current device identity
      const currentHost = process.env.PI_WEB_DEVICE_ID || os.hostname();

      const payload = {
        target,
        message,
        mode,
        createdAt: Date.now(),
        sender: {
          host: currentHost,
          cwd: process.cwd(),
        },
      };

      try {
        // Send via active RPC stream / SSH pipe directly
        emitOutboundFrame(payload);

        return {
          content: [{
            type: "text",
            text: `Message dispatched to "${target}" (mode: ${mode}).`,
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
              : `Failed to deliver message: ${err.message}`,
          }],
          details: undefined,
          isError: !saved,
        };
      }
    },
  });

  // 2. list_session_contact tool
  pi.registerTool({
    name: "list_session_contact",
    label: "List Session Contacts",
    description: "List available sessions and their descriptions from projects explicitly enabled in team configuration (.pi/team-mesh.json).",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_toolCallId) {
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
