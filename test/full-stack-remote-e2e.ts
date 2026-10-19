import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE_URL = 'http://127.0.0.1:9564';

async function runTests() {
  console.log('====================================================');
  console.log('   PI-WEB FULL-STACK REMOTE E2E AUTOMATED TESTS     ');
  console.log('   Target URL:', BASE_URL);
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  async function check(name: string, fn: () => Promise<void>) {
    total++;
    process.stdout.write(`[Test ${total}] ${name}... `);
    try {
      await fn();
      console.log('PASSED \x1b[32m✔\x1b[0m');
      passed++;
    } catch (err: any) {
      console.log('FAILED \x1b[31m✘\x1b[0m');
      console.error('   Error:', err.message || err);
      throw err;
    }
  }

  // 1. Device Registry & Switching API
  await check('GET /api/devices returns device list with localhost & fuckip-us online', async () => {
    const res = await fetch(`${BASE_URL}/api/devices`);
    assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}`);
    const data = await res.json() as { devices: any[] };
    assert(Array.isArray(data.devices), 'devices must be an array');

    const localhost = data.devices.find((d: any) => d.id === 'localhost');
    assert(localhost, 'localhost device must exist');
    assert.strictEqual(localhost.status, 'online', 'localhost must be online');

    const fuckip = data.devices.find((d: any) => d.id === 'fuckip-us');
    assert(fuckip, 'fuckip-us device must exist');
    assert.strictEqual(fuckip.status, 'online', 'fuckip-us must be online');
    assert.strictEqual(fuckip.remoteAddr, '155.103.66.113:35683');
  });

  // 2. Remote Terminal PTY on fuckip-us
  let testSessionId = '';
  await check('POST /api/terminal creates remote PTY on fuckip-us', async () => {
    const res = await fetch(`${BASE_URL}/api/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'fuckip-us', cols: 80, rows: 24 }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { id: string };
    assert(data.id, 'Session id must be returned');
    testSessionId = data.id;
  });

  await check('SSE /api/terminal/[id]/events and /api/terminal/input execute remote shell command', async () => {
    const sseRes = await fetch(`${BASE_URL}/api/terminal/${testSessionId}/events`);
    assert.strictEqual(sseRes.status, 200);
    assert.strictEqual(sseRes.headers.get('content-type')?.includes('text/event-stream'), true);

    const reader = sseRes.body?.getReader();
    assert(reader, 'SSE body reader must exist');

    // Wait a brief moment then send command
    await new Promise(r => setTimeout(r, 600));

    await fetch(`${BASE_URL}/api/terminal/${testSessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'input', data: 'echo "__PI_E2E_CHECK__"\n' }),
    });

    let receivedOutput = '';
    const decoder = new TextDecoder();
    const startTime = Date.now();

    while (Date.now() - startTime < 8000) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      receivedOutput += text;
      if (receivedOutput.includes('__PI_E2E_CHECK__')) {
        break;
      }
    }

    reader.cancel();
    assert(receivedOutput.includes('__PI_E2E_CHECK__'), `Expected output to contain __PI_E2E_CHECK__, received: ${receivedOutput.slice(0, 300)}`);
  });

  // 3. Remote File Explorer & SFTP Read/Write
  await check('GET /api/files/etc?deviceId=fuckip-us lists remote directory entries', async () => {
    const res = await fetch(`${BASE_URL}/api/files/etc?deviceId=fuckip-us`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { entries: any[] };
    assert(Array.isArray(data.entries), 'entries must be an array');
    assert(data.entries.length > 5, 'etc directory should have more than 5 entries');
    const osRelease = data.entries.find((e: any) => e.name === 'os-release');
    assert(osRelease, 'etc/os-release must be present in directory listing');
  });

  await check('GET /api/files/etc/os-release?type=read&deviceId=fuckip-us reads remote file', async () => {
    const res = await fetch(`${BASE_URL}/api/files/etc/os-release?type=read&deviceId=fuckip-us`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { text: string; language: string };
    assert(data.text.includes('Debian GNU/Linux'), 'os-release must contain Debian GNU/Linux');
  });

  const testFilePayload = `pi-web-verification-token-${Date.now()}`;
  await check('PUT /api/files/tmp/pi-web-test.txt?deviceId=fuckip-us writes remote file via SFTP', async () => {
    const res = await fetch(`${BASE_URL}/api/files/tmp/pi-web-test.txt?deviceId=fuckip-us`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: testFilePayload,
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { success: boolean };
    assert.strictEqual(data.success, true);
  });

  await check('GET /api/files/tmp/pi-web-test.txt?type=read&deviceId=fuckip-us verifies written content', async () => {
    const res = await fetch(`${BASE_URL}/api/files/tmp/pi-web-test.txt?type=read&deviceId=fuckip-us`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { text: string };
    assert.strictEqual(data.text, testFilePayload);
  });

  // 4. Remote Git Management
  await check('GET /api/git/status?cwd=/root&deviceId=fuckip-us queries remote git status', async () => {
    const res = await fetch(`${BASE_URL}/api/git/status?cwd=/root&deviceId=fuckip-us`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { branch?: string; changes?: any[]; isGit?: boolean };
    assert(typeof data === 'object', 'git status must return an object');
  });

  await check('GET /api/git/diff?cwd=/root&path=/root&deviceId=fuckip-us queries remote git diff', async () => {
    const res = await fetch(`${BASE_URL}/api/git/diff?cwd=/root&path=/root&deviceId=fuckip-us`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { supported: boolean };
    assert(typeof data.supported === 'boolean');
  });

  // 5. Remote Session & Pi RPC
  await check('GET /api/sessions?deviceId=fuckip-us lists persisted sessions from remote machine', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions?deviceId=fuckip-us`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { sessions: any[] };
    assert(Array.isArray(data.sessions), 'sessions must be an array');
    assert(data.sessions.length > 0, 'fuckip-us should have existing session files');
    assert(data.sessions[0].id, 'session must have an id');
  });

  let remoteAgentSessionId = '';
  await check('POST /api/agent/new spawns live Pi RPC session on fuckip-us', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'fuckip-us', cwd: '/root' }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { id: string; model: any };
    assert(data.id, 'Remote session id must be returned');
    assert(data.model?.id, 'Model id must be returned from remote pi runtime');
    remoteAgentSessionId = data.id;
  });

  await check('POST /api/agent/[id] sends command to remote Pi session', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/${remoteAgentSessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state' }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { success: boolean };
    assert.strictEqual(data.success, true);
  });

  await check('DELETE /api/agent/[id] closes and tears down remote Pi session cleanly', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/${remoteAgentSessionId}`, {
      method: 'DELETE',
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { success: boolean; closed: boolean };
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.closed, true);
  });

  // 6. Reverse Tunnel Device Registration
  await check('Reverse SSH tunnel client registers dynamic device on port 22222', async () => {
    const { Client } = await import('ssh2');
    const tunnelClient = new Client();
    await new Promise<void>((resolve, reject) => {
      tunnelClient.on('ready', () => {
        tunnelClient.forwardIn('127.0.0.1', 0, async (err, port) => {
          if (err) return reject(err);
          try {
            const res = await fetch(`${BASE_URL}/api/devices`);
            const data = await res.json() as { devices: any[] };
            const revDevice = data.devices.find((d: any) => d.mode === 'reverse_tunnel');
            assert(revDevice, 'Reverse tunnel device must be registered in /api/devices');
            assert.strictEqual(revDevice.status, 'online');
            tunnelClient.end();
            resolve();
          } catch (e) {
            tunnelClient.end();
            reject(e);
          }
        });
      });
      tunnelClient.on('error', reject);
      tunnelClient.connect({
        host: '127.0.0.1',
        port: 22222,
        username: 'tunnel',
        password: 'tunnel_password',
      });
    });
  });

  console.log(`\n====================================================`);
  console.log(` ALL ${passed}/${total} E2E TESTS PASSED SUCCESSFULLY!`);
  console.log(`====================================================\n`);
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\nE2E Verification aborted with error:', err);
  process.exit(1);
});
