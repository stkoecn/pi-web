/** End-to-end: switch to the remote device in a real browser, load history, create a session. */
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

const BASE = 'http://127.0.0.1:9564';
const DEVICE = 'fuckip-us';

async function main() {
  const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const port = 9341;
  const tempDir = path.join(os.tmpdir(), `cdp_e2e_${Date.now()}`);
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempDir}`,
    `${BASE}/?deviceId=${DEVICE}&cwd=%2Froot`,
  ], { detached: true, stdio: 'ignore' });

  await new Promise(r => setTimeout(r, 2500));
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t: any) => t.type === 'page');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => ws.on('open', res));
  let id = 1;
  const send = (method: string, params: any = {}) => new Promise<any>((res, rej) => {
    const curId = id++;
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === curId) { ws.off('message', handler); msg.error ? rej(msg.error) : res(msg.result); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params }));
  });
  await send('Page.enable'); await send('Runtime.enable');
  const errors: string[] = [];
  ws.on('message', (d: any) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text ?? 'exc');
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      errors.push(m.params.args?.map((a: any) => a.value ?? a.description ?? '').join(' '));
    }
  });
  const evaluate = async (expression: string) => {
    const r: any = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  for (let i = 0; i < 40; i++) {
    if (await evaluate(`Boolean(document.querySelector('.sidebar-container'))`)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 3000));

  const deviceLabel = await evaluate(`(() => { const b = document.querySelector('button[title*="Current Device"], [data-device-selector]'); return b ? b.textContent.trim().slice(0,60) : null; })()`);
  const projects = await evaluate(`Array.from(document.querySelectorAll('.session-group-header-title')).map(e => e.textContent.trim()).filter(Boolean)`);
  const sessionRows = await evaluate(`Array.from(document.querySelectorAll('.session-item, .session-row, [data-session-id]')).length`);
  const firstTitle = await evaluate(`(() => { const el = document.querySelector('.session-item .session-title, .session-row .session-title'); return el ? el.textContent.trim().slice(0,80) : null; })()`);

  console.log('DEVICE_LABEL:', deviceLabel);
  console.log('PROJECTS:', JSON.stringify(projects));
  console.log('SESSION_ROWS:', sessionRows);
  console.log('FIRST_TITLE:', firstTitle);

  // Click the first history row and check the transcript renders.
  const clicked = await evaluate(`(() => {
    const el = document.querySelector('.session-item, .session-row, [data-session-id]');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 5000));
  const messages = await evaluate(`document.querySelectorAll('.chat-message, [data-role], .message-row').length`);
  const bodyText = await evaluate(`(() => { const m = document.querySelector('.chat-window, main'); return m ? m.innerText.slice(0, 300) : ''; })()`);
  console.log('CLICKED:', clicked);
  console.log('MESSAGE_NODES:', messages);
  console.log('TRANSCRIPT_HEAD:', JSON.stringify(bodyText));
  console.log('ERRORS:', JSON.stringify(errors.slice(0, 6)));

  try { chromeProc.kill(); } catch {}
  process.exit(0);
}
main().catch(e => { console.error('E2E FAILED', e); process.exit(1); });
