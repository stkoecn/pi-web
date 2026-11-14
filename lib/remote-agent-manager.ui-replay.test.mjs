import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// The module keeps its session map on globalThis and reads it once at import:
// seed the test's map BEFORE the import, so the tests drive the module's own
// registry and nothing else.
const sessions = new Map();
globalThis.__remoteRpcSessions = sessions;

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const {
  clearRemotePendingUiRequest,
  getRemoteRpcSessionState,
  isRemoteSessionRunning,
  trackRemoteRunState,
} = await jiti.import("@/lib/remote-agent-manager");

// The wire frame is flat: method/options live at the top level, next to the id.
const askFrame = {
  type: "extension_ui_request",
  id: "ui-1",
  method: "select",
  title: "剧情推进",
  options: ["A", "B"],
  sessionId: "sess-1",
};

function makeSession(id) {
  return {
    sessionId: id,
    deviceId: "box",
    channel: { isClosed: () => false, onMessage: () => () => {}, send: () => {} },
    state: { isStreaming: false },
    listeners: new Set(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    pendingUiRequestIds: new Set(),
    pendingUiRequests: new Map(),
    deadProbes: 0,
    runActive: false,
  };
}

test("a blocking extension_ui_request is stored whole, for the replay", () => {
  const session = makeSession("s1");
  sessions.set("s1", session);
  trackRemoteRunState(session, askFrame);
  assert.equal(session.pendingUiRequestIds.has("ui-1"), true);
  const frame = session.pendingUiRequests.get("ui-1");
  assert.ok(frame, "the full frame is kept");
  // Field-equal with the original: the replay must be the same dialog.
  assert.deepEqual(frame, askFrame);
  assert.equal(frame.options.length, 2);
});

test("a non-blocking request is not stored", () => {
  const session = makeSession("s2");
  sessions.set("s2", session);
  trackRemoteRunState(session, { type: "extension_ui_request", id: "ui-2", method: "setStatus" });
  assert.equal(session.pendingUiRequestIds.has("ui-2"), false);
  assert.equal(session.pendingUiRequests.size, 0);
});

test("the run's end clears the pending frames", () => {
  const session = makeSession("s3");
  sessions.set("s3", session);
  trackRemoteRunState(session, askFrame);
  trackRemoteRunState(session, { type: "agent_end" });
  assert.equal(session.pendingUiRequestIds.size, 0);
  assert.equal(session.pendingUiRequests.size, 0);
  assert.equal(isRemoteSessionRunning(session), false);
});

test("clearRemotePendingUiRequest removes the payload with the id", () => {
  const session = makeSession("s4");
  sessions.set("s4", session);
  trackRemoteRunState(session, askFrame);
  clearRemotePendingUiRequest("s4", "ui-1");
  assert.equal(session.pendingUiRequestIds.size, 0);
  assert.equal(session.pendingUiRequests.size, 0);
});

test("two dead probes close the session; one blip does not", async () => {
  const session = makeSession("s5");
  // A closed channel: the state read skips the channel and counts a dead probe.
  session.channel = { isClosed: () => true, onMessage: () => () => {}, send: () => {} };
  sessions.set("s5", session);

  const first = await getRemoteRpcSessionState("s5");
  // One blip falls back to the cache (the report's debounce): the state object
  // still answers, the session stays, and the probe is counted.
  assert.ok(first && first.isStreaming === false, "one blip answers from the cache");
  assert.equal(sessions.has("s5"), true, "one blip does not close the session");
  assert.equal(session.deadProbes, 1);

  await getRemoteRpcSessionState("s5");
  assert.equal(sessions.has("s5"), false, "the second dead probe closes the session");
});

test.after(() => {
  delete globalThis.__remoteRpcSessions;
});
