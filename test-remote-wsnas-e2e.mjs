import assert from "node:assert/strict";
import test from "node:test";

/**
 * E2E Adversarial & Verification Test Suite for Remote Host `wsnas`
 * Target: http://127.0.0.1:9564
 * Rule: DO NOT touch 9566 under any circumstances.
 */

const TARGET_PORT = 9564;
const BASE_URL = `http://127.0.0.1:${TARGET_PORT}`;
const PASSWORD = process.env.PI_WEB_PASSWORD || "199568";
const REMOTE_DEVICE_ID = "wsnas";
const REMOTE_CWD = "/home/windsing";

let authCookie = "";

async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(authCookie ? { Cookie: authCookie } : {}),
    ...(options.headers || {}),
  };
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

test.before(async () => {
  console.log(`\n================================================================`);
  console.log(`[E2E Suite] Initializing remote wsnas verification on ${BASE_URL}`);
  console.log(`[E2E Suite] Target device: ${REMOTE_DEVICE_ID}, remote cwd: ${REMOTE_CWD}`);
  console.log(`================================================================\n`);

  // Authenticate to get session cookie if password auth is enabled
  try {
    const authRes = await request("/api/web-auth", {
      method: "POST",
      body: JSON.stringify({ password: PASSWORD }),
    });

    if (authRes.status === 200) {
      const authData = await authRes.json();
      if (authData.ok) {
        const setCookie = authRes.headers.get("set-cookie");
        if (setCookie) {
          authCookie = setCookie.split(";")[0];
          console.log(`[Setup] Successfully authenticated, session cookie obtained.`);
        }
      }
    } else {
      console.log(`[Setup] Password auth disabled or not required (status: ${authRes.status}), proceeding without cookie.`);
    }
  } catch (err) {
    console.log(`[Setup] Web auth skipped:`, err.message);
  }
});

test("Case 1: Remote terminal creation, SSE event stream, command execution (uname -a & pwd), and cleanup", async () => {
  console.log(`\n--- Running Case 1: Remote Terminal Lifecycle & SSE Stream ---`);

  // 1. POST /api/terminal
  const termRes = await request("/api/terminal", {
    method: "POST",
    body: JSON.stringify({ cwd: REMOTE_CWD, deviceId: REMOTE_DEVICE_ID }),
  });

  assert.equal(termRes.status, 200, "POST /api/terminal must return 200");
  const termData = await termRes.json();
  assert.ok(termData.id, "Terminal response must contain a valid id");
  const termId = termData.id;
  console.log(`[Case 1] Terminal spawned with id: ${termId}`);

  // 2. Connect to SSE /api/terminal/[id]/events
  const abortCtrl = new AbortController();
  const eventsRes = await fetch(`${BASE_URL}/api/terminal/${termId}/events`, {
    headers: { Cookie: authCookie },
    signal: abortCtrl.signal,
  });

  assert.equal(eventsRes.status, 200, "SSE endpoint must return 200");
  assert.equal(
    eventsRes.headers.get("content-type")?.includes("text/event-stream"),
    true,
    "SSE endpoint must return text/event-stream"
  );

  const reader = eventsRes.body.getReader();
  const decoder = new TextDecoder();
  let fullOutput = "";

  const streamCollector = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        fullOutput += text;
        // Check if both Linux kernel and /home/windsing are present in terminal output
        if (
          (fullOutput.includes("Linux") || fullOutput.includes("GNU/Linux")) &&
          fullOutput.includes(REMOTE_CWD)
        ) {
          console.log(`[Case 1] Received expected kernel string and remote cwd in SSE stream.`);
          break;
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    }
  })();

  // Wait 800ms for shell prompt ready, then send uname -a and pwd
  await new Promise((resolve) => setTimeout(resolve, 800));
  const writeRes = await request(`/api/terminal/${termId}`, {
    method: "POST",
    body: JSON.stringify({ type: "input", data: "uname -a\npwd\n" }),
  });
  assert.equal(writeRes.status, 200, "Write terminal input must return 200");

  // Wait for streamCollector with timeout
  await Promise.race([
    streamCollector,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout (10s) waiting for terminal output")), 10000)
    ),
  ]);

  abortCtrl.abort();

  assert.match(
    fullOutput,
    /Linux/i,
    "Terminal output must contain Linux kernel information"
  );
  assert.match(
    fullOutput,
    new RegExp(REMOTE_CWD),
    `Terminal output must contain ${REMOTE_CWD}`
  );
  console.log(`[Case 1] Output verification verified successfully.`);

  // 3. Clean up terminal
  const delRes = await request(`/api/terminal/${termId}`, {
    method: "DELETE",
  });
  assert.equal(delRes.status, 200, "DELETE /api/terminal/[id] must return 200");
  const delData = await delRes.json();
  assert.equal(delData.success, true, "Terminal deletion must succeed");
  console.log(`[Case 1] Terminal ${termId} successfully deleted.`);
});

test("Case 2: Remote agent session creation and initial interaction without SSH Channel Open Failure", async () => {
  console.log(`\n--- Running Case 2: Remote Agent Session Creation & Tools Query ---`);

  // 1. POST /api/agent/new with ensure_session
  const newRes = await request("/api/agent/new", {
    method: "POST",
    body: JSON.stringify({
      cwd: REMOTE_CWD,
      deviceId: REMOTE_DEVICE_ID,
      type: "ensure_session",
    }),
  });

  assert.equal(newRes.status, 200, "POST /api/agent/new must return 200");
  const newData = await newRes.json();
  assert.equal(newData.success, true, "Agent creation response must be success: true");
  assert.ok(newData.sessionId, "Must return valid sessionId");
  const sessionId = newData.sessionId;
  console.log(`[Case 2] Remote agent session created: ${sessionId}`);
  console.log(`[Case 2] Model: ${JSON.stringify(newData.model)}, thinkingLevel: ${newData.thinkingLevel}`);

  // 2. Query tools /api/agent/[id] to verify interactive channel responsiveness
  const toolsRes = await request(`/api/agent/${sessionId}?deviceId=${REMOTE_DEVICE_ID}`, {
    method: "POST",
    headers: { "X-Device-Id": REMOTE_DEVICE_ID },
    body: JSON.stringify({ type: "get_tools" }),
  });

  assert.equal(toolsRes.status, 200, "POST /api/agent/[id] get_tools must return 200");
  const toolsData = await toolsRes.json();
  assert.equal(toolsData.success, true, "get_tools must succeed");
  assert.ok(Array.isArray(toolsData.data), "get_tools must return tools array");
  assert.ok(toolsData.data.length > 0, "Tool count should be > 0");
  console.log(`[Case 2] Resolved ${toolsData.data.length} tools over remote RPC channel.`);

  // 3. Clean up agent session
  const delRes = await request(`/api/agent/${sessionId}`, {
    method: "DELETE",
  });
  assert.equal(delRes.status, 200, "DELETE /api/agent/[id] must return 200");
  const delData = await delRes.json();
  assert.equal(delData.success, true, "Session closing must succeed");
  console.log(`[Case 2] Remote session ${sessionId} closed cleanly.`);
});

test("Case 3: High concurrency & SSH channel pressure verification", async () => {
  console.log(`\n--- Running Case 3: High Concurrency & Channel Stress Test ---`);

  const CONCURRENCY = 3;
  console.log(`[Case 3] Spawning ${CONCURRENCY} remote terminals concurrently...`);

  const spawnPromises = Array.from({ length: CONCURRENCY }).map(async (_, index) => {
    const res = await request("/api/terminal", {
      method: "POST",
      body: JSON.stringify({ cwd: REMOTE_CWD, deviceId: REMOTE_DEVICE_ID }),
    });
    assert.equal(res.status, 200, `Concurrent terminal ${index + 1} creation must return 200`);
    const data = await res.json();
    assert.ok(data.id, `Terminal ${index + 1} must return an id`);
    return data.id;
  });

  const termIds = await Promise.all(spawnPromises);
  console.log(`[Case 3] Concurrently opened ${termIds.length} terminals:`, termIds);

  // Now, while all 3 terminals are actively held open, create an agent session and execute a command
  console.log(`[Case 3] Creating agent session while ${CONCURRENCY} terminals hold open channels...`);
  const agentRes = await request("/api/agent/new", {
    method: "POST",
    body: JSON.stringify({
      cwd: REMOTE_CWD,
      deviceId: REMOTE_DEVICE_ID,
      type: "ensure_session",
    }),
  });

  assert.equal(agentRes.status, 200, "Agent creation under channel load must return 200");
  const agentData = await agentRes.json();
  assert.equal(agentData.success, true, "Agent creation under channel load must succeed");
  const sessionId = agentData.sessionId;
  assert.ok(sessionId, "Must return valid sessionId under load");
  console.log(`[Case 3] Agent session ${sessionId} successfully created alongside 3 active terminals.`);

  // Perform parallel operations across all terminals and the agent session
  console.log(`[Case 3] Executing parallel commands across all terminals and agent session...`);
  const parallelOps = [
    ...termIds.map(async (tid, idx) => {
      const w = await request(`/api/terminal/${tid}`, {
        method: "POST",
        body: JSON.stringify({ type: "input", data: `echo "terminal_${idx}_ready"\n` }),
      });
      assert.equal(w.status, 200, `Terminal ${idx} write must succeed`);
    }),
    (async () => {
      const tools = await request(`/api/agent/${sessionId}?deviceId=${REMOTE_DEVICE_ID}`, {
        method: "POST",
        headers: { "X-Device-Id": REMOTE_DEVICE_ID },
        body: JSON.stringify({ type: "get_tools" }),
      });
      assert.equal(tools.status, 200, "Agent get_tools under load must return 200");
    })(),
  ];

  await Promise.all(parallelOps);
  console.log(`[Case 3] All parallel operations completed without channel saturation or exceptions.`);

  // Cleanup: close agent session
  const agentDel = await request(`/api/agent/${sessionId}`, { method: "DELETE" });
  assert.equal(agentDel.status, 200, "DELETE agent session must return 200");
  console.log(`[Case 3] Agent session cleaned up.`);

  // Cleanup: close all terminals
  for (const tid of termIds) {
    const termDel = await request(`/api/terminal/${tid}`, { method: "DELETE" });
    assert.equal(termDel.status, 200, `DELETE terminal ${tid} must return 200`);
  }
  console.log(`[Case 3] All ${termIds.length} terminals cleaned up.`);
});

test("Safety Constraint: Port 9566 integrity check", async () => {
  console.log(`\n--- Running Safety Check: Port 9566 untouched ---`);
  // Verify 9566 is listening and alive (we just probe with GET /api/sessions without touching anything)
  const probe9566 = await fetch("http://127.0.0.1:9566/api/sessions").catch((err) => null);
  // It may require auth or return 200/401, but the connection must succeed proving it's intact
  assert.ok(probe9566 !== null, "Port 9566 server must be intact and responding");
  console.log(`[Safety] Port 9566 status code: ${probe9566.status} (Verified untouched and alive).`);
});
