import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const root = mkdtempSync(join(tmpdir(), 'pi-web-devices-join-'));
const file = join(root, 'devices.json');
writeFileSync(file, '[]', 'utf8');

const gateway = {
  configPath: () => file,
  registry: { list: () => [] },
  listConfiguredDevices: () => [],
  syncDevices: async () => ({ connected: [], removed: [], unchanged: [] }),
};
globalThis.__piWebGateway = gateway;

const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() } });
const { GET, POST } = await jiti.import('./route.ts');

after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

test('GET /api/devices/join returns a pairing command and token when called without token', async () => {
  const req = new Request('http://192.168.1.8:9564/api/devices/join', {
    headers: { Accept: 'application/json' },
  });
  const res = await GET(req);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.ok(data.token, 'should return a token');
  assert.ok(data.command.startsWith('curl -sSL'), 'command should start with curl');
  assert.ok(data.command.includes(data.token), 'command should contain the token');
  assert.ok(data.command.includes('192.168.1.8:9564'), 'command should contain host');
});

test('GET /api/devices/join correctly resolves reverse proxy domain and port', async () => {
  // Simulate request behind HTTPS reverse proxy with custom domain
  const req = new Request('http://internal-node:9564/api/devices/join', {
    headers: {
      Accept: 'application/json',
      'X-Forwarded-Host': 'pi.mycompany.org:8443, proxy2.internal',
      'X-Forwarded-Proto': 'https, http',
    },
  });
  const res = await GET(req);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.ok(data.joinUrl.startsWith('https://pi.mycompany.org:8443/api/devices/join?token='));
  assert.ok(data.command.includes('https://pi.mycompany.org:8443/api/devices/join?token='));

  // When requesting script, gateway SSH host must be the pure domain without HTTP port
  const scriptReq = new Request(`http://internal-node:9564/api/devices/join?token=${data.token}`, {
    headers: {
      'X-Forwarded-Host': 'pi.mycompany.org:8443',
      'X-Forwarded-Proto': 'https',
    },
  });
  const scriptRes = await GET(scriptReq);
  const scriptText = await scriptRes.text();
  assert.ok(scriptText.includes('GATEWAY_ORIGIN="https://pi.mycompany.org:8443"'));
  assert.ok(scriptText.includes('GATEWAY_HOST="pi.mycompany.org"'), 'SSH host must not include HTTP port');
  assert.ok(scriptText.includes('GATEWAY_SSH_PORT="22222"'));
});

test('GET /api/devices/join with token returns the shell pairing script', async () => {
  // First get a token
  const initReq = new Request('http://192.168.1.8:9564/api/devices/join', {
    headers: { Accept: 'application/json' },
  });
  const initRes = await GET(initReq);
  const { token } = await initRes.json();

  // Then fetch the bash script
  const scriptReq = new Request(`http://192.168.1.8:9564/api/devices/join?token=${token}`);
  const scriptRes = await GET(scriptReq);
  assert.equal(scriptRes.status, 200);
  assert.equal(scriptRes.headers.get('content-type'), 'text/x-shellscript; charset=utf-8');

  const scriptText = await scriptRes.text();
  assert.ok(scriptText.includes('#!/usr/bin/env bash'));
  assert.ok(scriptText.includes('ssh-ed25519'));
  assert.ok(scriptText.includes(token));
  assert.ok(scriptText.includes('ssh -N -R 0:127.0.0.1:'));
});

test('POST /api/devices/join validates token and handles registration', async () => {
  // First get a token
  const initReq = new Request('http://192.168.1.8:9564/api/devices/join', {
    headers: { Accept: 'application/json' },
  });
  const initRes = await GET(initReq);
  const { token } = await initRes.json();

  // Test invalid token first
  const invalidReq = new Request('http://192.168.1.8:9564/api/devices/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: 'non-existent-token',
      id: 'test-node-1',
      username: 'root',
    }),
  });
  const invalidRes = await POST(invalidReq);
  assert.equal(invalidRes.status, 400);

  // Test valid token consumption
  const validReq = new Request('http://192.168.1.8:9564/api/devices/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      id: 'test-node-1',
      name: 'Test Node 1',
      username: 'nodeuser',
      port: 22,
    }),
  });
  const validRes = await POST(validReq);
  assert.equal(validRes.status, 200);
  const data = await validRes.json();
  assert.equal(data.success, true);
  assert.equal(data.deviceId, 'test-node-1');

  // Verify token cannot be re-used (consumed)
  const reusedRes = await POST(validReq);
  assert.equal(reusedRes.status, 400);
});
