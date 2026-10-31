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

export default function(pi) {
  // 1. send_session_message tool
  pi.registerTool({
    name: "send_session_message",
    label: "Send Session Message",
    description: "Send a message to another session or start a new session on this host or any connected remote host. Defaults to 'realtime' mode, which blocks execution until a reply is received from the recipient or up to 300s timeout, returning the recipient's response directly to you. Other modes: 'steer' (interrupts and prioritizes processing immediately without blocking this tool), 'followup' (queues after current tasks finish), or 'silent' (notification only, no reply expected). Each mode automatically attaches an appropriate prompt (e.g. realtime prompts 'Waiting for a reply, please process it as soon as possible'). Target format: 'sessionId.host' (e.g. '01a18806-xxxx-xxxx.wshome' or '442d76a5.wsnas', using the target specified in [From target][reply by using send_session_message]) or '@project.host' to start a new session.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Destination target in format 'sessionId.host' (e.g. '01a18806-xxxx-xxxx.wshome') or '@project.host' to start a new session.",
        },
        message: {
          type: "string",
          description: "The instructions, context, or question to send to the target session.",
        },
        mode: {
          type: "string",
          enum: ["realtime", "steer", "followup", "silent"],
          description: "Delivery mode: 'realtime' (default; blocks execution until the recipient replies or 300s timeout, returning the reply directly), 'steer' (interrupts and engages the recipient immediately without blocking), 'followup' (queues after current tasks complete), or 'silent' (notification only, no reply required).",
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

      const payload = {
        target,
        message,
        mode,
        createdAt: Date.now(),
        sender: {
          host: currentHost,
          sessionId: process.env.PI_SESSION_ID,
          cwd: process.cwd(),
        },
        senderContext: {
          deviceId: currentHost,
          sessionId: process.env.PI_SESSION_ID,
          cwd: process.cwd(),
        },
      };

      try {
        let result = null;
        try {
          // Attempt through reverse bridge for synchronous response
          const res = await fetch("http://127.0.0.1:29564", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            result = await res.json();
          }
        } catch (_) {}

        if (!result) {
          // Fall back to RPC outbound frame over SSH
          emitOutboundFrame(payload);
        }

        const replySection = result?.reply
          ? `\n\n[Response received from ${result.targetSessionId || target}]:\n${result.reply}`
          : "";

        return {
          content: [{
            type: "text",
            text: `Message dispatched to "${target}" (mode: ${mode}).${replySection}`,
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
