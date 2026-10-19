import { spawn } from 'child_process';
import os from 'os'; import path from 'path';
const BASE = 'http://127.0.0.1:9564';
async function main() {
  const port = 9355;
  const tempDir = path.join(os.tmpdir(), `cdp_n_${Date.now()}`);
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempDir}`, `${BASE}/?deviceId=fuckip-us&cwd=%2Froot`], { detached: true, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t: any) => t.type === 'page');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => ws.on('open', res));
  let id = 1;
  const send = (m: string, p: any = {}) => new Promise<any>((res, rej) => { const c = id++; const h = (d: any) => { const msg = JSON.parse(d.toString()); if (msg.id === c) { ws.off('message', h); msg.error ? rej(msg.error) : res(msg.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: c, method: m, params: p })); });
  await send('Page.enable'); await send('Runtime.enable');
  const reqs: string[] = [];
  ws.on('message', (d: any) => { const m = JSON.parse(d.toString()); if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (u.includes('/api/') || u.includes('_rsc')) reqs.push(u.replace(BASE, '')); } });
  await send('Network.enable');
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length > 0`)) break; await wait(500); }
  console.log('T+%dms URL:', Date.now() - t0, await ev('location.href'));
  console.log('SIDEBAR:', JSON.stringify((await ev(`document.querySelector('.sidebar-container').innerText.slice(0,200)`))));
  await wait(4000);
  console.log('T+%dms URL:', Date.now() - t0, await ev('location.href'));
  console.log('SIDEBAR2:', JSON.stringify((await ev(`document.querySelector('.sidebar-container').innerText.slice(0,200)`))));
  console.log('ALL REQS:'); for (const r of reqs) console.log('  ', r);
  try { proc.kill(); } catch {}
  process.exit(0);
}
main();
