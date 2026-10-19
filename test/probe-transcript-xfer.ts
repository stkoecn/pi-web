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
      stream.on("close", () => {
        const buf = Buffer.concat(chunks);
        resolve({ ms: Date.now() - t0, bytes: buf.length, text: buf.toString("utf8") });
      });
      stream.stderr.on("data", (d: Buffer) => chunks.push(Buffer.from("\nSTDERR:" + d.toString())));
    });
  });
}

const q = `'${FILE.replace(/'/g, `'\''`)}'`;
const c = await connect();
const warm = await exec(c, "printf hi");
console.log("warm:", warm.bytes, JSON.stringify(warm.text));
console.log("cmd:", `base64 ${q}`.slice(0, 120));
const raw = await exec(c, `base64 ${q}`);
const gz = await exec(c, `gzip -c ${q} | base64`);
const b64 = gz.text.replace(/\s+/g, "");
console.log(`gz wire ${gz.bytes} bytes, b64 chars ${b64.length}, raw wire ${raw.bytes}`);
const gzBytes = Buffer.from(b64, "base64");
console.log(`decoded ${gzBytes.length} bytes; tail ${JSON.stringify(gzBytes.subarray(-16).toString("latin1"))}`);
const inflated = gunzipSync(gzBytes).toString("utf8");
const rawText = Buffer.from(raw.text.replace(/\s+/g, ""), "base64").toString("utf8");
console.log(`plain base64 : ${raw.ms}ms  ${(raw.bytes/1024).toFixed(0)} KiB on wire`);
console.log(`gzip+base64  : ${gz.ms}ms  ${(gz.bytes/1024).toFixed(0)} KiB on wire  (${(raw.bytes/gz.bytes).toFixed(1)}x smaller)`);
console.log(`identical    : ${inflated === rawText}  (${rawText.length} chars)`);
c.end();
