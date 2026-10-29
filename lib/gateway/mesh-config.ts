import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export interface MeshConfig {
  version: 1;
  aliases: Record<string, Record<string, Record<string, string>>>; // deviceId -> projectPath/key -> alias -> sessionId
  projectAliases: Record<string, Record<string, string>>; // deviceId -> projectAlias -> projectPath
}

let cachedConfig: MeshConfig | null = null;

function getConfigPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, ".pi", "agent", "mesh-aliases.json");
}

export function readMeshConfig(): MeshConfig {
  if (cachedConfig) return cachedConfig;
  const filePath = getConfigPath();
  if (!existsSync(filePath)) {
    cachedConfig = {
      version: 1,
      aliases: {},
      projectAliases: {},
    };
    return cachedConfig;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    cachedConfig = JSON.parse(raw);
    if (!cachedConfig?.aliases) cachedConfig!.aliases = {};
    if (!cachedConfig?.projectAliases) cachedConfig!.projectAliases = {};
    return cachedConfig!;
  } catch (e) {
    console.error("[MeshConfig] Failed to read config:", e);
    cachedConfig = { version: 1, aliases: {}, projectAliases: {} };
    return cachedConfig;
  }
}

export function writeMeshConfig(config: MeshConfig): void {
  cachedConfig = config;
  const filePath = getConfigPath();
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    console.error("[MeshConfig] Failed to save config:", e);
  }
}

export function getSessionAlias(deviceId: string, projectPath: string, alias: string): string | undefined {
  const cfg = readMeshConfig();
  const dev = cfg.aliases[deviceId];
  if (!dev) return undefined;
  // Try exact match on projectPath
  const proj = dev[projectPath] || dev[projectPath.replace(/\\/g, "/")];
  if (proj && proj[alias]) return proj[alias];
  // Try searching all projects in this device if not found
  for (const p of Object.values(dev)) {
    if (p[alias]) return p[alias];
  }
  return undefined;
}

export function setSessionAlias(deviceId: string, projectPath: string, alias: string, sessionId: string): void {
  const cfg = readMeshConfig();
  const normalizedPath = projectPath.replace(/\\/g, "/");
  if (!cfg.aliases[deviceId]) cfg.aliases[deviceId] = {};
  if (!cfg.aliases[deviceId][normalizedPath]) cfg.aliases[deviceId][normalizedPath] = {};
  // If this session already had an older alias in this project, remove it first
  for (const [existingAlias, existingSessId] of Object.entries(cfg.aliases[deviceId][normalizedPath])) {
    if (existingSessId === sessionId) {
      delete cfg.aliases[deviceId][normalizedPath][existingAlias];
    }
  }
  cfg.aliases[deviceId][normalizedPath][alias] = sessionId;
  writeMeshConfig(cfg);

  // Synchronize to session ui-state so the session tree immediately reflects the alias name
  try {
    const { updateSessionUiState } = require("@/lib/session-ui-state");
    updateSessionUiState((state: any) => {
      if (!state.sessions) state.sessions = {};
      if (!state.sessions[sessionId]) state.sessions[sessionId] = {};
      state.sessions[sessionId].name = alias;
    });
  } catch (e) {
    // ignore if remote or module fails
  }
}

export function removeSessionAlias(deviceId: string, projectPath: string, aliasOrSessionId: string): void {
  const cfg = readMeshConfig();
  const normalizedPath = projectPath.replace(/\\/g, "/");
  if (cfg.aliases[deviceId]?.[normalizedPath]) {
    delete cfg.aliases[deviceId][normalizedPath][aliasOrSessionId];
    // Also check if passed aliasOrSessionId was a sessionId
    for (const [k, v] of Object.entries(cfg.aliases[deviceId][normalizedPath])) {
      if (v === aliasOrSessionId) {
        delete cfg.aliases[deviceId][normalizedPath][k];
      }
    }
    writeMeshConfig(cfg);
  }
}

export function getProjectByAlias(deviceId: string, projectAlias: string): string | undefined {
  const cfg = readMeshConfig();
  return cfg.projectAliases[deviceId]?.[projectAlias];
}

export function setProjectAlias(deviceId: string, projectAlias: string, projectPath: string): void {
  const cfg = readMeshConfig();
  if (!cfg.projectAliases[deviceId]) cfg.projectAliases[deviceId] = {};
  cfg.projectAliases[deviceId][projectAlias] = projectPath.replace(/\\/g, "/");
  writeMeshConfig(cfg);
}
