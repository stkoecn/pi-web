import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

async function run() {
  const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const port = 9333;
  const tempDir = path.join(os.tmpdir(), `cdp_test_${Date.now()}`);
  
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempDir}`,
    'http://127.0.0.1:9564'
  ], { detached: true });

  await new Promise(r => setTimeout(r, 2000));

  const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  const tabs = await listRes.json();
  const pageTab = tabs.find((t: any) => t.type === 'page');
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(pageTab.webSocketDebuggerUrl);

  await new Promise((res) => ws.on('open', res));
  let id = 1;
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

  // Wait for page hydration with polling
  for (let i = 0; i < 30; i++) {
    const check: any = await send('Runtime.evaluate', {
      expression: 'Boolean(document.querySelector(\'button[title*="Current Device"]\'))',
      returnByValue: true
    });
    if (check.result?.value) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // Check initial state (localhost)
  let evalRes: any = await send('Runtime.evaluate', {
    expression: `(() => {
      const devBtn = document.querySelector('button[title*="Current Device"]');
      const projects = Array.from(document.querySelectorAll('.session-group-header-title')).map(e => e.textContent.trim()).filter(Boolean);
      return {
        devText: devBtn ? devBtn.textContent.trim() : null,
        projects: projects.slice(0, 5)
      };
    })()`,
    returnByValue: true
  });
  console.log('1. Initial (localhost):', evalRes.result?.value);

  // Click DeviceSelector and switch to fuckip-us
  await send('Runtime.evaluate', {
    expression: `(() => {
      const devBtn = document.querySelector('button[title*="Current Device"]');
      if (devBtn) devBtn.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 600));

  const clickRes: any = await send('Runtime.evaluate', {
    expression: `(() => {
      const fuckip = document.querySelector('[data-device-item="fuckip-us"]');
      if (fuckip) {
        fuckip.click();
        return true;
      }
      return false;
    })()`,
    returnByValue: true
  });
  console.log('Clicked fuckip-us item in dropdown:', clickRes.result?.value);

  // Wait 3s for remote fetch & DOM update
  await new Promise(r => setTimeout(r, 3000));

  evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const devBtn = document.querySelector('button[title*="Current Device"]');
      const projects = Array.from(document.querySelectorAll('.session-group-header-title')).map(e => e.textContent.trim()).filter(Boolean);
      const sessions = Array.from(document.querySelectorAll('.session-row-title, [class*="session-title"]')).map(e => e.textContent.trim()).filter(Boolean);
      const picker = document.querySelector('[class*="worktree"], [class*="picker"]')?.textContent || '';
      return {
        url: window.location.href,
        devText: devBtn ? devBtn.textContent.trim() : null,
        projects: projects,
        sessions: sessions.slice(0, 5),
        pickerSnippet: picker.slice(0, 100)
      };
    })()`,
    returnByValue: true
  });
  console.log('2. After switching to fuckip-us:', evalRes.result?.value);

  // Switch to files tab if not on files
  await send('Runtime.evaluate', {
    expression: `(() => {
      const filesTab = document.getElementById('session-sidebar-tab-files');
      if (filesTab) filesTab.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 2000));

  evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const fileContainer = document.querySelector('.file-explorer, [class*="file-explorer"], [class*="tree"]');
      const nodes = Array.from(document.querySelectorAll('[data-path], [class*="file"], [class*="tree-node"]')).map(e => e.textContent.trim());
      const pickerText = document.querySelector('[class*="project-worktree"], [class*="picker"]')?.textContent || '';
      return {
        pickerText: pickerText.slice(0, 100),
        containerHTML: fileContainer ? fileContainer.outerHTML.slice(0, 500) : 'not found',
        nodesSnippet: nodes.slice(0, 15)
      };
    })()`,
    returnByValue: true
  });
  console.log('3. Files Tab on fuckip-us:', evalRes.result?.value);

  // Switch back to Local Host
  await send('Runtime.evaluate', {
    expression: `(() => {
      const devBtn = document.querySelector('button[title*="Current Device"]');
      if (devBtn) devBtn.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 600));

  await send('Runtime.evaluate', {
    expression: `(() => {
      const local = document.querySelector('[data-device-item="localhost"]');
      if (local) local.click();
    })()`
  });
  console.log('Clicked Local Host in dropdown');

  await new Promise(r => setTimeout(r, 2500));

  evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const devBtn = document.querySelector('button[title*="Current Device"]');
      const projects = Array.from(document.querySelectorAll('.session-group-header-title')).map(e => e.textContent.trim()).filter(Boolean);
      return {
        url: window.location.href,
        devText: devBtn ? devBtn.textContent.trim() : null,
        projects: projects.slice(0, 5)
      };
    })()`,
    returnByValue: true
  });
  console.log('4. Back to Local Host:', evalRes.result?.value);

  ws.close();
  try { chromeProc.kill(); } catch {}
  process.exit(0);
}

run().catch(console.error);
