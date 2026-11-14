/**
 * The MCP connection probe a REMOTE device runs on itself, over its SSH channel:
 * the same bounded "connect one mcp.json entry once and list what it offers"
 * the local test performs (`lib/mcp-test.ts`), for a server whose command
 * resolves and whose ports exist on that machine.
 *
 * The script is plain JS (the device's node runs it), delivered base64-encoded
 * in `PIWEB_MCP_PROBE` with the RAW entry — `!command` values resolve here, on
 * the device, where they are meant to run. One `__PIWEB_RESULT__` JSON line
 * goes to stdout; the gateway masks it against the entry's secrets before the
 * browser sees anything.
 */
export const MCP_TEST_DEVICE_SCRIPT = `
const { spawn } = require('child_process');

const REQUEST_TIMEOUT_MS = 15000;
const DEADLINE_MS = 20000;
const VALUE_TIMEOUT_MS = 10000;
const STDERR_TAIL_CHARS = 2000;

function out(result) {
  try { process.stdout.write('__PIWEB_RESULT__' + JSON.stringify(result)); } catch {}
  process.exit(0);
}

function runShellCommand(command) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, VALUE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', () => { clearTimeout(timer); resolve(stdout.trim()); });
  });
}

// A value that starts with '!' is a shell command whose stdout is the value
// (the SDK's own convention, resolved here where it is meant to run).
async function resolveValue(value) {
  if (typeof value !== 'string' || !value.startsWith('!')) return value;
  const resolved = await runShellCommand(value.slice(1));
  return resolved === undefined ? value : resolved;
}

async function resolveAll(values) {
  const entries = Object.entries(values || {});
  const resolved = await Promise.all(entries.map(async ([key, value]) => [key, await resolveValue(value)]));
  return Object.fromEntries(resolved);
}

function httpJson(url, body, headers, timeoutMs) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function probeHttp(entry, deadline) {
  const headers = await resolveAll(entry.headers);
  const startedAt = Date.now();
  const send = async (payload) => {
    const response = await httpJson(entry.url, payload, headers, Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
    if (!response.ok) {
      const err = new Error('HTTP ' + response.status + (response.statusText ? ' ' + response.statusText : ''));
      err.httpStatus = response.status;
      throw err;
    }
    const text = await response.text();
    // A streamable answer may be SSE: take the first data: payload that parses.
    for (const line of text.split('\\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payloadText = trimmed.slice(5).trim();
      if (!payloadText || payloadText === '[DONE]') continue;
      try { return JSON.parse(payloadText); } catch {}
    }
    return JSON.parse(text);
  };
  try {
    const init = await send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'pi-web-mcp-test', version: '1.0.0' },
      },
    });
    if (init.error) throw new Error(init.error.message || 'initialize failed');
    try { await send({ jsonrpc: '2.0', method: 'notifications/initialized' }); } catch {}
    const listed = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    if (listed.error) throw new Error(listed.error.message || 'tools/list failed');
    const tools = Array.isArray(listed.result && listed.result.tools) ? listed.result.tools : [];
    return {
      state: 'connected',
      tools,
      toolCount: tools.length,
      serverInfo: init.result && init.result.serverInfo ? init.result.serverInfo : undefined,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const status = error.httpStatus;
    if (status === 401 || status === 403) return { state: 'needs-auth', error: 'HTTP ' + status, durationMs: Date.now() - startedAt };
    return { state: 'failed', error: (error && error.message) || String(error), durationMs: Date.now() - startedAt };
  }
}

function probeStdio(entry, deadline) {
  return new Promise(async (resolve) => {
    const startedAt = Date.now();
    let child;
    let stderrTail = '';
    let buffer = '';
    const pending = new Map();
    let nextId = 1;
    const finish = (result) => {
      try { if (child && child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { if (child) child.kill('SIGKILL'); } catch {}
      resolve(result);
    };
    const fail = (error) => finish({
      state: 'failed',
      error: (error && error.message) || String(error),
      ...(stderrTail ? { stderr: stderrTail.slice(-STDERR_TAIL_CHARS) } : {}),
      durationMs: Date.now() - startedAt,
    });
    try {
      const env = { ...(await resolveAll(entry.env)) };
      delete env.PI_WEB_PASSWORD;
      const command = await resolveValue(entry.command);
      const args = [];
      for (const value of entry.args || []) args.push(await resolveValue(value));
      child = spawn(command, args, {
        cwd: entry.cwd || undefined,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      return fail(error);
    }
    const timer = setTimeout(() => finish({
      state: 'failed',
      error: 'The server did not answer within ' + DEADLINE_MS + ' ms',
      timedOut: true,
      ...(stderrTail ? { stderr: stderrTail.slice(-STDERR_TAIL_CHARS) } : {}),
      durationMs: Date.now() - startedAt,
    }), Math.max(1, deadline - Date.now()));
    child.on('error', (error) => { clearTimeout(timer); fail(error); });
    // A server that exits at once makes the stdin writes fail with EPIPE; the
    // close handler below turns that into the honest "exited before answering".
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => { stderrTail += String(chunk); });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const pendingEntry = pending.get(message.id);
        if (pendingEntry) {
          pending.delete(message.id);
          clearTimeout(pendingEntry.timer);
          pendingEntry.resolve(message);
        }
      }
    });
    child.on('close', (code) => {
      if (pending.size > 0) {
        clearTimeout(timer);
        finish({ state: 'failed', error: 'The server exited with code ' + code + ' before answering', ...(stderrTail ? { stderr: stderrTail.slice(-STDERR_TAIL_CHARS) } : {}), durationMs: Date.now() - startedAt });
      }
    });
    const request = (method, params) => new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++;
      const requestTimer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(method + ' timed out'));
      }, Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
      pending.set(id, { resolve: resolveRequest, timer: requestTimer });
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); } catch {}
    });
    (async () => {
      try {
        const init = await request('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'pi-web-mcp-test', version: '1.0.0' },
        });
        if (init.error) throw new Error(init.error.message || 'initialize failed');
        try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n'); } catch {}
        const listed = await request('tools/list', {});
        if (listed.error) throw new Error(listed.error.message || 'tools/list failed');
        const tools = Array.isArray(listed.result && listed.result.tools) ? listed.result.tools : [];
        clearTimeout(timer);
        finish({
          state: 'connected',
          tools,
          toolCount: tools.length,
          serverInfo: init.result && init.result.serverInfo ? init.result.serverInfo : undefined,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        clearTimeout(timer);
        fail(error);
      }
    })();
  });
}

(async () => {
  try {
    const entry = JSON.parse(Buffer.from(process.env.PIWEB_MCP_PROBE || '', 'base64').toString('utf8'));
    const deadline = Date.now() + DEADLINE_MS;
    const result = entry.url ? await probeHttp(entry, deadline) : await probeStdio(entry, deadline);
    const tools = Array.isArray(result.tools) ? result.tools : [];
    out({
      ...result,
      tools: tools.slice(0, 500).map((tool) => ({
        name: String((tool && tool.name) || ''),
        ...(tool && tool.description ? { description: String(tool.description).split('\\n')[0] } : {}),
        readOnly: Boolean(tool && tool.annotations && tool.annotations.readOnlyHint),
        exposure: 'direct',
      })),
      toolCount: tools.length,
      testedAt: Date.now(),
    });
  } catch (error) {
    out({ state: 'failed', error: (error && error.message) || String(error), tools: [], toolCount: 0, testedAt: Date.now() });
  }
})();
`;
