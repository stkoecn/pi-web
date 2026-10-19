import { spawn } from 'child_process';
import os from 'os'; import path from 'path';
const BASE = 'http://127.0.0.1:9564';
async function main() {
  const device = process.argv[2] || 'fuckip-us';
  const port = 9350;
  const tempDir = path.join(os.tmpdir(), `cdp_c_${Date.now()}`);
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempDir}`, `${BASE}/?deviceId=${device}&cwd=%2Froot`], { detached: true, stdio: 'ignore' });
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
  ws.on('message', (d: any) => { const m = JSON.parse(d.toString()); if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url.replace(BASE, '')); });
  await send('Network.enable');
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) { if (await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length > 0`)) break; await wait(500); }
  await wait(1000);
  await ev(`(() => { const rows = document.querySelectorAll('.session-tree-row.session-tree-session .session-tree-main'); rows[rows.length-1].dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await wait(6000);
  console.log('URL:', await ev('location.href'));
  console.log('BODY:', JSON.stringify((await ev(`document.body.innerText.slice(0, 1200)`)) ?? ''));
  console.log('MAIN CLASSES:', JSON.stringify(await ev(`Array.from(document.querySelectorAll('main, .chat-*, [class*=chat], [class*=Chat]')).map(e => e.className).slice(0,25)`)));
  console.log('REQS:', JSON.stringify(reqs.filter(u => u.includes('session') || u.includes('agent')).slice(-25)));
  try { proc.kill(); } catch {}
  process.exit(0);
}
main();
