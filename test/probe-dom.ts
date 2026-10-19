import { spawn } from 'child_process';
import os from 'os'; import path from 'path';
const BASE = 'http://127.0.0.1:9564'; const DEVICE = 'fuckip-us';
async function main() {
  const port = 9342;
  const tempDir = path.join(os.tmpdir(), `cdp_dom_${Date.now()}`);
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempDir}`, `${BASE}/?deviceId=${DEVICE}&cwd=%2Froot`], { detached: true, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t: any) => t.type === 'page');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => ws.on('open', res));
  let id = 1;
  const send = (m: string, p: any = {}) => new Promise<any>((res, rej) => { const c = id++; const h = (d: any) => { const msg = JSON.parse(d.toString()); if (msg.id === c) { ws.off('message', h); msg.error ? rej(msg.error) : res(msg.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: c, method: m, params: p })); });
  await send('Page.enable'); await send('Runtime.enable');
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  for (let i = 0; i < 40; i++) { if (await ev(`document.querySelectorAll('*').length > 100`)) break; await new Promise(r => setTimeout(r, 500)); }
  await new Promise(r => setTimeout(r, 6000));
  console.log('CLASSES:', JSON.stringify(await ev(`Array.from(new Set(Array.from(document.querySelectorAll('aside *, nav *, .sidebar-container *')).map(e => e.className).filter(c => typeof c === 'string' && c.includes('session')))).slice(0,40)`)));
  console.log('SIDEBAR_TEXT:', JSON.stringify((await ev(`(() => { const s = document.querySelector('.sidebar-container, aside, nav'); return s ? s.innerText.slice(0, 800) : 'NO SIDEBAR'; })()`))));
  try { proc.kill(); } catch {}
  process.exit(0);
}
main();
