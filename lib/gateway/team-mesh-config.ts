import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

/**
 * 1. Global descriptions: stored in ~/.pi/agent/team-mesh.json on the gateway machine.
 *    - projectDescriptions: deviceId -> normalizedProjectPath -> description
 *    - sessionDescriptions: deviceId -> sessionId -> description
 */
export interface GlobalMeshDescriptions {
  version: 1;
  projectDescriptions: Record<string, Record<string, string>>; // deviceId -> projectPath -> description
  sessionDescriptions: Record<string, Record<string, string>>; // deviceId -> sessionId -> description
}

let cachedGlobal: GlobalMeshDescriptions | null = null;

function getGlobalConfigPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, ".pi", "agent", "team-mesh.json");
}

export function readGlobalMeshDescriptions(): GlobalMeshDescriptions {
  if (cachedGlobal) return cachedGlobal;
  const filePath = getGlobalConfigPath();
  if (!existsSync(filePath)) {
    cachedGlobal = {
      version: 1,
      projectDescriptions: {},
      sessionDescriptions: {},
    };
    return cachedGlobal;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    cachedGlobal = JSON.parse(raw);
    if (!cachedGlobal?.projectDescriptions) cachedGlobal!.projectDescriptions = {};
    if (!cachedGlobal?.sessionDescriptions) cachedGlobal!.sessionDescriptions = {};
    return cachedGlobal!;
  } catch (e) {
    console.error("[team-mesh] Failed to read global descriptions:", e);
    cachedGlobal = { version: 1, projectDescriptions: {}, sessionDescriptions: {} };
    return cachedGlobal;
  }
}

export function writeGlobalMeshDescriptions(config: GlobalMeshDescriptions): void {
  cachedGlobal = config;
  const filePath = getGlobalConfigPath();
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    console.error("[team-mesh] Failed to write global descriptions:", e);
  }
}

export function getProjectDescription(deviceId: string, projectPath: string): string {
  const g = readGlobalMeshDescriptions();
  const norm = projectPath.replace(/\\/g, "/");
  return g.projectDescriptions[deviceId]?.[norm] || "";
}

export function setProjectDescription(deviceId: string, projectPath: string, description: string): void {
  const g = readGlobalMeshDescriptions();
  const norm = projectPath.replace(/\\/g, "/");
  if (!g.projectDescriptions[deviceId]) g.projectDescriptions[deviceId] = {};
  if (!description.trim()) {
    delete g.projectDescriptions[deviceId][norm];
  } else {
    g.projectDescriptions[deviceId][norm] = description.trim();
  }
  writeGlobalMeshDescriptions(g);
}

export function getSessionDescription(deviceId: string, sessionId: string): string {
  const g = readGlobalMeshDescriptions();
  return g.sessionDescriptions[deviceId]?.[sessionId] || "";
}

export function setSessionDescription(deviceId: string, sessionId: string, description: string): void {
  const g = readGlobalMeshDescriptions();
  if (!g.sessionDescriptions[deviceId]) g.sessionDescriptions[deviceId] = {};
  if (!description.trim()) {
    delete g.sessionDescriptions[deviceId][sessionId];
  } else {
    g.sessionDescriptions[deviceId][sessionId] = description.trim();
  }
  writeGlobalMeshDescriptions(g);
}

/**
 * 2. Per-project enabled contacts: stored in <projectCwd>/.pi/team-mesh.json
 *    - enabledProjects: array of target project keys: "deviceId:normalizedProjectPath"
 *    - default: empty array (all disabled by default)
 */
export interface ProjectTeamConfig {
  version: 1;
  enabledProjects: string[]; // e.g. ["localhost:/path/to/repo", "wsnas:/var/data"]
}

export function makeProjectKey(deviceId: string, projectPath: string): string {
  return `${deviceId}:${projectPath.replace(/\\/g, "/")}`;
}

export function parseProjectKey(key: string): { deviceId: string; projectPath: string } {
  const colonIdx = key.indexOf(":");
  if (colonIdx === -1) return { deviceId: "localhost", projectPath: key };
  return {
    deviceId: key.slice(0, colonIdx),
    projectPath: key.slice(colonIdx + 1),
  };
}

export function getProjectTeamConfigPath(projectCwd: string): string {
  return join(projectCwd, ".pi", "team-mesh.json");
}

export function readProjectTeamConfig(projectCwd: string): ProjectTeamConfig {
  if (!projectCwd) return { version: 1, enabledProjects: [] };
  const filePath = getProjectTeamConfigPath(projectCwd);
  if (!existsSync(filePath)) {
    return { version: 1, enabledProjects: [] };
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      version: 1,
      enabledProjects: Array.isArray(data.enabledProjects) ? data.enabledProjects : [],
    };
  } catch (e) {
    return { version: 1, enabledProjects: [] };
  }
}

export function writeProjectTeamConfig(projectCwd: string, config: ProjectTeamConfig): void {
  if (!projectCwd) return;
  const filePath = getProjectTeamConfigPath(projectCwd);
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    console.error("[team-mesh] Failed to write project team config:", e);
  }
}

export function isProjectEnabledForContacts(currentProjectCwd: string, targetDeviceId: string, targetProjectPath: string): boolean {
  if (!currentProjectCwd) return false;
  const cfg = readProjectTeamConfig(currentProjectCwd);
  const targetKey = makeProjectKey(targetDeviceId, targetProjectPath);
  const normTarget = targetKey.toLowerCase();
  return cfg.enabledProjects.some((k) => k.toLowerCase() === normTarget);
}

export function toggleProjectEnabledForContacts(currentProjectCwd: string, targetDeviceId: string, targetProjectPath: string, enabled: boolean): void {
  const cfg = readProjectTeamConfig(currentProjectCwd);
  const targetKey = makeProjectKey(targetDeviceId, targetProjectPath);
  const normTarget = targetKey.toLowerCase();
  const filtered = cfg.enabledProjects.filter((k) => k.toLowerCase() !== normTarget);
  if (enabled) {
    filtered.push(targetKey);
  }
  cfg.enabledProjects = filtered;
  writeProjectTeamConfig(currentProjectCwd, cfg);
}

/**
 * Loads project team config, supporting both local filesystem and remote SSH devices.
 */
export async function loadProjectTeamConfig(
  deviceId: string,
  projectCwd: string,
): Promise<ProjectTeamConfig> {
  if (!projectCwd) return { version: 1, enabledProjects: [] };
  const { isLocalHostId } = await import("./host-identity");
  if (isLocalHostId(deviceId)) {
    return readProjectTeamConfig(projectCwd);
  }

  // Remote SSH host read
  try {
    const { getGateway } = await import("./singleton");
    const driver = await getGateway().getOrConnectDriver(deviceId);
    const normCwd = projectCwd.split("\\").join("/");
    const configPath = `${normCwd}/.pi/team-mesh.json`;
    const readScript = `node -e \"const fs=require(\\\"fs\\\"); try { console.log(Buffer.from(fs.readFileSync(\\\"${configPath}\\\")).toString(\\\"base64\\\")); } catch {}\"`;
    const res = await driver.exec(readScript, [], { timeoutMs: 15_000 });
    if (res.exitCode === 0 && res.stdout.trim()) {
      const raw = Buffer.from(res.stdout.trim(), "base64").toString("utf8");
      const data = JSON.parse(raw);
      return {
        version: 1,
        enabledProjects: Array.isArray(data.enabledProjects) ? data.enabledProjects : [],
      };
    }
  } catch (err) {
    console.error(`[team-mesh] Failed to read remote project config on ${deviceId}:`, err);
  }
  return { version: 1, enabledProjects: [] };
}

/**
 * Saves project team config, supporting both local filesystem and remote SSH devices.
 */
export async function saveProjectTeamConfig(
  deviceId: string,
  projectCwd: string,
  config: ProjectTeamConfig,
): Promise<void> {
  if (!projectCwd) return;
  const { isLocalHostId } = await import("./host-identity");
  if (isLocalHostId(deviceId)) {
    writeProjectTeamConfig(projectCwd, config);
    return;
  }

  // Remote SSH host write
  try {
    const { getGateway } = await import("./singleton");
    const driver = await getGateway().getOrConnectDriver(deviceId);
    const normCwd = projectCwd.split("\\").join("/");
    const configPath = `${normCwd}/.pi/team-mesh.json`;
    const b64 = Buffer.from(JSON.stringify(config, null, 2), "utf8").toString("base64");
    const writeScript = `node -e \"const fs=require(\\\"fs\\\"), path=require(\\\"path\\\"); const p = \\\"${configPath}\\\"; try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(\\\"${b64}\\\", \\\"base64\\\")); } catch (e) { process.exit(1); }\"`;
    await driver.exec(writeScript, [], { timeoutMs: 15_000 });
  } catch (err) {
    console.error(`[team-mesh] Failed to write remote project config on ${deviceId}:`, err);
  }
}

/**
 * Toggles a project's enabled status in the specified device's project team config.
 */
export async function toggleProjectEnabledAsync(
  currentDeviceId: string,
  currentProjectCwd: string,
  targetDeviceId: string,
  targetProjectPath: string,
  enabled: boolean,
): Promise<void> {
  const cfg = await loadProjectTeamConfig(currentDeviceId, currentProjectCwd);
  const targetKey = makeProjectKey(targetDeviceId, targetProjectPath);
  const normTarget = targetKey.toLowerCase();
  const filtered = cfg.enabledProjects.filter((k) => k.toLowerCase() !== normTarget);
  if (enabled) {
    filtered.push(targetKey);
  }
  cfg.enabledProjects = filtered;
  await saveProjectTeamConfig(currentDeviceId, currentProjectCwd, cfg);
}
