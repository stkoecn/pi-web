// CDP probe: does Settings › MCP render the device's own servers, and does a
// session row's Delete actually remove the row?
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:9564";
const DEVICE = process.argv[2] || "wsmac";
const CWD = process.argv[3] || "/Users/windsing";
const PORT = 9361;

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + process.env.TEMP + "/pi-web-probe-settings",
  "--no-first-run", "--no-default-browser-check", "--window-size=1500,1000",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("chrome did not start");
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const failures = [];

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    logs.push(`EXC ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    logs.push(`ERR ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  }
  if (msg.method === "Network.responseReceived") {
    const { url, status } = msg.params.response;
    if (url.includes("/api/") && status >= 400) failures.push(`${status} ${url.replace(BASE, "")}`);
  }
});

function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
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

console.log("device in url:", await evaluate("location.search"));

// Open Settings, then the MCP section.
const opened = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /设置|settings/i.test(b.getAttribute('aria-label') || b.title || ''));
  if (button) { button.click(); return 'clicked:' + (button.getAttribute('aria-label') || button.textContent || '').slice(0, 40); }
  return 'no settings button; buttons=' + [...document.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 20)).filter(Boolean).slice(0, 30).join('|');
})()`);
console.log("settings:", opened);
await sleep(1500);

const mcpTab = await evaluate(`(() => {
  const node = [...document.querySelectorAll('button,a,[role=tab],[role=button]')].find((n) => /^\\s*mcp\\s*$/i.test((n.textContent || '').trim()));
  if (node) { node.click(); return 'clicked mcp tab'; }
  return 'no mcp tab; tabs=' + [...document.querySelectorAll('button,a,[role=tab]')].map((n) => (n.textContent || '').trim().slice(0, 18)).filter(Boolean).slice(0, 40).join('|');
})()`);
console.log("mcp tab:", mcpTab);
await sleep(6000);

const panel = await evaluate(`(() => {
  const text = document.body.innerText;
  return {
    hasWechat: /wechat/i.test(text),
    hasDingtalk: /dingtalk/i.test(text),
    loadFailure: /failed to load|could not load|加载失败/i.test(text),
    snippet: text.slice(0, 1400),
  };
})()`);
console.log("mcp panel:", JSON.stringify(panel, null, 2).slice(0, 2000));

console.log("LOGS:", logs.slice(0, 12));
console.log("FAILURES:", [...new Set(failures)].slice(0, 12));

ws.close();
chrome.kill();
process.exit(0);
