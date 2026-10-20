// CDP probe: open a remote session (live SSE stream) then delete it, and time
// how long the UI takes to settle. The idle-row case is covered by
// probe-delete-ui.ts; this is the flow a user actually hits.
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:9564";
const DEVICE = process.argv[2] || "wsmac";
// Git-Bash rewrites a "/Users/..." argv (and env value) into a Windows path,
// so the folder is a constant here.
const CWD = "/Users/windsing";
const PORT = 9363;

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + process.env.TEMP + "/pi-web-probe-delete2",
  "--no-first-run", "--no-default-browser-check", "--window-size=1500,1000",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("chrome did not start");
}

const page = await pageTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const requests = [];
const failures = [];
const exceptions = [];

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
  if (msg.method === "Network.requestWillBeSent") {
    const { url, method } = msg.params.request;
    if (url.includes("/api/")) requests.push(`${method} ${url.replace(BASE, "")}`);
  }
  if (msg.method === "Network.responseReceived") {
    const { url, status } = msg.params.response;
    if (url.includes("/api/") && status >= 400) failures.push(`${status} ${url.replace(BASE, "")}`);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "eval failed");
  return res.result.value;
}

await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");
await send("Network.enable");
await send("Page.enable");

await send("Page.navigate", { url: `${BASE}/?deviceId=${DEVICE}&cwd=${encodeURIComponent(CWD)}` });
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const n = await evaluate("document.querySelectorAll('.session-tree-row.session-tree-session').length");
  if (n > 0) break;
}
await sleep(1500);
console.log("rows:", await evaluate("document.querySelectorAll('.session-tree-row.session-tree-session').length"));

// Open the first row so its chat and SSE stream go live.
const opened = await evaluate(`(() => {
  const row = document.querySelector('.session-tree-row.session-tree-session .session-tree-main');
  if (!row) return 'no rows';
  row.click();
  return 'opened';
})()`);
console.log("open:", opened);
await sleep(6000);
console.log("url:", await evaluate("location.search"));
console.log("chat blocks:", await evaluate("document.querySelectorAll('[data-entry-id]').length"));

const idsBefore = await evaluate(`[...document.querySelectorAll('.session-tree-row.session-tree-session')].map((n) => n.getAttribute('data-row-key'))`);
const doomedKey = idsBefore[0];

requests.length = 0;
const started = Date.now();
const clicked = await evaluate(`(() => {
  const row = document.querySelector('.session-tree-row.session-tree-session');
  const menu = row.querySelector('[aria-label*="更多"], [aria-label*="more"], .session-tree-more');
  if (menu) { menu.click(); return 'menu clicked'; }
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  return 'contextmenu';
})()`);
console.log("menu:", clicked);
await sleep(1200);
console.log("delete:", await evaluate(`(() => {
  const node = [...document.querySelectorAll('[role=menuitem], .session-menu-item, button')].find((n) => /删除|Delete/i.test((n.textContent || '').trim()));
  if (!node) return 'no item';
  node.click();
  return 'clicked';
})()`));
await sleep(1200);
console.log("confirm:", await evaluate(`(() => {
  const node = [...document.querySelectorAll('button')].find((n) => /^\\s*(删除|Delete)\\s*$/i.test((n.textContent || '').trim()));
  if (!node) return 'no confirm';
  node.click();
  return 'confirmed';
})()`));

let gone = false;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const ids = await evaluate(`[...document.querySelectorAll('.session-tree-row.session-tree-session')].map((n) => n.getAttribute('data-row-key'))`);
  if (!ids.includes(doomedKey)) { gone = true; break; }
}
console.log(`row gone: ${gone} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log("url after:", await evaluate("location.search"));
console.log("chat blocks after:", await evaluate("document.querySelectorAll('[data-entry-id]').length"));
await sleep(3000);
console.log("REQUESTS (post-click):", requests.filter((r) => /DELETE|events|running|sessions\?/.test(r)).slice(0, 20));
console.log("EXCEPTIONS:", exceptions.slice(0, 6));
console.log("FAILURES:", [...new Set(failures)].slice(0, 8));

ws.close();
chrome.kill();
process.exit(0);
