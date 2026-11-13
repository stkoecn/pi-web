import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const { sendMeshMessage, cancelRealtimeWait } = await jiti.import("./mesh-router.ts");
const { DeviceRuntimeRegistry } = await jiti.import("../device-runtime/registry.ts");

test("Mesh prompt header generation for each mode", async (t) => {
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  const capturedPrompts = [];
  const fakeSession = {
    isRunning() { return false; },
    isAlive() { return true; },
    async send(payload) {
      capturedPrompts.push(payload);
    },
    async steer(msg) {
      capturedPrompts.push({ type: "steer", message: msg });
    },
    onMessage() { return () => {}; },
  };

  const fakeRuntime = {
    deviceId: "host-mock",
    async getActiveSession(id) { return fakeSession; },
    async resumeSession(id) { return fakeSession; },
    async createSession() { return { sessionId: "sess-mock", activeSession: fakeSession }; },
    async listSessions() { return [{ id: "sess-mock", cwd: "/test" }]; },
    async sendPrompt(id, msg) {
      capturedPrompts.push({ type: "prompt", message: msg });
      return { success: true };
    },
  };

  const callerRuntime = {
    deviceId: "caller-host",
    async getActiveSession(id) { return fakeSession; },
    async resumeSession(id) { return fakeSession; },
    async createSession() { return { sessionId: "caller-sess", activeSession: fakeSession }; },
    async listSessions() { return [{ id: "caller-sess", cwd: "/caller" }]; },
    async sendPrompt(id, msg) { return { success: true }; },
  };

  const registry = DeviceRuntimeRegistry.getInstance();
  registry.registerRuntime("host-mock", fakeRuntime);
  registry.registerRuntime("caller-host", callerRuntime);

  // 1. Silent mode: must have [Notification only, do NOT reply] and MUST NOT have [reply by calling send_session_message]
  capturedPrompts.length = 0;
  await sendMeshMessage({
    target: "sess-mock.host-mock",
    message: "Sync complete notice.",
    mode: "silent",
    currentDeviceId: "caller-host",
    senderContext: {
      deviceId: "caller-host",
      sessionId: "caller-sess",
    },
  });
  assert.equal(capturedPrompts.length, 1);
  const silentMsg = capturedPrompts[0].message;
  assert.ok(silentMsg.startsWith("[From caller-sess.caller-host][mode: silent][Notification only, do NOT reply]:\n"));
  assert.ok(!silentMsg.includes("send_session_message"), "Silent mode must NOT instruct recipient to reply");
  assert.ok(silentMsg.includes("Sync complete notice."));

  // 2. Steer mode: Sender is NOT blocked, prioritize and reply by calling send_session_message
  capturedPrompts.length = 0;
  await sendMeshMessage({
    target: "sess-mock.host-mock",
    message: "Urgent fix needed.",
    mode: "steer",
    currentDeviceId: "caller-host",
    senderContext: {
      deviceId: "caller-host",
      sessionId: "caller-sess",
    },
  });
  assert.equal(capturedPrompts.length, 1);
  const steerMsg = capturedPrompts[0].message;
  assert.ok(steerMsg.startsWith('[From caller-sess.caller-host][mode: steer][Sender is NOT blocked. Please prioritize this request and reply by calling send_session_message to "caller-sess.caller-host"]:\n'));
  assert.ok(steerMsg.includes("Urgent fix needed."));

  // 3. Followup mode: Sender is NOT blocked, process after current work and reply by calling send_session_message
  capturedPrompts.length = 0;
  await sendMeshMessage({
    target: "sess-mock.host-mock",
    message: "Followup task queue.",
    mode: "followup",
    currentDeviceId: "caller-host",
    senderContext: {
      deviceId: "caller-host",
      sessionId: "caller-sess",
    },
  });
  assert.equal(capturedPrompts.length, 1);
  const followupMsg = capturedPrompts[0].message;
  assert.ok(followupMsg.startsWith('[From caller-sess.caller-host][mode: followup][Sender is NOT blocked. Process after current work and reply by calling send_session_message to "caller-sess.caller-host"]:\n'));
  assert.ok(followupMsg.includes("Followup task queue."));

  // 4. Realtime mode: Sender is blocked waiting, must reply by calling send_session_message, do NOT just output text
  capturedPrompts.length = 0;
  const realtimePromise = sendMeshMessage({
    target: "sess-mock.host-mock",
    message: "Realtime question.",
    mode: "realtime",
    currentDeviceId: "caller-host",
    senderContext: {
      deviceId: "caller-host",
      sessionId: "caller-sess",
    },
  });

  // Short delay to let dispatch occur
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(capturedPrompts.length, 1);
  const realtimeMsg = capturedPrompts[0].message;
  assert.ok(realtimeMsg.startsWith('[From caller-sess.caller-host][mode: realtime][Sender is blocked waiting for response. Sender unblocks on receiving any message, user action, or on timeout. Reply by calling send_session_message to "caller-sess.caller-host"]:\n'));
  assert.ok(realtimeMsg.includes("Realtime question."));

  // Peer replies back via sendMeshMessage
  await sendMeshMessage({
    target: "caller-sess.caller-host",
    message: "Realtime answer back.",
    mode: "realtime",
    currentDeviceId: "host-mock",
    senderContext: {
      deviceId: "host-mock",
      sessionId: "sess-mock",
    },
  });

  const rtResult = await realtimePromise;
  assert.equal(rtResult.reply, "Realtime answer back.");
});
