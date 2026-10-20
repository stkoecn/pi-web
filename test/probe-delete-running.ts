// Probe: delete a remote session while its turn is still streaming. This is the
// case a user hits after sending a prompt, and the one the idle probes miss.
const BASE = "http://127.0.0.1:9564";
const DEVICE = process.argv[2] || "fuckip-us";

const t0 = Date.now();
const log = (label, value) => console.log(`${((Date.now() - t0) / 1000).toFixed(2)}s ${label}`, value ?? "");

const created = await (await fetch(`${BASE}/api/agent/new?deviceId=${DEVICE}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-device-id": DEVICE },
  body: JSON.stringify({ cwd: "/root", type: "ensure_session" }),
})).json();
const sessionId = created.sessionId;
log("created", sessionId);

// Start a turn that takes a while, then delete mid-flight.
await fetch(`${BASE}/api/agent/${sessionId}?deviceId=${DEVICE}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "prompt", message: "count slowly from 1 to 40, one number per line" }),
});
log("prompt sent");

await new Promise((r) => setTimeout(r, 4000));

const status = await (await fetch(`${BASE}/api/agent/running?deviceId=${DEVICE}`)).json();
log("running", status.runningSessionIds);

const del = await fetch(`${BASE}/api/sessions/${sessionId}?deviceId=${DEVICE}`, { method: "DELETE" });
log("DELETE", `${del.status} ${await del.text()}`);

// Does anything still hang after the delete?
const after = await (await fetch(`${BASE}/api/agent/running?deviceId=${DEVICE}`)).json();
log("running after", after.runningSessionIds);

const state = await fetch(`${BASE}/api/sessions/${sessionId}/state?deviceId=${DEVICE}`);
log("state after", state.status);

const detail = await fetch(`${BASE}/api/sessions/${sessionId}?deviceId=${DEVICE}&deferThinking=1&deferMedia=1&tree=summary`);
log("detail after", detail.status);

const listStart = Date.now();
const list = await (await fetch(`${BASE}/api/sessions?deviceId=${DEVICE}&force=1`)).json();
log(`list after (${Date.now() - listStart}ms)`, list.sessions?.length);
