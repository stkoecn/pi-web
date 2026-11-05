import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const { getActiveMeshBridgePort } = await jiti.import("./mesh-reverse-bridge.ts");
const { buildMeshPromptHeader, sendMeshMessage } = await jiti.import("./mesh-router.ts");
const { unpackMeshOutboundFrame } = await jiti.import("../device-runtime/ssh-remote-runtime.ts");

test("Scenario 0: Reverse bridge port negotiation and retrieval", () => {
  // Default port is 29564 when no dynamic port has been bound
  assert.equal(getActiveMeshBridgePort("unknown-device"), 29564);

  // When dynamic port is registered on globalThis
  globalThis.__activeMeshBridgePorts = globalThis.__activeMeshBridgePorts || new Map();
  globalThis.__activeMeshBridgePorts.set("nas", 32145);
  assert.equal(getActiveMeshBridgePort("nas"), 32145);
  // Case insensitivity
  assert.equal(getActiveMeshBridgePort("NAS"), 32145);
});

test("Scenario 1: Host to Host prompt header and addressing", () => {
  const header = buildMeshPromptHeader("session-123.localhost", "realtime");
  assert.ok(header.includes("[From session-123.localhost]"));
  assert.ok(header.includes("realtime"));

  const followupHeader = buildMeshPromptHeader("session-456.localhost", "followup");
  assert.ok(followupHeader.includes("[From session-456.localhost]"));
  assert.ok(followupHeader.includes("followup"));
});

test("Scenario 2: Outbound frame unpacking preserves isToolCall flag", () => {
  // Test 1: frame without explicit isToolCall defaults to true (protecting caller from prompt deadlock)
  const unpacked1 = unpackMeshOutboundFrame({
    type: "mesh_outbound",
    target: "sess1.localhost",
    message: "Hello from remote",
    senderContext: {
      sessionId: "remote-sess",
      deviceId: "wsnas",
    },
  });
  assert.equal(unpacked1.isMeshOutbound, true);
  assert.equal(unpacked1.senderContext?.isToolCall, true);

  // Test 2: frame with explicit isToolCall false preserves false
  const unpacked2 = unpackMeshOutboundFrame({
    type: "mesh_outbound",
    target: "sess2.localhost",
    message: "Manual text prompt",
    senderContext: {
      sessionId: "remote-sess",
      deviceId: "wsnas",
      isToolCall: false,
    },
  });
  assert.equal(unpacked2.isMeshOutbound, true);
  assert.equal(unpacked2.senderContext?.isToolCall, false);
});

test("Scenario 3: Remote fallback text reply interceptor extracts target and message", async () => {
  const textWithReply = `I will now notify the coordinator.
:::mesh-reply[coordinator-sess.localhost]
Task on wsnas completed successfully with 0 errors.
:::
Standing by for further instructions.`;

  const match = textWithReply.match(/:::mesh-reply\[([^\]]+)\]\s*([\s\S]*?)\s*:::/);
  assert.ok(match, "Should match :::mesh-reply block");
  assert.equal(match[1], "coordinator-sess.localhost");
  assert.equal(match[2].trim(), "Task on wsnas completed successfully with 0 errors.");
});

test("Scenario 4: Cross-machine target routing validation", async () => {
  const res = await sendMeshMessage({
    target: "nonexistent-sess.nonexistent-device-xyz",
    message: "Ping",
    mode: "followup",
  });
  assert.equal(res.success, false);
  assert.ok(res.error?.includes("Cannot reach target device") || res.error?.includes("not found"));
});

test("Scenario 5: DeviceRuntimeRegistry dynamic discovery", async () => {
  const { DeviceRuntimeRegistry } = await jiti.import("../device-runtime/registry.ts");
  const registry = DeviceRuntimeRegistry.getInstance();

  // 1. Manually registering a remote runtime makes it discoverable
  const { SshRemoteDeviceRuntime } = await jiti.import("../device-runtime/ssh-remote-runtime.ts");
  registry.registerRuntime("wshome", new SshRemoteDeviceRuntime("wshome"));

  const resolved = await registry.getDeviceRuntime("wshome");
  assert.ok(resolved);
  assert.equal(resolved.deviceId, "wshome");
  assert.equal(resolved.isRemote, true);
});

