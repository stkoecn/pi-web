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

const { LOCAL_DEVICE_ID } = await jiti.import("../device-context.ts");
const { LocalDeviceRuntime, LocalActiveSession } = await jiti.import("./local-runtime.ts");
const { DeviceRuntimeRegistry, getDeviceRuntime } = await jiti.import("./registry.ts");

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-device-runtime-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;

  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  });

  return { root, agentDir };
}

test("DeviceRuntimeRegistry - resolves local runtime singleton and custom devices", async (t) => {
  DeviceRuntimeRegistry.resetInstance();
  t.after(() => {
    DeviceRuntimeRegistry.resetInstance();
  });

  const registry = DeviceRuntimeRegistry.getInstance();
  assert.equal(registry, DeviceRuntimeRegistry.getInstance(), "getInstance returns singleton");

  // Local device resolution
  const runtimeDefault = await getDeviceRuntime();
  const runtimeExplicitLocal = await getDeviceRuntime(LOCAL_DEVICE_ID);
  const runtimeLocalhost = await getDeviceRuntime("localhost");
  const runtimeLoopback = await getDeviceRuntime("127.0.0.1");

  assert.ok(runtimeDefault instanceof LocalDeviceRuntime, "default runtime is LocalDeviceRuntime");
  assert.equal(runtimeDefault.deviceId, LOCAL_DEVICE_ID);
  assert.equal(runtimeDefault, runtimeExplicitLocal, "LOCAL_DEVICE_ID returns same singleton instance");
  assert.equal(runtimeDefault, runtimeLocalhost, "localhost returns same singleton instance");
  assert.equal(runtimeDefault, runtimeLoopback, "127.0.0.1 returns same singleton instance");

  // Custom runtime registration
  const fakeCustomRuntime = {
    deviceId: "custom-box",
  };
  registry.registerRuntime("custom-box", fakeCustomRuntime);

  const resolvedCustom = await getDeviceRuntime("custom-box");
  assert.equal(resolvedCustom, fakeCustomRuntime, "resolves registered custom runtime");

  // Remote dynamic resolver hook
  const fakeRemoteRuntime = {
    deviceId: "remote-ssh-1",
  };
  registry.setRemoteRuntimeResolver(async (deviceId) => {
    if (deviceId === "remote-ssh-1") return fakeRemoteRuntime;
    return null;
  });

  const resolvedRemote = await getDeviceRuntime("remote-ssh-1");
  assert.equal(resolvedRemote, fakeRemoteRuntime, "remote resolver hook resolves dynamic device");

  await assert.rejects(
    async () => {
      await getDeviceRuntime("unregistered-device-id");
    },
    /Device runtime not found/,
    "throws on unknown device with no matching resolver",
  );

  // Unregister custom runtime
  const unreg = registry.unregisterRuntime("custom-box");
  assert.equal(unreg, true, "unregister returns true");
});

test("LocalDeviceRuntime - filesystem & terminal & execution capabilities", async (t) => {
  const { root } = fixture(t);
  const runtime = new LocalDeviceRuntime();

  // 1. getHomeDir
  const home = await runtime.getHomeDir();
  assert.ok(typeof home === "string" && home.length > 0, "getHomeDir returns non-empty string");

  // 2. writeFile & readFile
  const testFilePath = join(root, "sub", "test.txt");
  const testContent = "Hello Device Runtime!";
  await runtime.writeFile(testFilePath, testContent);

  const readBuffer = await runtime.readFile(testFilePath);
  assert.equal(readBuffer.toString("utf8"), testContent, "readFile returns matching Buffer");

  // 3. browseDir
  fs.mkdirSync(join(root, "sub1"), { recursive: true });
  fs.mkdirSync(join(root, "sub2"), { recursive: true });
  const browseRes = await runtime.browseDir(root);
  assert.ok(browseRes.path, "browseDir has path");
  assert.ok(Array.isArray(browseRes.directories), "browseDir has directories array");
  const dirNames = browseRes.directories.map((d) => d.name);
  assert.ok(dirNames.includes("sub1"), "browseDir includes sub1");
  assert.ok(dirNames.includes("sub2"), "browseDir includes sub2");

  // 4. exec
  const execRes = await runtime.exec(process.execPath, ["-e", "console.log('device-runtime-exec')"]);
  assert.equal(execRes.exitCode, 0, "exec exitCode is 0");
  assert.ok(execRes.stdout.includes("device-runtime-exec"), "exec stdout includes printed message");

  // 5. createTerminal
  const term = await runtime.createTerminal({ cwd: root });
  assert.ok(term.sessionId, "terminal session has sessionId");
  assert.ok(typeof term.write === "function", "terminal has write function");
  assert.ok(typeof term.onData === "function", "terminal has onData function");
  assert.ok(typeof term.close === "function", "terminal has close function");
  term.close();
});

test("LocalDeviceRuntime - tools, models, and UI state", async (t) => {
  const { root, agentDir } = fixture(t);
  const runtime = new LocalDeviceRuntime();

  // 1. getTools
  const tools = await runtime.getTools();
  assert.ok(Array.isArray(tools), "getTools returns array");
  assert.ok(tools.length > 0, "getTools has default tools");
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes("read"), "tools include read");
  assert.ok(toolNames.includes("write"), "tools include write");
  assert.ok(toolNames.includes("edit"), "tools include edit");
  assert.ok(toolNames.includes("bash"), "tools include bash");

  // 2. Models configuration
  const enabledModels = await runtime.getEnabledModels(root);
  assert.ok(Array.isArray(enabledModels), "getEnabledModels returns array");

  const defaultModel = await runtime.getDefaultModel(root);
  assert.ok(typeof defaultModel === "object", "getDefaultModel returns object");

  const availableModels = await runtime.getAvailableModels(root);
  assert.ok(typeof availableModels === "object", "getAvailableModels returns object");
  assert.ok(Array.isArray(availableModels.modelList), "availableModels has modelList");

  // 3. UI State
  const uiState = await runtime.getSessionUiState();
  assert.ok(typeof uiState === "object", "getSessionUiState returns object");
  assert.ok(typeof uiState.sessions === "object", "uiState has sessions");

  // Test updating UI state via SessionUiStateRequest
  await runtime.updateSessionUiState({
    action: "set",
    ids: ["test-session-123"],
    pinned: true,
  });

  const updatedUiState = await runtime.getSessionUiState();
  assert.ok(updatedUiState.sessions["test-session-123"], "session 123 is recorded in ui state");
  assert.equal(typeof updatedUiState.sessions["test-session-123"].pinnedAt, "number", "session 123 pinnedAt is timestamp");
});

test("LocalDeviceRuntime & LocalActiveSession - active session abstractions", async (t) => {
  const runtime = new LocalDeviceRuntime();

  // Non-existent session
  const notActive = await runtime.getActiveSession("non-existent-session-xyz");
  assert.equal(notActive, undefined, "returns undefined for non-existent session");

  // Test listSessions
  const sessions = await runtime.listSessions({ summary: true });
  assert.ok(Array.isArray(sessions), "listSessions returns array");

  // Test mock active session wrapper to verify IActiveSession contract
  const sentCommands = [];
  const eventListeners = new Set();
  let runState = false;
  let aliveState = true;

  const mockWrapper = {
    inner: { sessionId: "mock-session-001" },
    cwd: "/mock/cwd",
    sessionFile: "/mock/file.jsonl",
    isAlive: () => aliveState,
    isRunning: () => runState,
    send: async (cmd) => {
      sentCommands.push(cmd);
      if (cmd.type === "abort") {
        runState = false;
      }
      return { ok: true, cmdType: cmd.type };
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    shutdown: async () => {
      aliveState = false;
    },
  };

  const activeSession = new LocalActiveSession(mockWrapper);
  assert.equal(activeSession.sessionId, "mock-session-001");
  assert.equal(activeSession.cwd, "/mock/cwd");
  assert.equal(activeSession.sessionFile, "/mock/file.jsonl");
  assert.equal(activeSession.isAlive(), true);
  assert.equal(activeSession.isRunning(), false);

  // onMessage event subscription
  const receivedMessages = [];
  const unsub = activeSession.onMessage((msg) => receivedMessages.push(msg));
  for (const l of eventListeners) l({ type: "agent_event", text: "hello" });
  assert.equal(receivedMessages.length, 1);
  assert.equal(receivedMessages[0].text, "hello");
  unsub();

  // send
  const res = await activeSession.send({ type: "ping" });
  assert.deepEqual(res, { ok: true, cmdType: "ping" });

  // Mock global registry entry for runtime tests
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
  }
  globalThis.__piSessions.set("mock-session-001", mockWrapper);

  t.after(() => {
    globalThis.__piSessions.delete("mock-session-001");
  });

  const retrievedActive = await runtime.getActiveSession("mock-session-001");
  assert.ok(retrievedActive, "runtime retrieves active session");
  assert.equal(retrievedActive.sessionId, "mock-session-001");

  // Steer while idle -> sends prompt with streamingBehavior: steer
  runState = false;
  await runtime.steerSession("mock-session-001", "Wake up with steer");
  const lastIdleCmd = sentCommands[sentCommands.length - 1];
  assert.equal(lastIdleCmd.type, "prompt");
  assert.equal(lastIdleCmd.message, "Wake up with steer");
  assert.equal(lastIdleCmd.streamingBehavior, "steer");

  // Steer while running -> sends steer
  runState = true;
  await runtime.steerSession("mock-session-001", "Interrupt turn");
  const lastRunningCmd = sentCommands[sentCommands.length - 1];
  assert.equal(lastRunningCmd.type, "steer");
  assert.equal(lastRunningCmd.message, "Interrupt turn");

  // Abort session
  await runtime.abortSession("mock-session-001");
  const lastAbortCmd = sentCommands[sentCommands.length - 1];
  assert.equal(lastAbortCmd.type, "abort");
  assert.equal(runState, false);

  // Close active session
  await activeSession.close();
  assert.equal(activeSession.isAlive(), false);
});
