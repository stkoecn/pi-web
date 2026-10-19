import { Client } from "ssh2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const key = fs.readFileSync(path.join(os.homedir(), ".ssh", "wshome"));
const c = new Client();
await new Promise((res, rej) => {
  c.on("ready", res);
  c.on("error", rej);
  c.connect({ host: "155.103.66.113", port: 35683, username: "root", privateKey: key });
});

const s = await new Promise((res, rej) => c.exec("sh", (e, st) => (e ? rej(e) : res(st))));
let buf = "";
s.on("data", (d) => { buf += d.toString(); });

const ESC = String.fromCharCode(1);
let seq = 0;

async function run(cmd) {
  const id = `s${seq++}`;
  const E = `${ESC}E${id}${ESC}`;
  const X = `${ESC}X${id}${ESC}`;
  const errFile = `/tmp/piweb-${id}.err`;
  const t = Date.now();
  s.write(`( ${cmd} ) 2>${errFile}; __rc=$?; printf '${E}%s${ESC}' "$__rc"; cat ${errFile}; rm -f ${errFile}; printf '${X}'\n`);
  while (!buf.includes(X)) await new Promise((r) => setTimeout(r, 2));
  const eIdx = buf.indexOf(E);
  const xIdx = buf.indexOf(X);
  const out = buf.slice(0, eIdx);
  const mid = buf.slice(eIdx + E.length, xIdx);
  const nl = mid.indexOf("\n");
  const rc = nl === -1 ? mid : mid.slice(0, nl);
  const err = nl === -1 ? "" : mid.slice(nl + 1);
  buf = buf.slice(xIdx + X.length);
  return { out, err, rc, ms: Date.now() - t };
}

for (let i = 0; i < 5; i++) {
  const r = await run("echo hi");
  console.log(i, r.ms, JSON.stringify(r.out), r.rc);
}
const e1 = await run("echo out; echo bad >&2; exit 3");
console.log("stderr", e1.ms, JSON.stringify(e1.out), JSON.stringify(e1.err), e1.rc);
const m1 = await run("printf 'a\\nb\\nc\\n'");
console.log("multiline", m1.ms, JSON.stringify(m1.out));
const j1 = await run("cd /root/.pi/agent/sessions && find . -name '*.jsonl' -type f -printf '%p\\t%s\\n' 2>/dev/null | head -n 200");
console.log("find", j1.ms, JSON.stringify(j1.out));
c.end();
process.exit(0);
