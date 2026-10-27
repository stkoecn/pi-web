import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import type { SkillInfo, SkillInstallInfo, SkillInstallScope } from "@/lib/api-types";

export interface SkillLockEntry {
  source?: unknown;
  sourceType?: unknown;
  skillPath?: unknown;
  ref?: unknown;
  skillFolderHash?: unknown;
  computedHash?: unknown;
}

interface SkillLockFile {
  skills?: Record<string, SkillLockEntry>;
}

interface GlobalLockPathOptions {
  homeDir?: string;
  xdgStateHome?: string;
}

interface AnnotateSkillOptions {
  cwd: string;
  agentDir: string;
  homeDir?: string;
  globalLockPath?: string;
  projectLockPath?: string;
}

export function getGlobalSkillsLockPath({
  homeDir = homedir(),
  xdgStateHome = process.env.XDG_STATE_HOME,
}: GlobalLockPathOptions = {}): string {
  return xdgStateHome
    ? join(xdgStateHome, "skills", ".skill-lock.json")
    : join(homeDir, ".agents", ".skill-lock.json");
}

/** One lock file's `skills` map; unreadable or malformed contents read as empty. */
export function parseSkillLock(text: string | null | undefined): Record<string, SkillLockEntry> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as SkillLockFile;
    return parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {};
  } catch {
    return {};
  }
}

function readSkillLock(path: string): Record<string, SkillLockEntry> {
  try {
    return parseSkillLock(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function findLockEntry(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
): SkillLockEntry | undefined {
  if (entries[skillName]) return entries[skillName];
  const normalizedName = skillName.toLowerCase();
  const key = Object.keys(entries).find((name) => name.toLowerCase() === normalizedName);
  return key ? entries[key] : undefined;
}

function normalizeSource(source: string, sourceType?: string): string {
  if (sourceType !== "github") return source.replace(/\/$/, "");
  return source
    .replace(/^git\+/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function buildSkillsShUrl(source: string, skillName: string): string | undefined {
  if (!source || source.includes("://") || source.startsWith("git@")) return undefined;
  const sourcePath = source
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  if (!sourcePath) return undefined;
  return `https://skills.sh/${sourcePath}/${encodeURIComponent(skillName)}`;
}

function getInstallInfo(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
  scope: SkillInstallScope,
): SkillInstallInfo | undefined {
  const entry = findLockEntry(entries, skillName);
  if (!entry || typeof entry.source !== "string" || !entry.source.trim()) return undefined;

  const sourceType = typeof entry.sourceType === "string" ? entry.sourceType : undefined;
  const source = normalizeSource(entry.source.trim(), sourceType);
  if (!source) return undefined;
  const skillPath = typeof entry.skillPath === "string" ? entry.skillPath : undefined;
  const ref = typeof entry.ref === "string" ? entry.ref : undefined;
  const rawVersionHash = scope === "global" ? entry.skillFolderHash : entry.computedHash;
  const versionHash = typeof rawVersionHash === "string" && rawVersionHash
    ? rawVersionHash
    : undefined;
  const isGitHubSource =
    sourceType === "github" && /^[\w.-]+\/[\w.-]+$/.test(source);
  const hasComparableVersion = scope === "global" || !ref;

  return {
    package: `${source}@${skillName}`,
    scope,
    source,
    sourceType,
    skillsShUrl: sourceType === "local" ? undefined : buildSkillsShUrl(source, skillName),
    ...(skillPath && { skillPath }),
    ...(ref && { ref }),
    ...(versionHash && { versionHash }),
    canCheckForUpdates: Boolean(
      isGitHubSource && skillPath && versionHash && hasComparableVersion,
    ),
  };
}

export function annotateSkillsWithInstallInfo(
  skills: SkillInfo[],
  {
    cwd,
    agentDir,
    homeDir = homedir(),
    globalLockPath = getGlobalSkillsLockPath({ homeDir }),
    projectLockPath = join(cwd, "skills-lock.json"),
  }: AnnotateSkillOptions,
): SkillInfo[] {
  return annotateSkillsWithLockEntries(skills, {
    cwd,
    agentDir,
    homeDir,
    globalEntries: readSkillLock(globalLockPath),
    projectEntries: readSkillLock(projectLockPath),
  });
}

/**
 * The same annotation from lock entries the caller already read.
 *
 * Split out because a remote device's lock files are read over the gateway
 * (lib/remote-skill-writes.ts): the rules for which lock entry describes which
 * skill must not exist twice, or a skill installed on the device would be
 * reported as installed locally.
 *
 * `requireExistingFile: false` skips the per-skill `existsSync`, which a caller
 * listing a device has already answered by reading the files: a device path is
 * not on this machine's filesystem, so checking here would report every one as
 * absent.
 */
export function annotateSkillsWithLockEntries(
  skills: SkillInfo[],
  {
    cwd,
    agentDir,
    homeDir,
    globalEntries,
    projectEntries,
    requireExistingFile = true,
  }: {
    cwd: string;
    agentDir: string;
    homeDir: string;
    globalEntries: Record<string, SkillLockEntry>;
    projectEntries: Record<string, SkillLockEntry>;
    requireExistingFile?: boolean;
  },
): SkillInfo[] {
  // The skills CLI installs for pi into its own dirs up to 1.5.x and into the
  // Agent Skills dirs (.agents/skills) since 1.7; pi loads both.
  const globalSkillsRoots = [join(agentDir, "skills"), join(homeDir, ".agents", "skills")];
  const projectSkillsRoots = [join(cwd, ".pi", "skills"), join(cwd, ".agents", "skills")];
  const isWithinAny = (path: string, roots: string[]) => roots.some((root) => isWithin(path, root));

  return skills.map((skill) => {
    if (requireExistingFile && !existsSync(skill.filePath)) return skill;

    const install = isWithinAny(skill.filePath, globalSkillsRoots)
      ? getInstallInfo(globalEntries, skill.name, "global")
      : isWithinAny(skill.filePath, projectSkillsRoots)
        ? getInstallInfo(projectEntries, skill.name, "project")
        : undefined;

    return install ? { ...skill, install } : skill;
  });
}
