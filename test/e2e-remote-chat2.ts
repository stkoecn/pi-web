/** E2E: remote device → history list, click a session, create a new one. */
import { spawn } from 'child_process';
import os from 'os'; import path from 'path';
const BASE = 'http://127.0.0.1:9564'; const DEVICE = 'fuckip-us';

async function main() {
  const port = 9343;
  const tempDir = path.join(os.tmpdir(), `cdp_e2e2_${Date.now()}`);
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
  const errors: string[] = [];
  ws.on('message', (d: any) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text ?? 'exc');
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push(m.params.args?.map((a: any) => a.value ?? a.description ?? '').join(' '));
  });
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < 40; i++) { if (await ev(`document.querySelectorAll('.session-tree-row').length > 0`)) break; await wait(500); }
  await wait(1500);
  console.log('ROWS:', await ev(`document.querySelectorAll('.session-tree-row.session-tree-session').length`));
  console.log('TITLES:', JSON.stringify(await ev(`Array.from(document.querySelectorAll('.session-tree-row.session-tree-session .session-tree-title')).map(e => e.textContent.trim())`)));

  // Click the oldest session (last row) which has 13 messages / tool calls.
  await ev(`(() => { const rows = document.querySelectorAll('.session-tree-row.session-tree-session .session-tree-main'); const el = rows[rows.length - 1]; if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return Boolean(el); })()`);
  await wait(6000);
  const transcript = await ev(`(() => { const m = document.querySelector('.chat-scroll, .chat-window, main'); return m ? m.innerText.slice(0, 400) : ''; })()`);
  console.log('TRANSCRIPT:', JSON.stringify(transcript));
  console.log('URL:', await ev(`location.href`));

  // New session via the composer: click 新建, type, send.
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '新建'); if (b) b.click(); return Boolean(b); })()`);
  await wait(1500);
  const typed = await ev(`(() => { const ta = document.querySelector('textarea'); if (!ta) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'say exactly: PONG'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await wait(500);
  console.log('TYPED:', typed);
  await ev(`(() => { const ta = document.querySelector('textarea'); if (!ta) return false; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await wait(30000);
  const after = await ev(`(() => { const m = document.querySelector('.chat-scroll, .chat-window, main'); return m ? m.innerText.slice(-500) : ''; })()`);
  console.log('AFTER_SEND:', JSON.stringify(after));
  console.log('URL2:', await ev(`location.href`));
  console.log('ERRORS:', JSON.stringify(errors.slice(0, 8)));
  try { proc.kill(); } catch {}
  process.exit(0);
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
