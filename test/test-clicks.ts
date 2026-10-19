import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

async function testClicks() {
  const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const port = 9338;
  const tempDir = path.join(os.tmpdir(), 'cdp_clicks_' + Date.now());
  
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

  const errors: any[] = [];
  ws.on('message', (data: any) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push({ type: 'console.error', args: msg.params.args.map((a: any) => a.value || a.description) });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push({ type: 'exception', details: msg.params.exceptionDetails });
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

  // Wait for hydration
  await new Promise(r => setTimeout(r, 3500));

  console.log('--- STEP 1: Click DeviceSelector ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('button[title*="Current Device"]');
      if (btn) btn.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 500));

  console.log('--- STEP 2: Click fuckip-us ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const item = document.querySelector('[data-device-item="fuckip-us"]');
      if (item) item.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 3000));

  console.log('--- STEP 3: Click Files tab ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const tab = document.getElementById('session-sidebar-tab-files');
      if (tab) tab.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 1500));

  console.log('--- STEP 4: Click a file in the tree ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const nodes = Array.from(document.querySelectorAll('.file-item, [class*="file-item"], [data-path]'));
      if (nodes[0]) nodes[0].click();
    })()`
  });
  await new Promise(r => setTimeout(r, 1500));

  console.log('--- STEP 5: Click Sessions tab ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const tab = document.getElementById('session-sidebar-tab-sessions');
      if (tab) tab.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 1500));

  console.log('--- STEP 6: Click remote session row ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const row = document.querySelector('.session-row, [class*="session-tree-row"]:not([class*="group"])');
      if (row) row.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 2000));

  console.log('--- ALL ERRORS CAUGHT DURING INTERACTIONS ---');
  console.log(JSON.stringify(errors, null, 2));

  ws.close();
  try { chromeProc.kill(); } catch {}
  process.exit(0);
}

testClicks().catch(console.error);
