import { spawn } from 'child_process';
import os from 'os'; import path from 'path';
const BASE = 'http://127.0.0.1:9564';
const DEVICE = process.argv[2] || 'fuckip-us';
async function main() {
  const port = 9358;
  const tempDir = path.join(os.tmpdir(), `cdp_n2_${Date.now()}`);
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
  const reqs: string[] = []; const logs: string[] = [];
  ws.on('message', (d: any) => { const m = JSON.parse(d.toString());
    if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (u.includes('/api/')) reqs.push(m.params.request.method + ' ' + u.replace(BASE, '') + (m.params.request.postData ? ' BODY=' + String(m.params.request.postData).slice(0,120) : '')); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails?.exception?.description || '').slice(0,300));
    if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r.status >= 400 && r.url.includes('/api/')) logs.push('[HTTP ' + r.status + '] ' + r.url.replace(BASE,'')); }
  });
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length > 0`)) break; await wait(500); }
  console.log('T+%d sidebar rows %d', Date.now()-t0, await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length`));

  // click "新建" (new session button in sidebar header)
  const newBtn = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/新建|New/i.test(x.innerText) && x.offsetParent); if(!b) return 'none'; b.click(); return b.innerText.trim(); })()`);
  console.log('clicked new:', JSON.stringify(newBtn));
  await wait(1500);
  console.log('url after new:', await ev('location.href'));
  console.log('chat area:', JSON.stringify((await ev(`document.querySelector('.chat-content')?.innerText.slice(0,200)`))));

  // type into textarea and send
  const typed = await ev(`(() => { const ta=document.querySelector('textarea'); if(!ta) return 'no-textarea'; const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; setter.call(ta,'say exactly: REMOTE_OK'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()`);
  console.log('typed:', typed);
  await wait(500);
  const sent = await ev(`(() => { const ta=document.querySelector('textarea'); const form=ta?.closest('form'); const btn=[...(form?.querySelectorAll('button')||[])].find(b=>b.type==='submit'); if(btn){btn.click(); return 'submit-btn';} ta?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'enter'; })()`);
  console.log('sent:', sent);

  let txt = '';
  for (let i = 0; i < 120; i++) { await wait(1000); txt = await ev(`document.querySelector('.chat-content')?.innerText || ''`); if (/REMOTE_OK/.test(txt.replace('say exactly: REMOTE_OK','')) ) break; }
  console.log('T+%d URL: %s', Date.now()-t0, await ev('location.href'));
  console.log('CHAT:', JSON.stringify(txt.slice(0,700)));
  console.log('LOGS:'); for (const l of logs) console.log('  ', l);
  console.log('REQS:'); for (const r of reqs) if (!r.includes('/api/files') && !r.includes('/api/git')) console.log('  ', r);
  try { proc.kill(); } catch {}
  process.exit(0);
}
main();
