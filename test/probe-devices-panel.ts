// CDP probe: does Settings › Devices render both connection modes, hide the
// address for a dialled-in host, and save a reverse-tunnel device?
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:9564";
const PORT = 9363;
const WIDTH = Number(process.argv[2] || 1440);

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + process.env.TEMP + "/pi-web-probe-devices",
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

console.log("settings:", await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /设置|settings/i.test(b.getAttribute('aria-label') || b.title || ''));
  if (!button) return 'no settings button';
  button.click();
  return 'clicked';
})()`));
await sleep(1500);

console.log("devices tab:", await evaluate(`(() => {
  const node = [...document.querySelectorAll('button,a,[role=tab],[role=button]')]
    .find((n) => /^(主机设备|裝置|设备|devices)$/i.test((n.textContent || '').trim()));
  if (!node) return 'no devices tab; tabs=' + [...document.querySelectorAll('button,[role=tab]')]
    .map((n) => (n.textContent || '').trim().slice(0, 14)).filter(Boolean).slice(0, 30).join('|');
  node.click();
  return 'clicked:' + (node.textContent || '').trim();
})()`));
await sleep(2500);

// The saved rows, each with its live state, are the first thing to check.
console.log("rows:", JSON.stringify(await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-device-config-item]')];
  return rows.map((r) => ({
    id: r.getAttribute('data-device-config-item'),
    text: (r.innerText || '').replace(/\\s+/g, ' ').trim(),
  }));
})()`)));

// A saved reverse-tunnel device must show the tunnel hint, not host/port.
const tunnelRow = await evaluate(`(() => {
  const row = [...document.querySelectorAll('[data-device-config-item]')]
    .find((r) => /tunnel/i.test(r.getAttribute('data-device-config-item') || ''));
  if (!row) return 'no tunnel row';
  row.click();
  return row.getAttribute('data-device-config-item');
})()`);
console.log("tunnel row:", tunnelRow);
await sleep(1200);

console.log("tunnel form:", JSON.stringify(await evaluate(`(() => {
  const field = (key) => document.querySelector('[data-device-field="' + key + '"]');
  const modes = [...document.querySelectorAll('[data-device-mode]')].map((m) => ({
    mode: m.getAttribute('data-device-mode'),
    selected: m.getAttribute('data-selected'),
  }));
  const command = document.querySelector('[data-device-tunnel-command], .settings-device-command');
  return {
    modes,
    hostField: Boolean(field('host')),
    portField: Boolean(field('port')),
    usernameField: Boolean(field('username')),
    command: command ? (command.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    subtitle: (document.querySelector('.config-detail-subtitle')?.textContent || '').trim(),
    footer: (document.querySelector('.config-footer-status-summary')?.textContent || '').trim(),
  };
})()`)));

// Switching mode to "gateway dials out" must bring the address fields back.
console.log("switch to active:", JSON.stringify(await evaluate(`(async () => {
  const label = [...document.querySelectorAll('[data-device-mode]')]
    .find((m) => m.getAttribute('data-device-mode') === 'active_ssh');
  if (!label) return 'no active mode';
  label.click();
  await new Promise((r) => setTimeout(r, 400));
  return {
    hostField: Boolean(document.querySelector('[data-device-field="host"]')),
    portField: Boolean(document.querySelector('[data-device-field="port"]')),
    command: Boolean(document.querySelector('.settings-device-command')),
  };
})()`)));

// Back to reverse tunnel, then verify the layout does not overflow the panel.
console.log("layout:", JSON.stringify(await evaluate(`(async () => {
  const label = [...document.querySelectorAll('[data-device-mode]')]
    .find((m) => m.getAttribute('data-device-mode') === 'reverse_tunnel');
  label.click();
  await new Promise((r) => setTimeout(r, 400));
  const detail = document.querySelector('.config-detail');
  const form = document.querySelector('.settings-device-form');
  const modes = document.querySelector('.settings-device-modes');
  return {
    detailWidth: detail?.clientWidth ?? null,
    formScroll: form ? form.scrollWidth - form.clientWidth : null,
    modesScroll: modes ? modes.scrollWidth - modes.clientWidth : null,
    modeBoxes: [...document.querySelectorAll('[data-device-mode]')].map((m) => {
      const r = m.getBoundingClientRect();
      return { mode: m.getAttribute('data-device-mode'), x: Math.round(r.x), width: Math.round(r.width) };
    }),
  };
})()`)));

console.log("LOGS:", logs.slice(0, 8));
console.log("FAILURES:", [...new Set(failures)].slice(0, 10));

ws.close();
chrome.kill();
process.exit(0);
