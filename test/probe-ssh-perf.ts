import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";

const HOST = process.env.PROBE_HOST ?? "155.103.66.113";
const PORT = Number(process.env.PROBE_PORT ?? 35683);
const USER = process.env.PROBE_USER ?? "root";
const KEY = readFileSync(join(homedir(), ".ssh", "wshome"));
const FILE = process.env.PROBE_FILE ?? "/root/.pi/agent/sessions/--root--";

function connect(extra: Record<string, unknown>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    const t0 = Date.now();
    c.on("ready", () => { console.log(`  handshake ${Date.now() - t0}ms`); resolve(c); });
    c.on("error", reject);
    c.connect({ host: HOST, port: PORT, username: USER, privateKey: KEY, readyTimeout: 30000, ...extra } as never);
  });
}

function execOnce(c: Client, cmd: string): Promise<{ ms: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let bytes = 0;
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      stream.on("data", (d: Buffer) => { bytes += d.length; });
      stream.on("close", () => resolve({ ms: Date.now() - t0, bytes }));
      stream.stderr.on("data", () => {});
    });
  });
}

// One script that dumps every transcript in the directory, base64'd: the shape
// a session-list + first-open actually needs.
const BULK = `for f in ${FILE}/*.jsonl; do printf '@@%s\n' "$f"; base64 "$f"; done`;

async function bench(label: string, extra: Record<string, unknown>) {
  const c = await connect(extra);
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 3; i++) {
    const r = await execOnce(c, BULK);
    times.push(r.ms);
    bytes = r.bytes;
  }
  console.log(`${label}: ${times.join(" / ")} ms  payload=${(bytes / 1024).toFixed(1)} KiB`);
  c.end();
}

const which = process.argv[2] ?? "both";
if (which === "both" || which === "plain") await bench("plain       ", {});
if (which === "both" || which === "compress") await bench("compress    ", { compress: true });
if (which === "both" || which === "fast-cipher") await bench("aes128-gcm  ", { algorithms: { cipher: ["aes128-gcm@openssh.com", "aes256-gcm@openssh.com"] } });
if (which === "both" || which === "both-opts") await bench("gcm+compress", { compress: true, algorithms: { cipher: ["aes128-gcm@openssh.com"] } });
