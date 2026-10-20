import { spawn } from 'child_process';
import os from 'os'; import path from 'path';
const BASE = 'http://127.0.0.1:9564';
const DEVICE = process.argv[2] || 'wsmac';
const CWD = process.argv[3] || '/Users/windsing';
async function main() {
  const port = 9371;
  const tempDir = path.join(os.tmpdir(), `cdp_g_${Date.now()}`);
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempDir}`, `${BASE}/?deviceId=${DEVICE}&cwd=${encodeURIComponent(CWD)}`], { detached: true, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t: any) => t.type === 'page');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => ws.on('open', res));
  let id = 1;
  const send = (m: string, p: any = {}) => new Promise<any>((res, rej) => { const c = id++; const h = (d: any) => { const msg = JSON.parse(d.toString()); if (msg.id === c) { ws.off('message', h); msg.error ? rej(msg.error) : res(msg.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: c, method: m, params: p })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const logs: string[] = []; const reqs: string[] = [];
  ws.on('message', (d: any) => { const m = JSON.parse(d.toString());
    if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + m.params.args.map((a:any)=>a.value ?? a.description ?? '').join(' ').slice(0,300));
    if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0,600));
    if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (u.includes('/api/')) reqs.push(m.params.request.method + ' ' + u.replace(BASE,'')); }
    if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r.status >= 400 && r.url.includes('/api/')) logs.push('[HTTP ' + r.status + '] ' + r.url.replace(BASE,'')); }
  });
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length > 0`)) break; await wait(500); }
  console.log('groups:', JSON.stringify(await ev(`Array.from(document.querySelectorAll('.session-tree-group-name')).map(e=>e.textContent)`)));
  console.log('all rows:', JSON.stringify(await ev(`Array.from(document.querySelectorAll('.session-tree-row')).map(e=>e.className.replace('session-tree-row ','')+'|'+(e.textContent||'').replace(/\s+/g,' ').slice(0,30))`)));
  console.log('aria-expanded:', JSON.stringify(await ev(`Array.from(document.querySelectorAll('[aria-expanded]')).map(e=>e.className.slice(0,40)+'='+e.getAttribute('aria-expanded'))`)));
  console.log('rows before click:', await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length`));
  await ev(`(() => { const g=document.querySelector('.session-tree-row.session-tree-group .session-tree-main, .session-tree-row.session-tree-group'); if(g) g.click(); return !!g; })()`);
  await wait(1200);
  console.log('rows after click:', await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length`));
  console.log('group rows:', await ev(`Array.from(document.querySelectorAll('.session-tree-row')).map(e=>e.className.replace(/session-tree-row ?/,'')+'|'+(e.textContent||'').slice(0,25))`));
  console.log('LOGS:', JSON.stringify(logs, null, 1));
  console.log('REQS:', JSON.stringify(reqs, null, 1));
  ws.close(); proc.kill();
}
void main();
