import type { IHostDriver } from "@/lib/gateway/types/host-driver";

export interface NodeScannedSession {
  path: string;
  sessionId: string;
  parentSession?: string;
  subagentParentPath?: string;
}

export async function scanSessionsWithNode(
  driver: IHostDriver,
  sessionsDir: string,
): Promise<NodeScannedSession[] | null> {
  const normRoot = sessionsDir.replace(/\\/g, "/");
  const nodeScript = `
const fs = require('fs');
const path = require('path');
const os = require('os');
let root = ${JSON.stringify(normRoot)};
if (root.startsWith('~')) {
  root = path.join(os.homedir(), root.slice(1));
}
if (!fs.existsSync(root)) {
  console.log('[]');
  process.exit(0);
}
function walk(dir) {
  let list = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) list.push(...walk(full));
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) list.push(full);
    }
  } catch {}
  return list;
}
const files = walk(root);
const out = [];
for (const p of files) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4096);
    const readBytes = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, readBytes).toString('utf8');
    const lines = chunk.split(/\\r?\\n/);
    let head = null;
    let sub = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'session' && !head) head = obj;
        if (obj.customType === 'pi-web:subagent' && obj.data?.parentSessionPath && !sub) {
          sub = obj.data.parentSessionPath;
        }
      } catch {}
    }
    const norm = p.replace(/\\\\/g, '/');
    const base = path.basename(norm);
    const id = head?.id || base.replace(/\\.jsonl$/, '').split('_').pop() || '';
    out.push({
      path: norm,
      sessionId: id,
      parentSession: head?.parentSession,
      subagentParentPath: sub
    });
  } catch {}
}
console.log(JSON.stringify(out));
`;

  try {
    const b64 = Buffer.from(nodeScript, "utf8").toString("base64");
    const cmd = `node -e "eval(Buffer.from('${b64}','base64').toString('utf8'))" 2>/dev/null`;
    const res = await driver.exec(cmd, [], { timeoutMs: 15_000 });
    if (res.exitCode === 0 && res.stdout.trim().startsWith("[")) {
      return JSON.parse(res.stdout.trim()) as NodeScannedSession[];
    }
  } catch {
    // Fall back to POSIX find
  }
  return null;
}

export async function unlinkRemoteFilesWithNode(
  driver: IHostDriver,
  files: string[],
): Promise<boolean> {
  if (files.length === 0) return true;
  const b64 = Buffer.from(JSON.stringify(files), "utf8").toString("base64");
  const script = `
const fs = require('fs');
const files = JSON.parse(Buffer.from('${b64}', 'base64').toString('utf8'));
for (const f of files) {
  try { fs.unlinkSync(f); } catch {}
}
`;
  try {
    const cmdB64 = Buffer.from(script, "utf8").toString("base64");
    const cmd = `node -e "eval(Buffer.from('${cmdB64}','base64').toString('utf8'))" 2>/dev/null`;
    const res = await driver.exec(cmd, [], { timeoutMs: 30_000 });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}
