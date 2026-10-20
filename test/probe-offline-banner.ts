// Probe: prove the offline banner renders. CDP intercepts the session-detail
// request and answers 503 device-offline, which is exactly what a device that
// dropped mid-read produces.
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:9564";
const DEVICE = process.argv[2] || "wsmac";
const PORT = 9364;

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + process.env.TEMP + "/pi-web-probe-offline",
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
  if (msg.method === "Fetch.requestPaused") {
    const { requestId, request } = msg.params;
    const detail = /\/api\/sessions\/[^/?]+\?/.test(request.url);
    if (detail) {
      // A session-detail read while the device is away.
      ws.send(JSON.stringify({
        id: ++seq,
        method: "Fetch.fulfillRequest",
        params: {
          requestId,
          responseCode: 503,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(JSON.stringify({
            error: `Device '${DEVICE}' is not connected or offline`,
            code: "device-offline",
            deviceId: DEVICE,
          })).toString("base64"),
        },
      }));
      return;
    }
    ws.send(JSON.stringify({ id: ++seq, method: "Fetch.continueRequest", params: { requestId } }));
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
await send("Page.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/sessions/*", requestStage: "Request" }] });

await send("Page.navigate", { url: `${BASE}/?deviceId=${DEVICE}&cwd=%2FUsers%2Fwindsing` });
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (await evaluate("document.querySelectorAll('.session-tree-row.session-tree-session').length") > 0) break;
}

await evaluate(`document.querySelector('.session-tree-row.session-tree-session .session-tree-main')?.click()`);
await sleep(4000);

console.log("url:", await evaluate("location.search"));
console.log("status nodes:", await evaluate(`[...document.querySelectorAll('[role=status]')].map((n) => n.textContent.trim())`));
console.log("banner:", await evaluate(`(() => {
  const node = [...document.querySelectorAll('[role=status]')].find((n) => /offline|离线/i.test(n.textContent || ''));
  return node ? node.textContent.trim() : null;
})()`));
console.log("detail 503 count:", await evaluate("window.__piweb503 || 'n/a'"));
console.log("chat still mounted:", await evaluate("Boolean(document.querySelector('.chat-content'))"));
console.log("EXCEPTIONS:", exceptions.slice(0, 5));

ws.close();
chrome.kill();
process.exit(0);
