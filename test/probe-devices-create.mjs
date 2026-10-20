// CDP probe: create a dialled-in device from the panel, confirm it persists,
// then remove it again — so the round trip through devices.json is proven.
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:9564";
const PORT = 9364;
const WIDTH = Number(process.argv[2] || 1440);
const ID = process.argv[3] || "probe-tunnel";

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + process.env.TEMP + "/pi-web-probe-devices2",
  "--no-first-run", "--no-default-browser-check", `--window-size=${WIDTH},900`,
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

await send("Page.navigate", { url: `${BASE}/` });
await sleep(9000);

await evaluate([
  "(() => {",
  "  const button = [...document.querySelectorAll('button')].find((b) => /设置|settings/i.test(b.getAttribute('aria-label') || b.title || ''));",
  "  button?.click();",
  "})()",
].join("\n"));
await sleep(1500);
await evaluate([
  "(() => {",
  "  [...document.querySelectorAll('button,[role=tab]')]",
  "    .find((n) => /^(主机设备|裝置|设备|devices)$/i.test((n.textContent || '').trim()))?.click();",
  "})()",
].join("\n"));
await sleep(2200);

console.log("add:", await evaluate([
  "(() => {",
  "  const add = document.querySelector('[data-device-add=\"true\"]');",
  "  if (!add) return 'no add action';",
  "  add.click();",
  "  return 'clicked';",
  "})()",
].join("\n")));
await sleep(900);

const setValue = [
  "const setValue = (el, value) => {",
  "  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;",
  "  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);",
  "  el.dispatchEvent(new Event('input', { bubbles: true }));",
  "};",
].join("\n");

console.log("fill:", JSON.stringify(await evaluate([
  "(async () => {",
  setValue,
  "  const put = (key, value) => {",
  "    const el = document.querySelector('[data-device-field=\"' + key + '\"]');",
  "    if (!el) return 'missing:' + key;",
  "    setValue(el, value);",
  "    return 'ok';",
  "  };",
  `  const results = [put('id', ${JSON.stringify(ID)}), put('name', 'probe tunnel'), put('username', 'windsing')];`,
  "  const reverse = [...document.querySelectorAll('[data-device-mode]')].find((m) => m.getAttribute('data-device-mode') === 'reverse_tunnel');",
  "  reverse?.click();",
  "  await new Promise((r) => setTimeout(r, 400));",
  "  return {",
  "    results,",
  "    hostField: Boolean(document.querySelector('[data-device-field=\"host\"]')),",
  "    footer: (document.querySelector('.config-footer-status-summary')?.textContent || '').trim(),",
  "    saveDisabled: document.querySelector('[data-device-save=\"true\"]')?.disabled ?? null,",
  "  };",
  "})()",
].join("\n"))));

console.log("save:", await evaluate([
  "(() => {",
  "  document.querySelector('[data-device-save=\"true\"]')?.click();",
  "  return 'clicked';",
  "})()",
].join("\n")));
await sleep(3500);

console.log("after save:", JSON.stringify(await evaluate([
  "(() => ({",
  "  status: (document.querySelector('.config-footer-status-summary')?.textContent || '').trim(),",
  "  rows: [...document.querySelectorAll('[data-device-config-item]')].map((r) => r.getAttribute('data-device-config-item')),",
  "}))()",
].join("\n"))));

console.log("select for delete:", JSON.stringify(await evaluate([
  "(() => {",
  `  const row = [...document.querySelectorAll('[data-device-config-item]')].find((r) => r.getAttribute('data-device-config-item') === ${JSON.stringify(ID)});`,
  "  row?.click();",
  "  return { found: Boolean(row) };",
  "})()",
].join("\n"))));
await sleep(900);

// window.confirm opens no dialog in headless Chrome unless handled; override it.
console.log("delete:", JSON.stringify(await evaluate([
  "(async () => {",
  "  window.confirm = () => true;",
  "  const button = [...document.querySelectorAll('button')].find((b) => /移除|删除|Remove/i.test((b.textContent || '').trim()));",
  "  if (!button) return 'no delete button';",
  "  button.click();",
  "  await new Promise((r) => setTimeout(r, 3000));",
  "  return {",
  "    status: (document.querySelector('.config-footer-status-summary')?.textContent || '').trim(),",
  "    rows: [...document.querySelectorAll('[data-device-config-item]')].map((r) => r.getAttribute('data-device-config-item')),",
  "  };",
  "})()",
].join("\n"))));

console.log("LOGS:", logs.slice(0, 8));
console.log("FAILURES:", [...new Set(failures)].slice(0, 10));

ws.close();
chrome.kill();
process.exit(0);
