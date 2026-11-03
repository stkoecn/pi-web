import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});

const {
  SshRemoteDeviceRuntime,
  SshRemoteActiveSession,
  unpackMeshOutboundFrame,
} = await jiti.import("./ssh-remote-runtime.ts");
const { DeviceRuntimeRegistry, getDeviceRuntime } = await jiti.import("./registry.ts");

test("unpackMeshOutboundFrame handles both top-level and nested data payloads", () => {
  // 1. Top-level structure
  const topLevel = {
    type: "mesh_outbound",
    target: "sess123@deviceA",
    message: "hello from top level",
    mode: "steer",
    senderContext: {
      sessionId: "s-orig",
      deviceId: "dev-orig",
      cwd: "/home/user/project",
      prompt: "do something",
    },
  };
  const res1 = unpackMeshOutboundFrame(topLevel);
  assert.equal(res1.isMeshOutbound, true);
  assert.equal(res1.target, "sess123@deviceA");
  assert.equal(res1.message, "hello from top level");
  assert.equal(res1.mode, "steer");
  assert.equal(res1.senderContext?.sessionId, "s-orig");
  assert.equal(res1.senderContext?.deviceId, "dev-orig");
  assert.equal(res1.senderContext?.cwd, "/home/user/project");

  // 2. Nested data structure { data: { type: 'mesh_outbound', target, message, ... } }
  const nested = {
    type: "mesh_outbound",
    data: {
      target: "sess456@deviceB",
      message: "hello from nested data",
      mode: "followup",
      sender: {
        sessionId: "s-nested",
        host: "dev-nested",
        cwd: "/remote/dir",
      },
    },
  };
  const res2 = unpackMeshOutboundFrame(nested);
  assert.equal(res2.isMeshOutbound, true);
  assert.equal(res2.target, "sess456@deviceB");
  assert.equal(res2.message, "hello from nested data");
  assert.equal(res2.mode, "followup");
  assert.equal(res2.senderContext?.sessionId, "s-nested");
  assert.equal(res2.senderContext?.deviceId, "dev-nested");
  assert.equal(res2.senderContext?.cwd, "/remote/dir");

  // 3. Nested type inside data
  const nestedType = {
    data: {
      type: "mesh_outbound",
      target: "sess789@deviceC",
      message: "hello from nested type",
    },
  };
  const res3 = unpackMeshOutboundFrame(nestedType);
  assert.equal(res3.isMeshOutbound, true);
  assert.equal(res3.target, "sess789@deviceC");
  assert.equal(res3.message, "hello from nested type");

  // 4. Invalid or non-mesh messages
  assert.equal(unpackMeshOutboundFrame(null).isMeshOutbound, false);
  assert.equal(unpackMeshOutboundFrame({ type: "prompt" }).isMeshOutbound, false);
  assert.equal(unpackMeshOutboundFrame({ type: "mesh_outbound" }).isMeshOutbound, false); // missing target/message
});

test("SshRemoteActiveSession send, steer, and running behavior", async () => {
  let sentMessages = [];
  let isClosedVal = false;

  const mockSession = {
    sessionId: "mock-sess-1",
    deviceId: "remote-box",
    runActive: false,
    pendingUiRequestIds: new Set(),
    state: {
      cwd: "/remote/home/project",
      sessionFile: "/remote/home/.pi/agent/sessions/mock-sess-1.jsonl",
    },
    listeners: new Set(),
    channel: {
      isClosed: () => isClosedVal,
      send: (msg) => {
        sentMessages.push(msg);
        // If message has id, simulate RPC response
        if (msg.id) {
          for (const listener of mockSession.listeners) {
            listener({ type: "response", id: msg.id, success: true });
          }
        }
      },
      abort: () => {
        sentMessages.push({ type: "aborted" });
      },
    },
  };

  const active = new SshRemoteActiveSession(mockSession);

  assert.equal(active.sessionId, "mock-sess-1");
  assert.equal(active.cwd, "/remote/home/project");
  assert.equal(active.sessionFile, "/remote/home/.pi/agent/sessions/mock-sess-1.jsonl");
  assert.equal(active.isAlive(), true);
  assert.equal(active.isRunning(), false);

  // Test send command
  const res = await active.send({ type: "custom_cmd", foo: "bar" });
  assert.equal(res.success, true);
  assert.equal(sentMessages[0].type, "custom_cmd");
  assert.equal(sentMessages[0].foo, "bar");

  // Test steer when idle -> sends prompt with streamingBehavior: 'steer'
  await active.steer("steer text while idle");
  const idleSteerMsg = sentMessages.find((m) => m.streamingBehavior === "steer");
  assert.ok(idleSteerMsg, "sent prompt with streamingBehavior: steer when idle");
  assert.equal(idleSteerMsg.type, "prompt");
  assert.equal(idleSteerMsg.message, "steer text while idle");

  // Test steer when running -> sends { type: 'steer' }
  // Simulate running by setting runActive
  mockSession.runActive = true;
  assert.equal(active.isRunning(), true);
  await active.steer("steer text while running");
  const runningSteerMsg = sentMessages.find((m) => m.type === "steer");
  assert.ok(runningSteerMsg, "sent steer message when running");
  assert.equal(runningSteerMsg.message, "steer text while running");

  // Test abort
  await active.abort();
  assert.ok(sentMessages.some((m) => m.type === "aborted"));

  // Test onMessage unsubscribe
  let received = [];
  const unsub = active.onMessage((m) => received.push(m));
  for (const listener of mockSession.listeners) {
    listener({ foo: 123 });
  }
  assert.equal(received.length, 1);
  unsub();
  for (const listener of mockSession.listeners) {
    listener({ foo: 456 });
  }
  assert.equal(received.length, 1);
});

test("DeviceRuntimeRegistry - auto-creates and caches SshRemoteDeviceRuntime from devices.json", async (t) => {
  DeviceRuntimeRegistry.resetInstance();
  t.after(() => {
    DeviceRuntimeRegistry.resetInstance();
  });

  // Mock devices.json in test if needed, or check existing resolution
  // We can write a temp devices.json or test with configured devices
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-devices-test-"));
  const prevCwd = process.cwd();
  process.chdir(root);

  fs.writeFileSync(
    join(root, "devices.json"),
    JSON.stringify([
      {
        id: "server-alpha",
        host: "10.0.0.1",
        port: 22,
        username: "testuser",
      },
    ]),
  );

  t.after(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runtimeAlpha = await getDeviceRuntime("server-alpha");
  assert.ok(runtimeAlpha instanceof SshRemoteDeviceRuntime);
  assert.equal(runtimeAlpha.deviceId, "server-alpha");

  // Caching: second call returns identical instance
  const runtimeAlpha2 = await getDeviceRuntime("server-alpha");
  assert.equal(runtimeAlpha, runtimeAlpha2, "cached instance returned");

  // Unknown device throws
  await assert.rejects(
    async () => {
      await getDeviceRuntime("unknown-remote-device");
    },
    { message: /Device runtime not found for device: unknown-remote-device/ },
  );
});

test("SshRemoteDeviceRuntime steerSession delegates appropriately based on running state", async () => {
  const runtime = new SshRemoteDeviceRuntime("test-remote-box");

  let sent = [];
  let isRunningState = false;

  const mockActive = {
    sessionId: "sess-test",
    isRunning: () => isRunningState,
    send: async (msg) => {
      sent.push(msg);
      return { success: true };
    },
    abort: async () => {},
  };

  // Mock getActiveSession
  runtime.getActiveSession = async () => mockActive;

  // 1. Idle session
  isRunningState = false;
  await runtime.steerSession("sess-test", "wake up and redirect");
  assert.equal(sent[0].type, "prompt");
  assert.equal(sent[0].streamingBehavior, "steer");
  assert.equal(sent[0].message, "wake up and redirect");

  // 2. Running session
  isRunningState = true;
  sent = [];
  await runtime.steerSession("sess-test", "steer running task");
  assert.equal(sent[0].type, "steer");
  assert.equal(sent[0].message, "steer running task");
});

test("SshRemoteDeviceRuntime sendPrompt and abortSession interact with active session", async () => {
  const runtime = new SshRemoteDeviceRuntime("test-remote-box-2");
  let sent = [];
  let aborted = false;

  const mockActive = {
    sessionId: "sess-prompt-test",
    isRunning: () => false,
    send: async (msg) => {
      sent.push(msg);
      return { echoed: msg };
    },
    abort: async () => {
      aborted = true;
    },
  };

  runtime.getActiveSession = async () => mockActive;

  const promptRes = await runtime.sendPrompt("sess-prompt-test", "hello remote", {
    streamingBehavior: "steer",
  });
  assert.equal(promptRes.success, true);
  assert.equal(promptRes.sessionId, "sess-prompt-test");
  assert.equal(sent[0].type, "prompt");
  assert.equal(sent[0].message, "hello remote");
  assert.equal(sent[0].streamingBehavior, "steer");

  await runtime.abortSession("sess-prompt-test");
  assert.equal(aborted, true);
});

