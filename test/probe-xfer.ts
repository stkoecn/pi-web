import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";

const HOST = process.env.PROBE_HOST ?? "155.103.66.113";
const PORT = Number(process.env.PROBE_PORT ?? 35683);
const USER = process.env.PROBE_USER ?? "root";
const KEY = readFileSync(join(homedir(), ".ssh", "wshome"));
const DIR = process.env.PROBE_FILE ?? "/root/.pi/agent/sessions/--root--";

function connect(extra: Record<string, unknown>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host: HOST, port: PORT, username: USER, privateKey: KEY, readyTimeout: 30000, ...extra } as never);
  });
}

function execBytes(c: Client, cmd: string): Promise<{ ms: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let bytes = 0;
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      stream.on("data", (d: Buffer) => { bytes += d.length; });
      stream.on("close", () => resolve({ ms: Date.now() - t0, bytes }));
      stream.stderr.resume();
    });
  });
}

// Same payload, two encodings: raw tar stream vs gzip'd tar stream.
const BIGFILE = process.env.PROBE_BIGFILE ?? "/tmp/piweb-big.txt";
const RAW = `cat ${BIGFILE}`;
const GZ = `gzip -c ${BIGFILE}`;

async function bench(label: string, extra: Record<string, unknown>) {
  const c = await connect(extra);
  const raw = await execBytes(c, RAW);
  const gz = await execBytes(c, GZ);
  console.log(`${label}: raw ${raw.ms}ms/${(raw.bytes/1024/1024).toFixed(2)}MiB   gzip ${gz.ms}ms/${(gz.bytes/1024/1024).toFixed(2)}MiB`);
  c.end();
}

await bench("plain   ", {});
await bench("compress", { compress: true });
