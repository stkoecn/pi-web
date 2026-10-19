import { PiWebGatewayApp } from '../src/server/app';
import ssh2 from 'ssh2';
import crypto from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';

const { Server: SSHServerSim, Client: SSHClient } = ssh2;

function log(msg: string) {
  console.log(`[TEST] ${msg}`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`✅ ${msg}`);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runE2ETests() {
  const TEST_HTTP_PORT = 39150;
  const TEST_SSH_PORT = 29222;

  log('Starting Pi Web Gateway on test ports (HTTP: 39150, SSH: 29222)...');
  const app = new PiWebGatewayApp({
    httpPort: TEST_HTTP_PORT,
    sshPort: TEST_SSH_PORT,
  });

  const { httpPort, sshPort } = await app.start();
  assert(httpPort === TEST_HTTP_PORT, `HTTP server started on ${httpPort}`);
  assert(sshPort === TEST_SSH_PORT, `SSH server started on ${sshPort}`);

  try {
    // -------------------------------------------------------------
    // Test 1: Device Registry & HTTP API
    // -------------------------------------------------------------
    log('--- Test 1: Verifying Device Registry & REST API ---');
    const res1 = await fetch(`http://127.0.0.1:${httpPort}/api/devices`);
    const data1: any = await res1.json();
    assert(Array.isArray(data1.devices), 'GET /api/devices returned array');
    assert(data1.devices.some((d: any) => d.id === 'localhost'), 'Default localhost device exists');

    // -------------------------------------------------------------
    // Test 2: Localhost Driver File & Exec Operations
    // -------------------------------------------------------------
    log('--- Test 2: Verifying Localhost File & Exec Drivers ---');
    const testFilePath = `temp-test-${Date.now()}.txt`;
    const testContent = 'Hello Pi-Web SSH Gateway E2E';

    // Write file
    const writeRes = await fetch(`http://127.0.0.1:${httpPort}/api/devices/localhost/file?path=${testFilePath}`, {
      method: 'POST',
      body: testContent,
    });
    assert(writeRes.ok, 'Local file write succeeded');

    // Read file
    const readRes = await fetch(`http://127.0.0.1:${httpPort}/api/devices/localhost/file?path=${testFilePath}`);
    const readText = await readRes.text();
    assert(readText === testContent, `Local file read matched: "${readText}"`);

    // Clean up test file via exec
    const localDriver = app.registry.getDriver('localhost');
    await localDriver.exec(process.platform === 'win32' ? 'cmd.exe' : 'rm', [
      process.platform === 'win32' ? '/c' : '-f',
      process.platform === 'win32' ? `del ${testFilePath}` : testFilePath,
    ]);

    // -------------------------------------------------------------
    // Test 3: Passive Reverse SSH Tunnel Registration (ssh -NR)
    // -------------------------------------------------------------
    log('--- Test 3: Simulating Passive Reverse SSH Device Connection ---');
    const reverseDeviceClient = new SSHClient();

    const reverseConnected = new Promise<void>((resolve, reject) => {
      reverseDeviceClient.on('ready', () => {
        log('Reverse device connected to Gateway SSH port. Requesting tcpip-forward...');
        reverseDeviceClient.forwardIn('127.0.0.1', 0, (err, boundPort) => {
          if (err) return reject(err);
          log(`Reverse device forwardIn allocated port: ${boundPort}`);
          resolve();
        });
      });
      reverseDeviceClient.on('error', reject);
    });

    reverseDeviceClient.connect({
      host: '127.0.0.1',
      port: sshPort,
      username: 'node-reverse-pi',
      password: 'test-password',
    });

    await reverseConnected;
    await sleep(200);

    const resDevices = await fetch(`http://127.0.0.1:${httpPort}/api/devices`);
    const dataDevices: any = await resDevices.json();
    console.log('[DEBUG] Registered devices:', JSON.stringify(dataDevices.devices));
    const reverseDev = dataDevices.devices.find((d: any) => d.id === 'node-reverse-pi');
    assert(Boolean(reverseDev), 'Reverse tunnel device registered in device registry');
    assert(reverseDev.mode === 'reverse_tunnel', `Device mode is "${reverseDev.mode}"`);
    assert(reverseDev.status === 'online', 'Device status is "online"');
    assert(typeof reverseDev.boundPort === 'number', `Reverse tunnel has boundPort: ${reverseDev.boundPort}`);

    // -------------------------------------------------------------
    // Test 4: Active SSH Target Simulation & Connection Pool
    // -------------------------------------------------------------
    log('--- Test 4: Simulating Remote SSH Server & Active SSH Client Pool ---');
    const { privateKey: targetHostKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });

    const targetSSHServer = new SSHServerSim({ hostKeys: [targetHostKey] });
    const activeClientsSim = new Set<any>();
    targetSSHServer.on('connection', (c) => {
      activeClientsSim.add(c);
      c.on('authentication', (ctx) => ctx.accept());
      c.on('session', (accept) => {
        const session = accept();
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('Welcome to Simulated Remote VPS\r\n');
        });
        session.on('exec', (acceptExec, rejectExec, info) => {
          const stream = acceptExec();
          if (info.command.includes('uname')) {
            stream.write('Linux test-remote-vps 6.1.0\n');
          } else {
            stream.write(`Executed: ${info.command}\n`);
          }
          stream.exit(0);
          stream.end();
        });
      });
      c.on('close', () => activeClientsSim.delete(c));
    });

    const targetPort = await new Promise<number>((resolve) => {
      targetSSHServer.listen(0, '127.0.0.1', () => {
        resolve((targetSSHServer.address() as net.AddressInfo).port);
      });
    });
    log(`Simulated remote target SSH server listening on port ${targetPort}`);

    // Add active device via API
    const connectRes = await fetch(`http://127.0.0.1:${httpPort}/api/devices/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'vps-active-01',
        name: 'Simulated Cloud VPS',
        host: '127.0.0.1',
        port: targetPort,
        username: 'root',
        password: 'any',
      }),
    });
    assert(connectRes.ok, 'Active device connect request accepted');

    // Wait for SSH handshake and registry update
    await sleep(500);

    const activeDevCheck = await fetch(`http://127.0.0.1:${httpPort}/api/devices`);
    const activeData: any = await activeDevCheck.json();
    const activeDev = activeData.devices.find((d: any) => d.id === 'vps-active-01');
    assert(Boolean(activeDev), 'Active SSH device registered in registry');
    assert(activeDev.mode === 'active_ssh', `Active device mode is "${activeDev.mode}"`);
    assert(activeDev.status === 'online', 'Active device status is "online"');

    // Test remote command execution through SSH driver
    const activeDriver = app.registry.getDriver('vps-active-01');
    const execRes = await activeDriver.exec('uname', ['-a']);
    assert(execRes.stdout.includes('Linux test-remote-vps'), `Remote exec returned: ${execRes.stdout.trim()}`);

    // -------------------------------------------------------------
    // Test 5: WebSocket Interactive Terminal (PTY)
    // -------------------------------------------------------------
    log('--- Test 5: Verifying WebSocket Terminal Bridge ---');
    const wsUrl = `ws://127.0.0.1:${httpPort}/ws/terminal?deviceId=localhost`;
    const ws = new WebSocket(wsUrl);

    const terminalReceived = new Promise<string>((resolve, reject) => {
      let output = '';
      ws.on('open', () => {
        log('WebSocket terminal connected. Sending test command...');
        ws.send('echo E2E_TERM_SUCCESS\r\n');
      });
      ws.on('message', (data: Buffer) => {
        output += data.toString('utf8');
        if (output.includes('E2E_TERM_SUCCESS')) {
          resolve(output);
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error(`Terminal test timeout. Output so far: ${output}`)), 5000);
    });

    const termOutput = await terminalReceived;
    assert(termOutput.includes('E2E_TERM_SUCCESS'), 'Interactive terminal PTY echo received over WebSocket');
    ws.close();

    // -------------------------------------------------------------
    // Test 6: WebSocket Pi Agent RPC Stream Verification
    // -------------------------------------------------------------
    log('--- Test 6: Verifying WebSocket Pi Agent RPC Stream ---');
    const agentWsUrl = `ws://127.0.0.1:${httpPort}/ws/agent?deviceId=localhost`;
    const agentWs = new WebSocket(agentWsUrl);

    const rpcReceived = new Promise<any>((resolve, reject) => {
      agentWs.on('open', () => {
        log('WebSocket Agent RPC connected. Sending prompt...');
        agentWs.send(JSON.stringify({ type: 'prompt', message: 'ping e2e' }));
      });
      agentWs.on('message', (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          log(`Received RPC event from Pi: ${parsed.type}`);
          if (parsed.type) {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
      agentWs.on('error', reject);
      setTimeout(() => reject(new Error('Agent RPC timeout')), 8000);
    });

    const firstRpcEvent = await rpcReceived;
    assert(Boolean(firstRpcEvent.type), `Received valid RPC event type: "${firstRpcEvent.type}"`);
    agentWs.close();

    // -------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------
    log('--- Cleanup: Closing simulated clients and servers ---');
    reverseDeviceClient.end();
    for (const c of activeClientsSim) {
      try { c.end(); } catch {}
    }
    await new Promise(r => targetSSHServer.close(r));
    log('Simulated components closed cleanly.');
  } finally {
    log('Stopping Pi Web Gateway...');
    await app.stop();
    log('Gateway stopped.');
  }

  console.log('\n=======================================================');
  console.log('🎉 ALL 6 E2E TESTS PASSED SUCCESSFULLY!');
  console.log('=======================================================\n');
}

runE2ETests().catch((err) => {
  console.error('❌ E2E Verification failed:', err);
  process.exit(1);
});
