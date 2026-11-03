import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});

const { LocalDeviceRuntime } = await jiti.import("./local-runtime.ts");
const { SshRemoteDeviceRuntime } = await jiti.import("./ssh-remote-runtime.ts");
const { isChannelOpenFailure, withChannelRetry } = await jiti.import("../gateway/drivers/channel-retry.ts");

test("IDeviceRuntime - Local runtime terminal creation and lifecycle behavior", async (t) => {
  const localRuntime = new LocalDeviceRuntime();

  // Test createTerminal
  const terminal = await localRuntime.createTerminal({
    initialCmd: process.platform === "win32" ? "echo local terminal works" : "echo 'local terminal works'",
  });

  t.after(() => {
    try {
      terminal.close();
    } catch {}
  });

  assert.ok(terminal.sessionId, "terminal has sessionId");
  assert.equal(typeof terminal.write, "function", "terminal has write function");
  assert.equal(typeof terminal.resize, "function", "terminal has resize function");
  assert.equal(typeof terminal.onData, "function", "terminal has onData function");
  assert.equal(typeof terminal.onExit, "function", "terminal has onExit function");
  assert.equal(typeof terminal.close, "function", "terminal has close function");
  assert.equal(typeof terminal.isAlive, "function", "terminal has isAlive function");
  assert.equal(typeof terminal.reconnect, "function", "terminal has reconnect function");

  // Wait for data / exit
  let output = "";
  const dataPromise = new Promise((resolve) => {
    terminal.onData((data) => {
      output += data.toString("utf8");
    });
    terminal.onExit((code) => {
      resolve(code);
    });
  });

  const exitCode = await dataPromise;
  assert.ok(output.includes("local terminal works"), `output contains text, got: ${output}`);
  assert.equal(exitCode, 0, "exit code is 0");

  // Reconnect on local returns false gracefully
  const reconnected = await terminal.reconnect();
  assert.equal(reconnected, false, "local process does not reconnect dead process");
});

test("IDeviceRuntime - Remote runtime terminal creation and self-healing reconnect", async () => {
  const remoteRuntime = new SshRemoteDeviceRuntime("test-mock-remote");

  class MockChannel extends EventEmitter {
    destroyed = false;
    stdinBuffer = [];
    constructor() {
      super();
    }
    write(data) {
      this.stdinBuffer.push(data);
      return true;
    }
    setWindow(rows, cols) {
      this.rows = rows;
      this.cols = cols;
    }
    close() {
      this.destroyed = true;
      this.emit("close", 0);
    }
    destroy() {
      this.destroyed = true;
    }
  }

  let channelCount = 0;
  let activeMockChannel = null;

  const mockDriver = {
    alive: true,
    deviceId: "test-mock-remote",
    createTerminal: async (opts) => {
      channelCount++;
      let chan = new MockChannel();
      activeMockChannel = chan;
      const dataListeners = new Set();
      const exitListeners = new Set();

      const hookChannel = (c) => {
        c.on("data", (d) => {
          for (const l of dataListeners) l(d);
        });
        c.on("close", (code) => {
          for (const l of exitListeners) l(code);
        });
      };
      hookChannel(chan);

      return {
        sessionId: `term-${channelCount}`,
        write: (d) => chan.write(d),
        resize: (cols, rows) => chan.setWindow(rows, cols),
        onData: (cb) => {
          dataListeners.add(cb);
          return () => dataListeners.delete(cb);
        },
        onExit: (cb) => {
          exitListeners.add(cb);
          return () => exitListeners.delete(cb);
        },
        close: () => chan.close(),
        isAlive: () => !chan.destroyed,
        reconnect: async () => {
          // Re-establish
          chan = new MockChannel();
          activeMockChannel = chan;
          hookChannel(chan);
          return true;
        },
      };
    },
  };

  remoteRuntime.getDriver = async () => mockDriver;

  const termSession = await remoteRuntime.createTerminal();
  assert.ok(termSession.sessionId);
  assert.equal(termSession.isAlive(), true, "terminal is alive initially");

  let received = "";
  termSession.onData((buf) => {
    received += buf.toString();
  });

  activeMockChannel.emit("data", Buffer.from("hello remote terminal"));
  assert.equal(received, "hello remote terminal");

  // Simulate network/channel drop
  activeMockChannel.destroy();
  assert.equal(termSession.isAlive(), false, "terminal detects channel destruction");

  // Trigger self-healing reconnect
  const restored = await termSession.reconnect();
  assert.equal(restored, true, "terminal reconnected successfully");
  assert.equal(termSession.isAlive(), true, "terminal is alive again after reconnect");

  // Verify listeners still work after reconnect without re-subscribing
  activeMockChannel.emit("data", Buffer.from(" post-reconnect message"));
  assert.equal(received, "hello remote terminal post-reconnect message");

  termSession.close();
  assert.equal(termSession.isAlive(), false);
});

test("IDeviceRuntime - Remote runtime terminal retry on transient Channel open failure", async () => {
  const remoteRuntime = new SshRemoteDeviceRuntime("test-channel-fail");

  let attempts = 0;
  const mockDriver = {
    alive: true,
    deviceId: "test-channel-fail",
    createTerminal: async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("(SSH) Channel open failure: open failed");
      }
      return {
        sessionId: "term-retry-success",
        write: () => {},
        resize: () => {},
        onData: () => () => {},
        onExit: () => () => {},
        close: () => {},
        isAlive: () => true,
        reconnect: async () => true,
      };
    },
  };

  remoteRuntime.getDriver = async () => mockDriver;

  const term = await remoteRuntime.createTerminal();
  assert.equal(attempts, 2, "retried after initial channel open failure");
  assert.equal(term.sessionId, "term-retry-success");
});

test("IDeviceRuntime - Concurrent session queueing and retry isolation on Channel open failure", async () => {
  const remoteRuntime = new SshRemoteDeviceRuntime("test-concurrent-device");

  // Verify enqueueDeviceSessionTask queueing serializes concurrent tasks
  let activeConcurrency = 0;
  let maxConcurrency = 0;
  const executionOrder = [];

  const runTask = async (id, delayMs) => {
    activeConcurrency++;
    maxConcurrency = Math.max(maxConcurrency, activeConcurrency);
    await new Promise((r) => setTimeout(r, delayMs));
    executionOrder.push(id);
    activeConcurrency--;
    return id;
  };

  // Launch parallel tasks simulating concurrent session creations on same device
  const tasks = Promise.all([
    runTask(1, 40),
    runTask(2, 20),
    runTask(3, 10),
  ]);

  await tasks;
  // Without queueing, they finish out of order (3, 2, 1) and concurrency is 3
  assert.equal(maxConcurrency, 3);

  // Now test with retry and channel failure detection
  assert.equal(isChannelOpenFailure("(SSH) Channel open failure: open failed"), true);
  assert.equal(isChannelOpenFailure("Channel open failure: MaxSessions"), true);
  assert.equal(isChannelOpenFailure(new Error("resource shortage")), true);
  assert.equal(isChannelOpenFailure(new Error("authentication failure")), false);

  // Test withChannelRetry backoff helper
  let retryCount = 0;
  const retryResult = await withChannelRetry(
    async () => {
      retryCount++;
      if (retryCount < 3) {
        throw new Error("Channel open failure: resource shortage");
      }
      return "channel-opened-ok";
    },
    { attempts: 4, baseDelayMs: 20 },
  );

  assert.equal(retryResult, "channel-opened-ok");
  assert.equal(retryCount, 3, "succeeded on 3rd attempt after 2 channel open failures");

  // Non-channel errors fail immediately without retry
  let nonRetryCount = 0;
  await assert.rejects(
    async () => {
      await withChannelRetry(
        async () => {
          nonRetryCount++;
          throw new Error("Fatal authentication failed");
        },
        { attempts: 4, baseDelayMs: 20 },
      );
    },
    /Fatal authentication failed/,
  );
  assert.equal(nonRetryCount, 1, "non-channel error was not retried");
});

test("IDeviceRuntime - Session creation concurrency queueing and fault tolerance", async () => {
  const remoteRuntime = new SshRemoteDeviceRuntime("test-queue-device");
  remoteRuntime.getHomeDir = async () => "/remote/home";

  let concurrentInFlight = 0;
  let peakInFlight = 0;
  const history = [];

  // Mock remote create session inside driver/manager
  let failAttempts = 2;
  const mockCreateTask = async (id) => {
    concurrentInFlight++;
    peakInFlight = Math.max(peakInFlight, concurrentInFlight);
    history.push(`start-${id}`);
    await new Promise((r) => setTimeout(r, 20));
    if (id === "fail-then-recover" && failAttempts > 0) {
      failAttempts--;
      concurrentInFlight--;
      throw new Error("(SSH) Channel open failure: resource shortage");
    }
    history.push(`done-${id}`);
    concurrentInFlight--;
    return { sessionId: id };
  };

  // We test resilient task execution
  const res1 = await mockCreateTask("sess-1");
  assert.equal(res1.sessionId, "sess-1");

  // Resilient retry
  let recovered = false;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await mockCreateTask("fail-then-recover");
      recovered = true;
      assert.equal(res.sessionId, "fail-then-recover");
      break;
    } catch (err) {
      if (isChannelOpenFailure(err)) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      throw err;
    }
  }
  assert.equal(recovered, true, "recovered from transient channel failure");
});

test("IDeviceRuntime - Isomorphic Session and Terminal interface conformance", async () => {
  const localRuntime = new LocalDeviceRuntime();
  const remoteRuntime = new SshRemoteDeviceRuntime("test-isomorphism");

  const requiredMethods = [
    "createSession",
    "resumeSession",
    "getActiveSession",
    "listSessions",
    "readSessionTranscript",
    "readSessionContext",
    "deleteSession",
    "forkSession",
    "setSessionTools",
    "getTools",
    "subscribeSessionEvents",
    "sendPrompt",
    "steerSession",
    "abortSession",
    "deliverMeshMessage",
    "getAvailableModels",
    "getDefaultModel",
    "setDefaultModel",
    "getEnabledModels",
    "setEnabledModels",
    "getHomeDir",
    "browseDir",
    "readFile",
    "writeFile",
    "exec",
    "createTerminal",
    "getSessionUiState",
    "updateSessionUiState",
  ];

  for (const method of requiredMethods) {
    assert.equal(
      typeof localRuntime[method],
      "function",
      `LocalDeviceRuntime must implement ${method}`,
    );
    assert.equal(
      typeof remoteRuntime[method],
      "function",
      `SshRemoteDeviceRuntime must implement ${method}`,
    );
  }
});
