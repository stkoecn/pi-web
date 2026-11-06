import "server-only";
import { readRemoteSkills } from "@/lib/remote-settings";

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

/**
 * Standard coding agent core tool loadout descriptions.
 */
const BASE_TOOLS: ToolEntry[] = [
  {
    name: "read",
    description: "Read file contents. Supports text files and images. Automatically handles offset and line pagination.",
    active: true,
  },
  {
    name: "edit",
    description: "Make precise targeted file edits using exact text replacement.",
    active: true,
  },
  {
    name: "write",
    description: "Create or overwrite files with complete content. Automatically creates parent directories.",
    active: true,
  },
  {
    name: "bash",
    description: "Execute bash/shell commands in the current working directory. Returns stdout and stderr.",
    active: true,
  },
  {
    name: "grep",
    description: "Search for regex patterns across files in the directory tree.",
    active: true,
  },
  {
    name: "find",
    description: "Find files matching a glob pattern within the workspace.",
    active: true,
  },
  {
    name: "ls",
    description: "List directory contents with file metadata.",
    active: true,
  },
  {
    name: "ask",
    description: "Ask the user structured questions with tappable/selectable options.",
    active: true,
  },
  {
    name: "send_session_message",
    description: "Send a message to another session or start a new session on this host or any connected remote host. Target format: 'sessionId.host' (e.g. '01a18806-xxxx-xxxx.wshome' or '442d76a5.wsnas') or '@project.host' to start a new session. In 'realtime' mode (default), the sender blocks waiting for up to 300s, unblocking if interrupted by any incoming message, user action, or timeout. Incoming messages from peers are delivered as standard chat messages to the conversation stream.",
    active: true,
  },
  {
    name: "list_session_contact",
    description: "List available sessions and their descriptions from projects explicitly enabled in the team configuration.",
    active: true,
  },
  {
    name: "create_goal",
    description: "Create one durable bounded goal for this agent session.",
    active: true,
  },
  {
    name: "update_goal",
    description: "Optionally provide terminal evidence or mark goal completed/blocked.",
    active: true,
  },
  {
    name: "checkpoint_goal",
    description: "Record durable agent-reported progress and evidence.",
    active: true,
  },
  {
    name: "plugins",
    description: "Inspect and manage Pi plugins for the current project or globally.",
    active: true,
  },
  {
    name: "web_search",
    description: "Search the web and return source-linked results or provider answers.",
    active: true,
  },
  {
    name: "fetch_content",
    description: "Fetch readable markdown or raw content from external URLs.",
    active: true,
  },
];

/**
 * Resolves available tools for a remote session by combining the core toolset
 * with any skills installed on the targeted remote device.
 */
export async function getRemoteTools(deviceId: string, cwd?: string): Promise<ToolEntry[]> {
  const tools: ToolEntry[] = [...BASE_TOOLS];

  // Try to read remote skills installed on the device and append them as active tools
  try {
    const effectiveCwd = cwd || "/";
    const skillsResp = await readRemoteSkills(deviceId, effectiveCwd);
    if (skillsResp && Array.isArray(skillsResp.skills)) {
      for (const skill of skillsResp.skills) {
        if (!tools.some((t) => t.name === skill.name)) {
          tools.push({
            name: skill.name,
            description: skill.description || `Skill: ${skill.name}`,
            active: true,
          });
        }
      }
    }
  } catch {
    // If reading skills fails, return base tools without disruption
  }

  return tools;
}
