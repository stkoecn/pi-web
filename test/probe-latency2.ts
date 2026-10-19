const { getGateway } = await import("../lib/gateway/singleton");
const g = getGateway();
let t = Date.now();
const d = await g.getOrConnectDriver("fuckip-us");
console.log("connect", Date.now() - t, "ms");
for (let i = 0; i < 3; i++) {
  t = Date.now(); await d.exec("echo hi"); console.log("exec", Date.now() - t, "ms");
}
const p = "/root/.pi/agent/sessions/--root--/2026-10-19T11-59-26-855Z_01a15407-e87f-7241-9fd3-8d86f6c9e3e8.jsonl";
for (let i = 0; i < 3; i++) {
  t = Date.now(); const b = await d.readFile(p); console.log("sftp-read", Date.now() - t, "ms", b.length);
}
t = Date.now(); const r = await d.exec("base64 -w0 " + p); console.log("exec-base64", Date.now() - t, "ms", r.stdout.length);
process.exit(0);
