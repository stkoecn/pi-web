import { Client } from "ssh2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const key = fs.readFileSync(path.join(os.homedir(), ".ssh", "wshome"));
const cfg = { host: "155.103.66.113", port: 35683, username: "root", privateKey: key };
const c = new Client();
await new Promise((res, rej) => { c.on("ready", res); c.on("error", rej); c.connect(cfg); });

// persistent shell channel: measure per-command latency through one channel
const stream = await new Promise((res, rej) => c.shell({ term: "dumb" }, (e, s) => e ? rej(e) : res(s)));
let buf = "";
stream.on("data", d => { buf += d.toString(); });
const t0 = Date.now();
stream.write("echo A$((1+1))\n");
while (!buf.includes("A2")) await new Promise(r => setTimeout(r, 5));
console.log("persistent shell first cmd ms", Date.now() - t0);
for (let i = 0; i < 4; i++) {
  const t = Date.now();
  const marker = `M${i}${Date.now()}`;
  stream.write(`echo ${marker}\n`);
  while (!buf.includes(marker)) await new Promise(r => setTimeout(r, 2));
  console.log(`shell cmd#${i} ms`, Date.now() - t);
}
// channel-open cost only
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  await new Promise((res, rej) => c.exec("true", (e, s) => { if (e) return rej(e); s.on("close", res); s.resume(); }));
  console.log(`exec true#${i} ms`, Date.now() - t);
}
c.end(); process.exit(0);
