import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";
import { gunzipSync } from "node:zlib";

const HOST = process.env.PROBE_HOST ?? "192.168.1.7";
const PORT = Number(process.env.PROBE_PORT ?? 22);
const USER = process.env.PROBE_USER ?? "windsing";
const KEY = readFileSync(join(homedir(), ".ssh", "wshome"));
const FILE = process.env.PROBE_FILE!;

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host: HOST, port: PORT, username: USER, privateKey: KEY, readyTimeout: 30000 } as never);
  });
}
function exec(c: Client, cmd: string): Promise<{ ms: number; bytes: number; text: string }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const chunks: Buffer[] = [];
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      stream.on("data", (d: Buffer) => chunks.push(d));
      stream.on("close", () => { const b = Buffer.concat(chunks); resolve({ ms: Date.now() - t0, bytes: b.length, text: b.toString("utf8") }); });
      stream.stderr.resume();
    });
  });
}
const q = `'${FILE.replace(/'/g, `'\''`)}'`;
const c = await connect();
await exec(c, "printf hi");
for (let i = 0; i < 3; i++) {
  const plain = await exec(c, `base64 ${q}`);
  const gz = await exec(c, `gzip -c ${q} | base64`);
  const inflated = gunzipSync(Buffer.from(gz.text.replace(/\s+/g, ""), "base64")).toString("utf8");
  console.log(`plain ${plain.ms}ms/${(plain.bytes/1024).toFixed(0)}KiB   gzip ${gz.ms}ms/${(gz.bytes/1024).toFixed(0)}KiB   match ${inflated === Buffer.from(plain.text.replace(/\s+/g,""),"base64").toString("utf8")}`);
}
c.end();
