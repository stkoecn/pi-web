import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});

const { unpackMeshOutboundFrame } = await jiti.import("./ssh-remote-runtime.ts");
const { DeviceRuntimeRegistry, getDeviceRuntime } = await jiti.import("./registry.ts");
const { sendMeshMessage, cancelRealtimeWait } = await jiti.import("../gateway/mesh-router.ts");
const { getCanonicalHostId } = await jiti.import("../gateway/host-identity.ts");

// ----------------------------------------------------------------------------
// 对抗场景 1：高并发与重入防护（Anti-Deadlock）
// ----------------------------------------------------------------------------
test("对抗场景 1：高并发与重入防护 (Anti-Deadlock) - 双方互发实时消息触发 isReplyToPending 免等并立即释放", async (t) => {
  DeviceRuntimeRegistry.resetInstance();
  t.after(() => {
    cancelRealtimeWait();
    DeviceRuntimeRegistry.resetInstance();
  });

  const canonicalLocal = getCanonicalHostId();

  // 模拟两个活跃会话的 RPC mock
  class MockSession {
    constructor(sessionId, deviceId) {
      this.sessionId = sessionId;
      this.deviceId = deviceId;
      this.listeners = new Set();
      this.sent = [];
    }
    isAlive() { return true; }
    isRunning() { return false; }
    async send(msg) {
      this.sent.push(msg);
      return { success: true };
    }
    async steer(msg) {
      this.sent.push({ type: "steer", message: msg });
      return { success: true };
    }
    async abort() {}
    onMessage(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    close() {}
  }

  const sessionA = new MockSession("sess-alice", "host-a");
  const sessionB = new MockSession("sess-bob", "host-b");

  // 为 host-a 与 host-b 模拟 DeviceRuntime
  const runtimeA = {
    deviceId: "host-a",
    async getActiveSession(id) { return id === "sess-alice" ? sessionA : undefined; },
    async resumeSession(id) { return sessionA; },
    async createSession() { return { sessionId: "sess-alice", activeSession: sessionA }; },
    async listSessions() { return [{ id: "sess-alice", cwd: "/workspace/a" }]; },
    async sendPrompt(id, msg) { return { success: true, sessionId: id }; },
  };

  const runtimeB = {
    deviceId: "host-b",
    async getActiveSession(id) { return id === "sess-bob" ? sessionB : undefined; },
    async resumeSession(id) { return sessionB; },
    async createSession() { return { sessionId: "sess-bob", activeSession: sessionB }; },
    async listSessions() { return [{ id: "sess-bob", cwd: "/workspace/b" }]; },
    async sendPrompt(id, msg) { return { success: true, sessionId: id }; },
  };

  const registry = DeviceRuntimeRegistry.getInstance();
  registry.registerRuntime("host-a", runtimeA);
  registry.registerRuntime("host-b", runtimeB);

  // 1. Session A 向 Session B 发起 realtime 消息并进入等待
  const promiseAtoB = sendMeshMessage({
    target: "sess-bob.host-b",
    message: "Alice: Question for Bob?",
    mode: "realtime",
    currentDeviceId: "host-a",
    senderContext: {
      deviceId: "host-a",
      sessionId: "sess-alice",
      cwd: "/workspace/a",
    },
  });

  // 短暂让出执行片，确保 A 的 pendingReplies 记录已经挂载 (0ms early registration)
  await new Promise((r) => setTimeout(r, 10));

  // 2. 此时 Session B 向 Session A 发送回复/实时消息（相互呼叫，死锁对抗测试）
  // 必须命中 isReplyToPending 机制：
  // - Session B 发现 Session A 正在挂起等待来自 B 的回复
  // - B 的发送调用解除 A 的挂起状态
  // - B 自身绝对不再进入 300 秒等待，而是立即返回 reply: "Delivered reply to waiting peer session."
  const startB = Date.now();
  const resultBtoA = await sendMeshMessage({
    target: "sess-alice.host-a",
    message: "Bob: Answer for Alice!",
    mode: "realtime",
    currentDeviceId: "host-b",
    senderContext: {
      deviceId: "host-b",
      sessionId: "sess-bob",
      cwd: "/workspace/b",
    },
  });
  const durationB = Date.now() - startB;

  assert.ok(durationB < 2000, `Bob's reply should return immediately without waiting 300s, took ${durationB}ms`);
  assert.equal(resultBtoA.success, true);
  assert.equal(resultBtoA.reply, "Delivered reply to waiting peer session.");

  // 3. 同时验证 Session A 也被唤醒并拿到了 Bob 发送的消息内容
  const resultAtoB = await Promise.race([
    promiseAtoB,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Alice timed out waiting for Bob")), 2000)),
  ]);

  assert.equal(resultAtoB.success, true);
  assert.equal(resultAtoB.reply, "Bob: Answer for Alice!");

  // 验证无双重投递 (Deduplication & Single Delivery):
  // Bob 收到 Alice 的初始 prompt (1 次)
  assert.equal(sessionB.sent.length, 1, "Bob received initial prompt exactly once");
  // Alice 挂起等待被 resolve，没有被强插任何多余 prompt (0 次)
  assert.equal(sessionA.sent.length, 0, "Alice received 0 injected prompts (no duplicate delivery)");
});

// ----------------------------------------------------------------------------
// 对抗场景 2：数据解包兼容性对抗
// ----------------------------------------------------------------------------
test("对抗场景 2：数据解包兼容性对抗 (Data Unpacking Robustness) - 各种异构/变形帧 100% 提取", () => {
  // Case 2.1: 标准顶层帧
  const frame1 = {
    type: "mesh_outbound",
    target: "agent@device1",
    message: "simple message",
    mode: "realtime",
  };
  const res1 = unpackMeshOutboundFrame(frame1);
  assert.equal(res1.isMeshOutbound, true);
  assert.equal(res1.target, "agent@device1");
  assert.equal(res1.message, "simple message");
  assert.equal(res1.mode, "realtime");

  // Case 2.2: 顶层包裹 data，data 内部嵌套 type: mesh_outbound
  const frame2 = {
    data: {
      type: "mesh_outbound",
      target: "worker@cluster2",
      message: "payload inside data object",
      mode: "steer",
      sender: { sessionId: "s-nested", host: "d-nested", cwd: "/srv/app" },
    },
  };
  const res2 = unpackMeshOutboundFrame(frame2);
  assert.equal(res2.isMeshOutbound, true);
  assert.equal(res2.target, "worker@cluster2");
  assert.equal(res2.message, "payload inside data object");
  assert.equal(res2.mode, "steer");
  assert.equal(res2.senderContext?.sessionId, "s-nested");
  assert.equal(res2.senderContext?.deviceId, "d-nested");
  assert.equal(res2.senderContext?.cwd, "/srv/app");

  // Case 2.3: 顶层 type 为 mesh_outbound，字段分散在 data 中
  const frame3 = {
    type: "mesh_outbound",
    data: {
      target: "db@remote",
      message: "distributed payload",
      mode: "followup",
    },
  };
  const res3 = unpackMeshOutboundFrame(frame3);
  assert.equal(res3.isMeshOutbound, true);
  assert.equal(res3.target, "db@remote");
  assert.equal(res3.message, "distributed payload");
  assert.equal(res3.mode, "followup");

  // Case 2.4: 顶层和 data 混合混合存在，顶层优先或回退
  const frame4 = {
    type: "mesh_outbound",
    target: "top@target",
    data: {
      message: "message from inner data",
      mode: "silent",
    },
  };
  const res4 = unpackMeshOutboundFrame(frame4);
  assert.equal(res4.isMeshOutbound, true);
  assert.equal(res4.target, "top@target");
  assert.equal(res4.message, "message from inner data");
  assert.equal(res4.mode, "silent");

  // Case 2.5: 变形残缺帧与非法帧抗压，必须安全返回 isMeshOutbound: false，绝不崩溃抛出异常
  const malformedCases = [
    null,
    undefined,
    "",
    12345,
    [],
    {},
    { type: "prompt" },
    { type: "mesh_outbound" }, // 缺 target 和 message
    { type: "mesh_outbound", target: "target_only" }, // 缺 message
    { type: "mesh_outbound", message: "message_only" }, // 缺 target
    { type: "mesh_outbound", data: { foo: "bar" } }, // data 中无有效 target & message
    { data: { type: "other_event", target: "t", message: "m" } }, // 非 mesh_outbound
  ];

  for (const [idx, malformed] of malformedCases.entries()) {
    const res = unpackMeshOutboundFrame(malformed);
    assert.equal(res.isMeshOutbound, false, `malformed case #${idx} should return isMeshOutbound: false`);
  }
});

// ----------------------------------------------------------------------------
// 对抗场景 3：异常与故障注入（Fault Injection & Boundaries）
// ----------------------------------------------------------------------------
test("对抗场景 3：异常与故障注入 (Fault Injection) - 错误优雅抛出且不导致服务崩溃", async (t) => {
  DeviceRuntimeRegistry.resetInstance();
  t.after(() => {
    DeviceRuntimeRegistry.resetInstance();
  });

  // 3.1 请求不存在的远程设备
  await assert.rejects(
    async () => {
      await getDeviceRuntime("non-existent-device-99999");
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Device runtime not found for device: non-existent-device-99999/);
      return true;
    },
    "请求不存在的远程设备应该优雅抛出异常",
  );

  // 3.2 发送网关消息时传入非法/无法解析的目标地址
  const invalidTargets = [
    "",
    "invalid-format-without-at-or-dot",
    "sess@",
    "   ",
  ];
  for (const badTarget of invalidTargets) {
    await assert.rejects(
      async () => {
        await sendMeshMessage({
          target: badTarget,
          message: "test message",
        });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("Invalid mesh target format") ||
          err.message.includes("Self-targeting loop prevented")
        );
        return true;
      },
      `非法 target "${badTarget}" 应该优雅抛出 Invalid mesh target 异常`,
    );
  }

  // 3.3 尝试向自己本会话发送消息（自环回路防护）
  await assert.rejects(
    async () => {
      await sendMeshMessage({
        target: "sess-self.localhost",
        message: "hello me",
        currentDeviceId: "localhost",
        senderContext: {
          deviceId: "localhost",
          sessionId: "sess-self",
        },
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Self-targeting loop prevented/);
      return true;
    },
    "向自身相同会话发消息应被自环防护机制拦截",
  );
});

// ----------------------------------------------------------------------------
// 对抗场景 4：在线环境测试（9564 端口探测，严禁触碰 9566）
// ----------------------------------------------------------------------------
test("对抗场景 4：在线环境测试 (Online Health & Availability) - 探测 9564 端口接口可用性", async (t) => {
  const PORT = 9564;
  const baseUrl = `http://127.0.0.1:${PORT}`;

  let isPortAlive = false;
  try {
    const probe = await fetch(`${baseUrl}/api/models`, { signal: AbortSignal.timeout(1000) });
    isPortAlive = true;
    assert.ok(probe.status === 200 || probe.status === 401, "/api/models 正常响应 (200 或 需认证 401)");
  } catch {
    t.skip("9564 端口未在本地监听，跳过在线集成探测");
    return;
  }

  // 4.2 探测 /api/mesh/roster
  const rosterRes = await fetch(`${baseUrl}/api/mesh/roster`);
  assert.ok(rosterRes.status === 200 || rosterRes.status === 401, "/api/mesh/roster 正常响应");
});
