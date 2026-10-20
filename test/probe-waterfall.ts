// The real cost of opening a remote device: every API call the UI makes, in order.
const BASE = "http://127.0.0.1:9564";
const dev = process.argv[2] ?? "fuckip-us";
const cwd = dev === "wsmac" ? "/Users/windsing" : "/root";

async function timed(label: string, url: string, init?: RequestInit) {
  const s = Date.now();
  const res = await fetch(url, init);
  const body = await res.text();
  console.log(`${String(Date.now() - s).padStart(6)}ms ${res.status} ${label}  (${body.length}b)`);
  return body;
}

console.log("--- device switch / page open ---");
await Promise.all([
  timed("devices", `${BASE}/api/devices`),
  timed("sessions", `${BASE}/api/sessions?deviceId=${dev}`),
  timed("home", `${BASE}/api/home?deviceId=${dev}`),
  timed("ui-state", `${BASE}/api/sessions/ui-state?deviceId=${dev}`),
  timed("models", `${BASE}/api/models?deviceId=${dev}&cwd=${encodeURIComponent(cwd)}`),
  timed("project-trust", `${BASE}/api/project-trust?cwd=${encodeURIComponent(cwd)}&deviceId=${dev}`),
  timed("files", `${BASE}/api/files${cwd}?type=list&deviceId=${dev}`),
  timed("running", `${BASE}/api/agent/running?deviceId=${dev}`),
  timed("git/status", `${BASE}/api/git/status?cwd=${encodeURIComponent(cwd)}&deviceId=${dev}`),
  timed("mcp", `${BASE}/api/mcp?cwd=${encodeURIComponent(cwd)}&deviceId=${dev}`),
  timed("skills", `${BASE}/api/skills?cwd=${encodeURIComponent(cwd)}&deviceId=${dev}`),
]);

console.log("--- open a session ---");
const list = JSON.parse(await (await fetch(`${BASE}/api/sessions?deviceId=${dev}`)).text());
const sid = list.sessions[0].id;
await Promise.all([
  timed("session detail", `${BASE}/api/sessions/${sid}?deviceId=${dev}&deferThinking=1&deferMedia=1&tree=summary`),
  timed("session state", `${BASE}/api/sessions/${sid}/state?deviceId=${dev}`),
  timed("agent status", `${BASE}/api/agent/${sid}?systemPrompt=0&deviceId=${dev}`),
]);
console.log("--- same, second time (caches warm) ---");
await Promise.all([
  timed("session detail", `${BASE}/api/sessions/${sid}?deviceId=${dev}&deferThinking=1&deferMedia=1&tree=summary`),
  timed("session state", `${BASE}/api/sessions/${sid}/state?deviceId=${dev}`),
]);
