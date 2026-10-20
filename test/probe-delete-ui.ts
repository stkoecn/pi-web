// CDP probe: delete a session row on a remote device through the sidebar, and
// confirm the row disappears without the UI hanging.
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:9564";
const DEVICE = process.argv[2] || "wsmac";
const CWD = process.argv[3] || "/Users/windsing";
const PORT = 9362;

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + process.env.TEMP + "/pi-web-probe-delete",
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
await sleep(9000);

const before = await evaluate(`[...document.querySelectorAll('.session-tree-row.session-tree-session .session-tree-title')].map((n) => n.textContent.trim())`);
console.log("rows before:", before.length, before.slice(0, 4));

// Open the last row's menu and press Delete, then confirm.
const opened = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.session-tree-row.session-tree-session')];
  const row = rows[rows.length - 1];
  if (!row) return 'no rows';
  const menu = row.querySelector('[aria-label*="更多"], [aria-label*="more"], .session-tree-more');
  if (menu) { menu.click(); return 'menu clicked'; }
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  return 'contextmenu dispatched';
})()`);
console.log("menu:", opened);
await sleep(1200);

const menuItems = await evaluate(`[...document.querySelectorAll('[role=menuitem], .session-menu-item, button')].map((n) => (n.textContent || '').trim()).filter((t) => /删除|Delete/i.test(t)).slice(0, 6)`);
console.log("delete items:", menuItems);

const clicked = await evaluate(`(() => {
  const node = [...document.querySelectorAll('[role=menuitem], .session-menu-item, button')].find((n) => /删除|Delete/i.test((n.textContent || '').trim()));
  if (!node) return 'no delete item';
  node.click();
  return 'delete clicked';
})()`);
console.log("delete:", clicked);
await sleep(1200);

const confirmed = await evaluate(`(() => {
  const node = [...document.querySelectorAll('button')].find((n) => /^\\s*(删除|Delete)\\s*$/i.test((n.textContent || '').trim()));
  if (!node) return 'no confirm button (may have gone through)';
  node.click();
  return 'confirmed';
})()`);
console.log("confirm:", confirmed);

const rowIds = () => evaluate(`[...document.querySelectorAll('.session-tree-row.session-tree-session')].map((n) => n.getAttribute('data-row-key'))`);
const idsBefore = await rowIds();
const doomedKey = idsBefore[idsBefore.length - 1];
const started = Date.now();
let idsAfter = idsBefore;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  idsAfter = await rowIds();
  if (!idsAfter.includes(doomedKey)) break;
}
const after = idsAfter;
console.log("doomed row gone:", !idsAfter.includes(doomedKey), "in", ((Date.now() - started) / 1000).toFixed(1) + "s");
console.log(`settled in ${((Date.now() - started) / 1000).toFixed(1)}s: rows ${idsBefore.length} -> ${idsAfter.length}`);
console.log("removed:", idsBefore.filter((id) => !idsAfter.includes(id)));
console.log("toasts:", await evaluate(`[...document.querySelectorAll('[role=status],[role=alert],.sidebar-toast')].map((n) => n.textContent.trim()).slice(0, 4)`));
console.log("EXCEPTIONS:", exceptions.slice(0, 6));
console.log("FAILURES:", [...new Set(failures)].slice(0, 8));

ws.close();
chrome.kill();
process.exit(0);
