import { getSessionAlias, getProjectByAlias } from "./mesh-config";
import { getCanonicalHostId, isLocalHostId } from "./host-identity";

export interface ParsedMeshTarget {
  raw: string;
  sessionTarget?: string; // alias or sessionId (or undefined if new session)
  projectTarget?: string; // project name, alias, or path (optional if direct sessionId.host)
  deviceTarget: string;   // deviceId ('localhost', 'wshome', 'wsnas', etc.)
  isNewSession: boolean;
}

/**
 * Parses mesh targets like:
 * - `sess123.wshome` -> session='sess123', project=undefined, host='wshome' (Direct Host Session)
 * - `sess123@wshome` -> session='sess123', project=undefined, host='wshome' (Direct Host Session)
 * - `coder@[/path/to/project].wshome` -> session='coder', project='/path/to/project', host='wshome'
 * - `@[/path/to/project].wshome` -> new session, project='/path/to/project', host='wshome'
 * - `coder@pi-web.wshome` -> session='coder', project='pi-web', host='wshome'
 * - `@pi-web.wshome` -> new session, project='pi-web', host='wshome'
 * - `coder@pi-web` -> session='coder', project='pi-web', host=currentHost
 * - `@pi-web` -> new session, project='pi-web', host=currentHost
 */
export function parseMeshTarget(target: string, currentDeviceId = getCanonicalHostId()): ParsedMeshTarget | null {
  const trimmed = target.trim();
  const defaultHost = isLocalHostId(currentDeviceId) ? getCanonicalHostId() : currentDeviceId;

  // Pattern A: No '@', but has '.' e.g. "sess123.wshome" -> direct host session
  if (!trimmed.includes("@")) {
    if (trimmed.includes(".")) {
      const dotIdx = trimmed.lastIndexOf(".");
      const sessionPart = trimmed.slice(0, dotIdx).trim();
      const hostPart = trimmed.slice(dotIdx + 1).trim() || defaultHost;
      if (sessionPart && hostPart) {
        return {
          raw: trimmed,
          sessionTarget: sessionPart,
          projectTarget: undefined,
          deviceTarget: isLocalHostId(hostPart) ? getCanonicalHostId() : hostPart,
          isNewSession: false,
        };
      }
    }
    return null;
  }

  // Pattern B: Has '@'
  const atIdx = trimmed.indexOf("@");
  const sessionPart = trimmed.slice(0, atIdx).trim(); // might be empty
  const rightPart = trimmed.slice(atIdx + 1).trim();

  if (!rightPart) return null;

  let projectTarget = "";
  let deviceTarget = defaultHost;

  // Check if rightPart uses bracket notation: `[projectPath].host` or `[projectPath]`
  if (rightPart.startsWith("[")) {
    const closeBracketIdx = rightPart.indexOf("]");
    if (closeBracketIdx !== -1) {
      projectTarget = rightPart.slice(1, closeBracketIdx).trim();
      const afterBracket = rightPart.slice(closeBracketIdx + 1).trim();
      if (afterBracket.startsWith(".")) {
        deviceTarget = afterBracket.slice(1).trim() || defaultHost;
      } else {
        deviceTarget = defaultHost;
      }
    } else {
      projectTarget = rightPart;
    }
  } else if (rightPart.includes(".")) {
    const dotIdx = rightPart.lastIndexOf(".");
    projectTarget = rightPart.slice(0, dotIdx).trim();
    deviceTarget = rightPart.slice(dotIdx + 1).trim() || defaultHost;
  } else {
    // e.g. "sess@wshome" where rightPart has no dot, but sessionPart is set.
    projectTarget = rightPart;
  }

  return {
    raw: trimmed,
    sessionTarget: sessionPart || undefined,
    projectTarget: projectTarget || undefined,
    deviceTarget: isLocalHostId(deviceTarget) ? getCanonicalHostId() : deviceTarget,
    isNewSession: !sessionPart,
  };
}

/**
 * Resolves projectTarget to an absolute folder path on target device.
 */
export function resolveProjectPath(deviceId: string, projectTarget: string, knownProjects: string[] = []): string {
  // 1. Check project alias in mesh-config
  const aliased = getProjectByAlias(deviceId, projectTarget);
  if (aliased) return aliased;

  const targetNorm = projectTarget.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

  // 2. Exact match on full normalized path
  const exactMatch = knownProjects.find((p) => {
    const norm = p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return norm === targetNorm;
  });
  if (exactMatch) return exactMatch;

  // 3. Suffix match on slash boundary (e.g. "repoA/pi-web" or "pi-web")
  // Prefer the longest matching suffix if multiple match
  const matches = knownProjects.filter((p) => {
    const norm = p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return norm.endsWith("/" + targetNorm);
  });

  if (matches.length === 1) {
    return matches[0];
  } else if (matches.length > 1) {
    // If ambiguous, pick the one where targetNorm exactly equals the basename or shortest relative disambiguation
    const exactBasename = matches.find((p) => {
      const norm = p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
      return norm.split("/").pop() === targetNorm;
    });
    return exactBasename || matches[0];
  }

  // 4. Fallback: if projectTarget looks like an absolute path, keep it
  return projectTarget;
}
