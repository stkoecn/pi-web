import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

async function diagnose() {
  const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const port = 9336;
  const tempDir = path.join(os.tmpdir(), 'cdp_diag_' + Date.now());
  
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + tempDir,
    'http://127.0.0.1:9564'
  ], { detached: true });

  await new Promise(r => setTimeout(r, 2000));

  const listRes = await fetch('http://127.0.0.1:' + port + '/json/list');
  const tabs = await listRes.json();
  const pageTab = tabs.find((t: any) => t.type === 'page');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(pageTab.webSocketDebuggerUrl);

  await new Promise((res) => ws.on('open', res));
  let id = 1;

  const logs: any[] = [];
  ws.on('message', (data: any) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push({ type: msg.params.type, args: msg.params.args });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push({ type: 'exception', details: msg.params.exceptionDetails });
    }
  });

  function send(method: string, params: any = {}) {
    return new Promise((res, rej) => {
      const curId = id++;
      const handler = (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === curId) {
          ws.off('message', handler);
          if (msg.error) rej(msg.error);
          else res(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  await new Promise(r => setTimeout(r, 4000));

  console.log('--- BROWSER LOGS & EXCEPTIONS ---');
  console.log(JSON.stringify(logs, null, 2));

  // Check what element is at top left, center, right
  const pointCheck: any = await send('Runtime.evaluate', {
    expression: `(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const center = document.elementFromPoint(w / 2, h / 2);
      const left = document.elementFromPoint(100, 200);
      const top = document.elementFromPoint(200, 20);
      return {
        center: center ? { tag: center.tagName, class: center.className, text: center.textContent?.slice(0, 50) } : null,
        left: left ? { tag: left.tagName, class: left.className, text: left.textContent?.slice(0, 50) } : null,
        top: top ? { tag: top.tagName, class: top.className, text: top.textContent?.slice(0, 50) } : null,
      };
    })()`,
    returnByValue: true
  });

  console.log('--- POINT CHECK ---', pointCheck.result?.value);

  // Check if any dialog or backdrop exists
  const modalCheck: any = await send('Runtime.evaluate', {
    expression: `(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const fixed = all.filter(el => {
        const cs = window.getComputedStyle(el);
        return cs.position === 'fixed' || cs.position === 'absolute';
      }).map(el => ({
        tag: el.tagName,
        class: el.className,
        rect: el.getBoundingClientRect(),
        zIndex: window.getComputedStyle(el).zIndex,
        pointerEvents: window.getComputedStyle(el).pointerEvents,
      })).filter(item => item.rect.width > 200 && item.rect.height > 200);
      return fixed;
    })()`,
    returnByValue: true
  });
  console.log('--- FIXED / ABSOLUTE LARGE ELEMENTS ---', modalCheck.result?.value);

  ws.close();
  try { chromeProc.kill(); } catch {}
  process.exit(0);
}

diagnose().catch(console.error);
