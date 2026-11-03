import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});

const { DeviceRuntimeRegistry } = await jiti.import("./registry.ts");
const { sendMeshMessage, cancelRealtimeWait } = await jiti.import("../gateway/mesh-router.ts");
const { createMeshExtension } = await jiti.import("../gateway/mesh-extension.ts");
const { SshRemoteDeviceRuntime } = await jiti.import("./ssh-remote-runtime.ts");

// Mock ActiveSession that records events and can simulate replies
class MockActiveSession {
  constructor(sessionId, deviceId) {
    this.sessionId = sessionId;
    this.deviceId = deviceId;
    this.sent = [];
    this.steered = [];
    this.listeners = new Set();
    this.running = false;
    this.closed = false;
  }

  isAlive() {
    return !this.closed;
  }

  isRunning() {
    return this.running;
  }

  async send(msg) {
    this.sent.push(msg);
    return { type: "response", success: true };
  }

  async steer(msg) {
    this.steered.push(msg);
    return { type: "response", success: true };
  }

  async abort() {}

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  close() {
    this.closed = true;
  }
}

// Mock DeviceRuntime
class MockTestRuntime {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.sessions = new Map();
  }

  addSession(sessionId) {
    const s = new MockActiveSession(sessionId, this.deviceId);
    this.sessions.set(sessionId, s);
    return s;
  }

  async getActiveSession(id) {
    return this.sessions.get(id);
  }

  async resumeSession(id, _sessionFile, _opts) {
    let s = this.sessions.get(id);
    if (!s) {
      s = this.addSession(id);
    }
    return s;
  }

  async createSession(opts) {
    const newId = `new-sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const s = this.addSession(newId);
    return {
      sessionId: newId,
      activeSession: s,
    };
  }

  async listSessions() {
    return Array.from(this.sessions.keys()).map((id) => ({
      id,
      cwd: `/home/${this.deviceId}/workspace`,
    }));
  }

  async sendPrompt(id, msg) {
    const s = await this.resumeSession(id);
    await s.send({ type: "prompt", message: msg });
    return { success: true, sessionId: id };
  }
}

function setupTestEnvironment() {
  DeviceRuntimeRegistry.resetInstance();
  const registry = DeviceRuntimeRegistry.getInstance();

  const wshomeRuntime = new MockTestRuntime("wshome");
  const wsnasRuntime = new MockTestRuntime("wsnas");

  const wshomeSession1 = wshomeRuntime.addSession("sess-home-1");
  const wshomeSession2 = wshomeRuntime.addSession("sess-home-2");

  const wsnasSession1 = wsnasRuntime.addSession("sess-nas-1");
  const wsnasSession2 = wsnasRuntime.addSession("sess-nas-2");

  registry.registerRuntime("wshome", wshomeRuntime);
  registry.registerRuntime("wsnas", wsnasRuntime);

  return {
    wshomeRuntime,
    wsnasRuntime,
    wshomeSession1,
    wshomeSession2,
    wsnasSession1,
    wsnasSession2,
  };
}

test("send_session_message tool registration and metadata", async () => {
  const ext = createMeshExtension("wshome", "sess-home-1", "/home/windsing/pi-web");
  let registeredTools = [];
  const fakePi = {
    registerTool: (tool) => {
      registeredTools.push(tool);
    },
  };
  await ext.factory(fakePi);

  const sendTool = registeredTools.find((t) => t.name === "send_session_message");
  assert.ok(sendTool, "send_session_message tool is registered");
  assert.equal(sendTool.label, "Send Session Message");
});

test("Direction 1: wshome -> wsnas in all 4 modes (steer, followup, silent, realtime)", async (t) => {
  const env = setupTestEnvironment();
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  const { wsnasSession1 } = env;

  // 1. Mode: steer (idle target)
  wsnasSession1.running = false;
  const resSteerIdle = await sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "reindex database immediately",
    mode: "steer",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
    },
  });
  assert.equal(resSteerIdle.success, true);
  assert.equal(resSteerIdle.targetDeviceId, "wsnas");
  assert.equal(resSteerIdle.targetSessionId, "sess-nas-1");
  assert.equal(wsnasSession1.sent.length, 1);
  assert.equal(wsnasSession1.sent[0].type, "prompt");
  assert.equal(wsnasSession1.sent[0].streamingBehavior, "steer");
  assert.ok(wsnasSession1.sent[0].message.includes("reindex database immediately"));
  assert.ok(wsnasSession1.sent[0].message.includes("[From sess-home-1.wshome][mode: steer]"));

  // 2. Mode: steer (running target)
  wsnasSession1.running = true;
  const resSteerRunning = await sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "stop current loop and switch context",
    mode: "steer",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
    },
  });
  assert.equal(resSteerRunning.success, true);
  assert.equal(wsnasSession1.steered.length, 1);
  assert.ok(wsnasSession1.steered[0].includes("stop current loop and switch context"));
  assert.ok(wsnasSession1.steered[0].includes("[From sess-home-1.wshome][mode: steer]"));

  // 3. Mode: followup
  wsnasSession1.running = false;
  wsnasSession1.sent = [];
  const resFollowup = await sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "when done please compress backup files",
    mode: "followup",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
    },
  });
  assert.equal(resFollowup.success, true);
  assert.equal(wsnasSession1.sent.length, 1);
  assert.equal(wsnasSession1.sent[0].type, "prompt");
  assert.equal(wsnasSession1.sent[0].streamingBehavior, "followUp");
  assert.ok(wsnasSession1.sent[0].message.includes("when done please compress backup files"));
  assert.ok(wsnasSession1.sent[0].message.includes("[From sess-home-1.wshome][mode: followup]"));

  // 4. Mode: silent (idle target)
  wsnasSession1.running = false;
  wsnasSession1.sent = [];
  const resSilentIdle = await sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "sync completed successfully notice",
    mode: "silent",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
    },
  });
  assert.equal(resSilentIdle.success, true);
  assert.equal(wsnasSession1.sent.length, 1);
  assert.equal(wsnasSession1.sent[0].type, "prompt");
  assert.equal(wsnasSession1.sent[0].streamingBehavior, undefined);
  assert.ok(wsnasSession1.sent[0].message.includes("sync completed successfully notice"));
  assert.ok(wsnasSession1.sent[0].message.includes("[From sess-home-1.wshome][mode: silent]"));

  // 5. Mode: silent (running target)
  wsnasSession1.running = true;
  wsnasSession1.sent = [];
  const resSilentRunning = await sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "background progress ping",
    mode: "silent",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
    },
  });
  assert.equal(resSilentRunning.success, true);
  assert.equal(wsnasSession1.sent.length, 1);
  assert.equal(wsnasSession1.sent[0].type, "follow_up");
  assert.ok(wsnasSession1.sent[0].message.includes("background progress ping"));

  // 6. Mode: realtime (replies via send_session_message)
  wsnasSession1.running = false;
  wsnasSession1.sent = [];
  const realtimePromise = sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "what is the current disk usage on /data?",
    mode: "realtime",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
    },
  });

  // Target session processes and replies back using send_session_message
  setTimeout(async () => {
    await sendMeshMessage({
      target: "sess-home-1.wshome",
      message: "/data is 42% used (1.2TB free)",
      mode: "realtime",
      currentDeviceId: "wsnas",
      senderContext: {
        deviceId: "wsnas",
        sessionId: "sess-nas-1",
        cwd: "/volume1/code",
      },
    });
  }, 10);

  const realtimeRes = await realtimePromise;
  assert.equal(realtimeRes.success, true);
  assert.equal(realtimeRes.targetDeviceId, "wsnas");
  assert.equal(realtimeRes.reply, "/data is 42% used (1.2TB free)");
});

test("Direction 2: wsnas -> wshome in all 4 modes (steer, followup, silent, realtime)", async (t) => {
  const env = setupTestEnvironment();
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  const { wshomeSession1 } = env;

  // 1. Mode: steer (idle target on wshome)
  wshomeSession1.running = false;
  const resSteer = await sendMeshMessage({
    target: "sess-home-1.wshome",
    message: "build failed on nas, inspect git commit on wshome",
    mode: "steer",
    currentDeviceId: "wsnas",
    senderContext: {
      deviceId: "wsnas",
      sessionId: "sess-nas-1",
      cwd: "/volume1/code",
    },
  });
  assert.equal(resSteer.success, true);
  assert.equal(resSteer.targetDeviceId, "wshome");
  assert.equal(resSteer.targetSessionId, "sess-home-1");
  assert.equal(wshomeSession1.sent.length, 1);
  assert.equal(wshomeSession1.sent[0].type, "prompt");
  assert.equal(wshomeSession1.sent[0].streamingBehavior, "steer");
  assert.ok(wshomeSession1.sent[0].message.includes("[From sess-nas-1.wsnas][mode: steer]"));

  // 2. Mode: followup
  wshomeSession1.sent = [];
  const resFollowup = await sendMeshMessage({
    target: "sess-home-1.wshome",
    message: "update documentation when tests pass",
    mode: "followup",
    currentDeviceId: "wsnas",
    senderContext: {
      deviceId: "wsnas",
      sessionId: "sess-nas-1",
      cwd: "/volume1/code",
    },
  });
  assert.equal(resFollowup.success, true);
  assert.equal(wshomeSession1.sent.length, 1);
  assert.equal(wshomeSession1.sent[0].type, "prompt");
  assert.equal(wshomeSession1.sent[0].streamingBehavior, "followUp");
  assert.ok(wshomeSession1.sent[0].message.includes("[From sess-nas-1.wsnas][mode: followup]"));

  // 3. Mode: silent (running target on wshome)
  wshomeSession1.running = true;
  wshomeSession1.sent = [];
  const resSilent = await sendMeshMessage({
    target: "sess-home-1.wshome",
    message: "daemon status report",
    mode: "silent",
    currentDeviceId: "wsnas",
    senderContext: {
      deviceId: "wsnas",
      sessionId: "sess-nas-1",
      cwd: "/volume1/code",
    },
  });
  assert.equal(resSilent.success, true);
  assert.equal(wshomeSession1.sent.length, 1);
  assert.equal(wshomeSession1.sent[0].type, "follow_up");
  assert.ok(wshomeSession1.sent[0].message.includes("daemon status report"));

  // 4. Mode: realtime (replies via send_session_message)
  wshomeSession1.running = false;
  wshomeSession1.sent = [];
  const realtimePromise = sendMeshMessage({
    target: "sess-home-1.wshome",
    message: "run build and check exit code",
    mode: "realtime",
    currentDeviceId: "wsnas",
    senderContext: {
      deviceId: "wsnas",
      sessionId: "sess-nas-1",
      cwd: "/volume1/code",
    },
  });

  setTimeout(async () => {
    await sendMeshMessage({
      target: "sess-nas-1.wsnas",
      message: "Build completed with exit code 0.",
      mode: "realtime",
      currentDeviceId: "wshome",
      senderContext: {
        deviceId: "wshome",
        sessionId: "sess-home-1",
        cwd: "D:/proj/pi-web",
      },
    });
  }, 10);

  const realtimeRes = await realtimePromise;
  assert.equal(realtimeRes.success, true);
  assert.equal(realtimeRes.targetDeviceId, "wshome");
  assert.equal(realtimeRes.reply, "Build completed with exit code 0.");
});

test("Two-way conversational reply flow: wshome asks wsnas, wsnas replies using send_session_message", async (t) => {
  const env = setupTestEnvironment();
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  // Step 1: wshome initiates realtime request to wsnas
  const waitPromise = sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "Please calculate hash of release archive",
    mode: "realtime",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
    },
  });

  // Step 2: wsnas replies back to wshome using send_session_message
  // Wait a tick for early registration to land
  await new Promise((r) => setTimeout(r, 20));

  const replyDeliverResult = await sendMeshMessage({
    target: "sess-home-1.wshome",
    message: "The sha256 checksum is a1b2c3d4e5f67890",
    mode: "realtime", // Even if wsnas specifies realtime, anti-deadlock prevents wsnas from blocking
    currentDeviceId: "wsnas",
    senderContext: {
      deviceId: "wsnas",
      sessionId: "sess-nas-1",
      cwd: "/volume1/code",
    },
  });

  const homeResult = await waitPromise;
  assert.equal(homeResult.success, true);
  assert.equal(homeResult.reply, "The sha256 checksum is a1b2c3d4e5f67890");

  // The replying side (wsnas) should return immediately without blocking (Anti-Deadlock rule)
  assert.ok(replyDeliverResult, "reply message completed promptly without hanging");
  assert.equal(replyDeliverResult.reply, "Delivered reply to waiting peer session.");

  // Deduplication & Single Delivery verification:
  // wsnas receives the initial prompt from wshome exactly once.
  assert.equal(env.wsnasSession1.sent.length, 1, "Target session (wsnas) received the initial prompt exactly once");
  assert.ok(env.wsnasSession1.sent[0].message.includes("Please calculate hash of release archive"));

  // wshome session must NOT receive any prompt injection:
  // - wsnas did not inject a prompt into wshome (resolved wait directly)
  // - wshome's wait completion did not inject a fallback prompt into wshome (returned via tool result)
  assert.equal(env.wshomeSession1.sent.length, 0, "Waiter session (wshome) received 0 injected prompts (no duplicate delivery)");
});

test("Deduplication & Single Delivery: wsnas reply to pending wshome leaves wshome prompt queue empty", async (t) => {
  const env = setupTestEnvironment();
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  const { wshomeSession1, wsnasSession1 } = env;

  // 1. wshome initiates realtime tool call to wsnas
  const waitPromise = sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "Check disk usage on /volume1",
    mode: "realtime",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
      isToolCall: true,
    },
  });

  await new Promise((r) => setTimeout(r, 20));

  // 2. wsnas replies via send_session_message
  const replyResult = await sendMeshMessage({
    target: "sess-home-1.wshome",
    message: "/volume1 is at 42% capacity",
    mode: "realtime",
    currentDeviceId: "wsnas",
    senderContext: {
      deviceId: "wsnas",
      sessionId: "sess-nas-1",
      cwd: "/volume1/code",
      isToolCall: true,
    },
  });

  // wsnas should return immediately without waiting
  assert.equal(replyResult.success, true);
  assert.equal(replyResult.reply, "Delivered reply to waiting peer session.");

  // wshome's realtime wait resolves with wsnas's answer
  const homeResult = await waitPromise;
  assert.equal(homeResult.success, true);
  assert.equal(homeResult.reply, "/volume1 is at 42% capacity");

  // Verify: target wsnas received only 1 prompt, and waiter wshome received 0 prompts
  assert.equal(wsnasSession1.sent.length, 1);
  assert.ok(wsnasSession1.sent[0].message.includes("Check disk usage on /volume1"));
  assert.equal(wshomeSession1.sent.length, 0, "No prompt was injected into wshome session");
});

test("Fallback prompt delivery: when isToolCall is false, reply IS injected into sender active session", async (t) => {
  const env = setupTestEnvironment();
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  const { wshomeSession1 } = env;

  // wshome initiates realtime request with isToolCall: false (non-tool caller background scenario)
  const waitPromise = sendMeshMessage({
    target: "sess-nas-1.wsnas",
    message: "Trigger background sync",
    mode: "realtime",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
      isToolCall: false, // Explicitly non-tool caller
    },
  });

  await new Promise((r) => setTimeout(r, 20));

  await sendMeshMessage({
    target: "sess-home-1.wshome",
    message: "Sync completed with 0 errors",
    mode: "realtime",
    currentDeviceId: "wsnas",
    senderContext: {
      deviceId: "wsnas",
      sessionId: "sess-nas-1",
      cwd: "/volume1/code",
      isToolCall: true,
    },
  });

  const homeResult = await waitPromise;
  assert.equal(homeResult.success, true);
  assert.equal(homeResult.reply, "Sync completed with 0 errors");

  // Because isToolCall was false, fallback prompt WAS injected into wshomeSession1
  assert.equal(wshomeSession1.sent.length, 1, "Fallback prompt was injected for non-tool caller");
  assert.ok(wshomeSession1.sent[0].message.startsWith("[From sess-nas-1.wsnas][mode: realtime]:\nSync completed with 0 errors"));
});

test("Tool execution in mesh-extension returns full reply in toolResult content with zero prompt injection", async (t) => {
  const env = setupTestEnvironment();
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  const { wshomeSession1, wsnasSession1 } = env;

  const ext = createMeshExtension("wshome", "sess-home-1", "D:/proj/pi-web");
  let registeredTools = [];
  const fakePi = {
    registerTool: (tool) => {
      registeredTools.push(tool);
    },
  };
  await ext.factory(fakePi);
  const sendTool = registeredTools.find((t) => t.name === "send_session_message");
  assert.ok(sendTool);

  // Execute tool from wshome
  const toolExecPromise = sendTool.execute("call_1", {
    target: "sess-nas-1.wsnas",
    message: "What is the git status?",
    mode: "realtime",
  });

  await new Promise((r) => setTimeout(r, 20));

  // wsnas replies via send_session_message
  await sendMeshMessage({
    target: "sess-home-1.wshome",
    message: "Branch is up to date, working tree clean",
    mode: "realtime",
    currentDeviceId: "wsnas",
    senderContext: {
      deviceId: "wsnas",
      sessionId: "sess-nas-1",
      cwd: "/volume1/code",
      isToolCall: true,
    },
  });

  const toolResult = await toolExecPromise;
  assert.ok(toolResult.content[0].text.includes("[Response received from sess-nas-1 on host \"wsnas\"]:\nBranch is up to date, working tree clean"));
  assert.equal(toolResult.isError, undefined);

  // Confirm zero prompt injection on wshome: only toolResult receives the reply
  assert.equal(wshomeSession1.sent.length, 0, "No duplicate prompt was injected into wshome session");
  // Confirm target received prompt exactly once
  assert.equal(wsnasSession1.sent.length, 1);
});

test("Target new session creation: wshome -> wsnas:/volume1/project", async (t) => {
  const env = setupTestEnvironment();
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  const res = await sendMeshMessage({
    target: "wsnas:/volume1/project",
    message: "Init new project session on remote NAS",
    mode: "followup",
    currentDeviceId: "wshome",
    senderContext: {
      deviceId: "wshome",
      sessionId: "sess-home-1",
      cwd: "D:/proj/pi-web",
    },
  });

  assert.equal(res.success, true);
  assert.equal(res.targetDeviceId, "wsnas");
  assert.equal(res.createdNewSession, true);
  assert.ok(res.targetSessionId.startsWith("new-sess-"));
});
