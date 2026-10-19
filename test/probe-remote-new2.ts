import { spawn } from 'child_process';
import os from 'os'; import path from 'path';

/**
 * New-session E2E for any device: opens the device, starts a fresh session,
 * types a prompt, sends it, and reports the streamed answer plus any console
 * exceptions or failed requests.
 *
 *   bun run test/probe-remote-new2.ts wsmac "/Users/windsing"
 */
const BASE = 'http://127.0.0.1:9564';
const DEVICE = process.argv[2] || 'fuckip-us';
const CWD = process.argv[3] || '';
const PROMPT = process.argv[4] || 'say exactly: REMOTE_OK';

async function main() {
  const port = 9361;
  const tempDir = path.join(os.tmpdir(), `cdp_n_${Date.now()}`);
  const start = `${BASE}/?deviceId=${DEVICE}${CWD ? `&cwd=${encodeURIComponent(CWD)}` : ''}`;
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tempDir}`, start,
  ], { detached: true, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t: any) => t.type === 'page');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => ws.on('open', res));
  let id = 1;
  const send = (m: string, p: any = {}) => new Promise<any>((res, rej) => {
    const c = id++;
    const h = (d: any) => { const msg = JSON.parse(d.toString()); if (msg.id === c) { ws.off('message', h); msg.error ? rej(msg.error) : res(msg.result); } };
    ws.on('message', h); ws.send(JSON.stringify({ id: c, method: m, params: p }));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const reqs: string[] = [];
  const logs: string[] = [];
  ws.on('message', (d: any) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (u.includes('/api/')) reqs.push(m.params.request.method + ' ' + u.replace(BASE, '')); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
    if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 800));
    if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r.url.includes('/api/')) logs.push('[RESP ' + r.status + '] ' + r.url.replace(BASE, '')); }
    if (m.method === 'Network.loadingFailed') { logs.push('[FAIL ' + (m.params.errorText || '') + '] ' + (m.params.blockedReason || '')); }
  });
  const ev = async (e: string) => { const r: any = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();

  for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('textarea, [contenteditable="true"]')`)) break; await wait(500); }
  console.log('composer ready T+%d url=%s', Date.now() - t0, await ev('location.href'));

  // Type into the composer via the React-friendly input event path.
  const typed = await ev(`(() => {
    const el = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    if (!el) return 'no-composer';
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(PROMPT)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = ${JSON.stringify(PROMPT)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return el.tagName + ':' + (el.value ?? el.textContent).slice(0, 40);
  })()`);
  console.log('typed:', JSON.stringify(typed));

  const sent = await ev(`(() => {
    const el = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    if (!el) return 'no-composer';
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    return 'enter-sent';
  })()`);
  console.log('sent:', JSON.stringify(sent));

  // Wait for the turn to settle. Matching the answer text alone is useless: the
  // prompt itself contains it. The running indicators are what disappear.
  let last = '';
  let settled = false;
  for (let i = 0; i < 120; i++) {
    const state = await ev(`(() => {
      const el = document.querySelector('.chat-content');
      const text = (el?.innerText || document.body.innerText || '').slice(-1500);
      return { text, entries: document.querySelectorAll('[data-entry-id]').length };
    })()`);
    if (state && state.text !== last) last = state.text;
    const running = /正在等待模型|正在思考|停止/.test(last);
    if (state && state.entries > 0 && !running && last.includes('REMOTE_OK')) { settled = true; break; }
    await wait(1000);
  }
  console.log('settled:', settled);
  console.log('FINAL URL:', await ev('location.href'));
  console.log('CHAT TAIL:', JSON.stringify(last.slice(-700)));
  console.log('LOGS:'); for (const l of logs) console.log('  ', l);
  console.log('REQS:'); for (const r of reqs) console.log('  ', r);
  try { proc.kill(); } catch { /* ignore */ }
  process.exit(0);
}
main();
