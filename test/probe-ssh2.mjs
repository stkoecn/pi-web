import { Client } from "ssh2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const key = fs.readFileSync(path.join(os.homedir(), ".ssh", "wshome"));
const cfg = { host: "155.103.66.113", port: 35683, username: "root", privateKey: key, keepaliveInterval: 10000, keepaliveCountMax: 3 };

async function conn() {
  const t = Date.now();
  const c = new Client();
  await new Promise((res, rej) => { c.on("ready", res); c.on("error", rej); c.connect(cfg); });
  const ms = Date.now() - t;
  return { c, ms };
}

const { c, ms } = await conn();
console.log("handshake ms", ms);

function exec(c, cmd) {
  return new Promise((res) => {
    const t = Date.now();
    c.exec(cmd, (err, stream) => {
      if (err) return res({ err: String(err), ms: Date.now() - t });
      let out = "";
      stream.on("data", d => out += d);
      stream.on("close", () => res({ out: out.trim(), ms: Date.now() - t }));
    });
  });
}

for (let i = 0; i < 4; i++) console.log("exec", await exec(c, "echo hi"));
// many parallel channels
const t = Date.now();
const par = await Promise.all(Array.from({length: 10}, (_, i) => exec(c, `echo ${i}`)));
console.log("10 parallel channels ms", Date.now() - t, par.map(p => p.ms).join(","));

// sftp timing
const sftp = await new Promise((res, rej) => c.sftp((e, s) => e ? rej(e) : res(s)));
for (let i = 0; i < 3; i++) {
  const t2 = Date.now();
  const list = await new Promise((res, rej) => sftp.readdir("/root/.pi/agent/sessions", (e, l) => e ? rej(e) : res(l)));
  console.log("readdir ms", Date.now() - t2, list.length);
}
const t3 = Date.now();
const f = await new Promise((res, rej) => sftp.readFile("/root/.pi/agent/sessions/--root--/2026-10-15T16-17-04-599Z_01a1405a-564b-767e-8f15-ac65e7a65cf8.jsonl", (e, d) => e ? rej(e) : res(d)));
console.log("readFile ms", Date.now() - t3, f.length);
c.end();
process.exit(0);
