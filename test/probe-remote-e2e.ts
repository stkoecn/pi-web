import { spawn } from 'child_process';
import os from 'os'; import path from 'path';
const BASE = 'http://127.0.0.1:9564';
const DEVICE = process.argv[2] || 'fuckip-us';
async function main() {
  const port = 9357;
  const tempDir = path.join(os.tmpdir(), `cdp_e_${Date.now()}`);
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempDir}`, `${BASE}/?deviceId=${DEVICE}&cwd=%2Froot`], { detached: true, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t: any) => t.type === 'page');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => ws.on('open', res));
  let id = 1;
  const send = (m: string, p: any = {}) => new Promise<any>((res, rej) => { const c = id++; const h = (d: any) => { const msg = JSON.parse(d.toString()); if (msg.id === c) { ws.off('message', h); msg.error ? rej(msg.error) : res(msg.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: c, method: m, params: p })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const reqs: string[] = [];
  const logs: string[] = [];
  ws.on('message', (d: any) => { const m = JSON.parse(d.toString());
    if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (u.includes('/api/')) reqs.push(m.params.request.method + ' ' + u.replace(BASE, '')); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + m.params.args.map((a:any)=>a.value ?? a.description ?? '').join(' ').slice(0,500));
    if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0,900));
    if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r.status >= 400 && r.url.includes('/api/')) logs.push('[HTTP ' + r.status + '] ' + r.url.replace(BASE,'')); }
  });
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length > 0`)) break; await wait(500); }
  console.log('T+%d sidebar rows: %d url=%s', Date.now()-t0, await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length`), await ev('location.href'));

  // click first remote session row
  const clicked = await ev(`(() => { const rows=[...document.querySelectorAll('.session-tree-row.session-tree-session')]; const r=rows[0]; if(!r) return 'none'; r.click(); return r.innerText.slice(0,40); })()`);
  console.log('clicked row:', JSON.stringify(clicked));
  await wait(1500);
  console.log('after click url:', await ev('location.href'));

  // wait for messages to render
  let counts = { blocks: 0, text: '' };
  for (let i = 0; i < 40; i++) {
    counts = await ev(`(() => { const b=document.querySelectorAll('[data-entry-id], [data-message-id], .chat-entry'); const el=document.querySelector('.chat-content'); return { blocks: b.length, text: (el?.innerText || document.body.innerText).slice(0,600) }; })()`);
    if (counts.blocks > 2) break;
    await wait(500);
  }
  console.log('T+%d message blocks: %d', Date.now()-t0, counts.blocks);
  console.log('CHAT TEXT:', JSON.stringify(counts.text));
  console.log('LOGS:'); for (const l of logs) console.log('  ', l);
  console.log('REQS:'); for (const r of reqs) console.log('  ', r);
  try { proc.kill(); } catch {}
  process.exit(0);
}
main();
