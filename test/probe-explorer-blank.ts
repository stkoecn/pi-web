// Does the file tree blank out while it refreshes? Opens a remote device, waits
// for the root listing, then fires the refresh the explorer runs on window
// focus and samples the tree, watching for the rows disappearing.
const BASE = "http://127.0.0.1:9564";
const DEVICE = "wsmac";
const CWD = "/Users/windsing";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json() as Array<{ webSocketDebuggerUrl: string }>;
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const requests: string[] = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String((event as MessageEvent).data));
  if (msg.method === "Network.requestWillBeSent" && msg.params.request.url.includes("/api/files/")) {
    requests.push(msg.params.request.url.replace(BASE, ""));
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)!;
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
const send = (method: string, params: Record<string, unknown> = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise<Record<string, any>>((resolve, reject) => pending.set(id, { resolve: resolve as never, reject }));
};
const ev = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
const snap = `(() => {
  const panel = document.querySelector('.sidebar-files-panel');
  if (!panel) return { rows: -1, loading: false };
  return { rows: panel.querySelectorAll('[title]').length, loading: /Loading files/.test(panel.innerText) };
})()`;
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await send("Network.enable");
await send("Page.enable");
await send("Page.navigate", { url: `${BASE}/?deviceId=${DEVICE}&cwd=${encodeURIComponent(CWD)}` });
await sleep(12000);
console.log("settled:", JSON.stringify(await ev(snap)));
const before = requests.length;
const samples: Array<{ rows: number; loading: boolean }> = [];
await ev(`window.dispatchEvent(new Event('focus'))`);
for (let i = 0; i < 30; i++) { samples.push(await ev(snap)); await sleep(40); }
const blank = samples.filter((s) => s.rows === 0 || s.loading);
console.log("blank samples:", JSON.stringify(blank));
console.log("min rows:", Math.min(...samples.map((s) => s.rows)));
console.log("listing requests during refresh:", requests.length - before, JSON.stringify(requests.slice(before)));
