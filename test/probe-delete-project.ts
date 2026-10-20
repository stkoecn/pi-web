import { spawn } from 'child_process';
import os from 'os'; import path from 'path';
const BASE = 'http://127.0.0.1:9564';
const DEVICE = process.argv[2] || 'wsmac';
const CWD = process.argv[3] || '/Users/windsing';
async function main() {
  const port = 9381;
  const tempDir = path.join(os.tmpdir(), `cdp_dp_${Date.now()}`);
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
    if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0,500));
    if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (u.includes('/api/')) reqs.push(m.params.request.method + ' ' + u.replace(BASE,'') + (m.params.request.postData ? ' ' + m.params.request.postData.slice(0,120) : '')); }
    if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r.status >= 400 && r.url.includes('/api/')) logs.push('[HTTP ' + r.status + '] ' + r.url.replace(BASE,'')); }
  });
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length > 0`)) break; await wait(500); }
  console.log('rows before:', await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length`));

  // open the group header's ⋯ menu
  console.log('group menu:', await ev(`(() => { const b=document.querySelector('.session-tree-group-action[aria-haspopup]'); if(!b) return 'no group action'; b.click(); return 'clicked'; })()`));
  await wait(1000);
  console.log('menu labels:', JSON.stringify(await ev(`[...document.querySelectorAll('.sidebar-menu [role=menuitem], .sidebar-menu button')].map(n=>({t:(n.querySelector('.sidebar-menu-label')?.textContent||n.textContent||'').trim(), dis:n.getAttribute('aria-disabled')}))`)));
  console.log('delete-all item:', await ev(`(() => { const n=[...document.querySelectorAll('button, [role=menuitem]')].find(n=>/删除全部会话|Delete all sessions/i.test((n.textContent||'').trim())); if(!n) return 'not found'; n.click(); return 'clicked: '+n.textContent.trim(); })()`));
  await wait(1200);
  console.log('confirm body:', JSON.stringify(await ev(`[...document.querySelectorAll('.sidebar-menu-question-buttons button')].map(n=>n.textContent.trim())`)));
  console.log('confirm:', await ev(`(() => { const n=document.querySelector('.sidebar-menu-question-confirm'); if(!n) return 'no confirm'; if(n.disabled) return 'confirm disabled'; n.click(); return 'clicked '+n.textContent.trim(); })()`));
  const before = Date.now();
  let left = -1;
  for (let i = 0; i < 60; i++) { await wait(500); left = await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length`); if (left === 0) break; }
  console.log('rows after:', left, 'in', Date.now()-before, 'ms');
  console.log('toast:', await ev(`document.querySelector('.sidebar-toast, [role=status]')?.textContent?.trim() || ''`));
  console.log('LOGS:', JSON.stringify(logs));
  console.log('REQS:', JSON.stringify(reqs.filter(r => /delete|sessions\?/.test(r)), null, 1));
  ws.close(); proc.kill();
}
void main();
