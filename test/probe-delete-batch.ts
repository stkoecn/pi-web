// Probe: the sidebar's "delete all sessions in this project" path (POST
// /api/sessions/delete) on a remote device, which is the bulk flow.
const BASE = "http://127.0.0.1:9564";
const DEVICE = process.argv[2] || "fuckip-us";

const t0 = Date.now();
const log = (label, value) => console.log(`${((Date.now() - t0) / 1000).toFixed(2)}s ${label}`, value ?? "");

const list = await (await fetch(`${BASE}/api/sessions?deviceId=${DEVICE}&force=1`)).json();
const ids = (list.sessions ?? []).map((s) => s.id);
log("sessions", ids.length);

// One id at a time is what the family delete does; the batch route takes many.
const single = await fetch(`${BASE}/api/sessions/delete?deviceId=${DEVICE}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ids: ids.slice(0, 1) }),
});
log("batch of 1", `${single.status} ${await single.text()}`);

const empty = await fetch(`${BASE}/api/sessions/delete?deviceId=${DEVICE}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ids: [] }),
});
log("batch of 0", `${empty.status} ${await empty.text()}`);

const unknown = await fetch(`${BASE}/api/sessions/delete?deviceId=${DEVICE}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ids: ["01a10000-0000-7000-8000-000000000000"] }),
});
log("batch unknown", `${unknown.status} ${await unknown.text()}`);
