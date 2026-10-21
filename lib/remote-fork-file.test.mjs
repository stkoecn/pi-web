import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildForkedSession, sessionFileTimestamp } = await jiti.import("./remote-fork-file.ts");
const { SessionForkError } = await jiti.import("./session-fork.ts");

/** A minimal but valid transcript: header plus two messages and a rename. */
function transcript(overrides = {}) {
  const header = {
    type: "session",
    version: 3,
    id: "0199aaaa-0000-7000-8000-000000000001",
    timestamp: "2026-10-20T16:39:54.260Z",
    cwd: "/Users/windsing/proj/test",
    ...overrides,
  };
  return [
    header,
    {
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2026-10-20T16:39:55.000Z",
      message: { role: "user", content: [{ type: "text", text: "Reply with exactly: TUNNEL_OK" }] },
    },
    {
      type: "message",
      id: "a2",
      parentId: "a1",
      timestamp: "2026-10-20T16:39:56.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "TUNNEL_OK" }],
        provider: "stkoe",
        model: "workbuddy-ai/deepseek-v4.1-flash",
        usage: { input: 202, output: 6, cacheRead: 2304 },
        stopReason: "stop",
      },
    },
  ];
}

const SOURCE_PATH = "/Users/windsing/.pi/agent/sessions/--Users-windsing-proj-test--/2026-10-20T16-39-54-260Z_0199aaaa.jsonl";

test("a fork keeps the device's cwd and names the source as its origin", () => {
  const fork = buildForkedSession({
    entries: transcript(),
    cwd: "/Users/windsing/proj/test",
    sourcePath: SOURCE_PATH,
    sourceTitle: "Reply with exactly: TUNNEL_OK",
    suffix: "3f9a",
  });
  const [header, ...rest] = fork.contents.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(header.type, "session");
  assert.notEqual(header.id, "0199aaaa-0000-7000-8000-000000000001", "the copy has its own id");
  // The manager normalises cwd for the platform pi-web runs on; the fork is a
  // session *on the device*, so the caller's cwd must survive.
  assert.equal(header.cwd, "/Users/windsing/proj/test");
  assert.equal(header.parentSession, SOURCE_PATH);
  assert.equal(fork.sessionId, header.id);
  assert.equal(header.timestamp, fork.timestamp);
  assert.equal(rest.filter((entry) => entry.type === "message").length, 2);
});

test("the copy is named after its source plus the suffix", () => {
  const fork = buildForkedSession({
    entries: transcript(),
    cwd: "/tmp",
    sourcePath: SOURCE_PATH,
    sourceTitle: "Reply with exactly: TUNNEL_OK",
    suffix: "3f9a",
  });
  assert.equal(fork.name, "Reply with exactly: TUNNEL_OK · 3f9a");
  const last = JSON.parse(fork.contents.trimEnd().split("\n").pop());
  assert.equal(last.type, "session_info");
  assert.equal(last.name, fork.name);
});

test("a source the sidebar shows no title for gives its copy no name", () => {
  const fork = buildForkedSession({
    entries: transcript(),
    cwd: "/tmp",
    sourcePath: SOURCE_PATH,
    sourceTitle: null,
    suffix: "3f9a",
  });
  assert.equal(fork.name, undefined);
  assert.equal(fork.contents.includes('"session_info"'), false);
});

test("an unknown title falls back to the session id, as the local fork does", () => {
  const fork = buildForkedSession({
    entries: transcript(),
    cwd: "/tmp",
    sourcePath: SOURCE_PATH,
    sourceTitle: undefined,
    suffix: "3f9a",
  });
  assert.match(fork.name, / · 3f9a$/);
  assert.notEqual(fork.name, " · 3f9a");
});

test("a fork of a fork drops the earlier suffix instead of stacking it", () => {
  const fork = buildForkedSession({
    entries: transcript({ parentSession: "/some/earlier/source.jsonl" }),
    cwd: "/tmp",
    sourcePath: SOURCE_PATH,
    sourceTitle: "Weekly sync · 1234",
    suffix: "abcd",
  });
  assert.equal(fork.name, "Weekly sync · abcd");
});

test("a session with no messages cannot be forked", () => {
  const headerOnly = transcript().slice(0, 1);
  assert.throws(
    () => buildForkedSession({ entries: headerOnly, cwd: "/tmp", sourcePath: SOURCE_PATH, suffix: "0001" }),
    (error) => error instanceof SessionForkError && error.code === "empty",
  );
});

test("an empty transcript is reported as a missing session", () => {
  assert.throws(
    () => buildForkedSession({ entries: [], cwd: "/tmp", sourcePath: SOURCE_PATH, suffix: "0001" }),
    (error) => error instanceof SessionForkError && error.code === "not_found",
  );
});

test("a subagent session cannot be forked", () => {
  const entries = transcript();
  entries.push({
    type: "custom",
    id: "b1",
    parentId: "a2",
    timestamp: "2026-10-20T16:39:57.000Z",
    customType: "pi-web:subagent",
    data: {
      version: 1,
      parentSessionId: "0199aaaa-0000-7000-8000-000000000001",
      parentSessionPath: "/some/parent.jsonl",
      profile: "explore",
    },
  });
  assert.throws(
    () => buildForkedSession({ entries, cwd: "/tmp", sourcePath: SOURCE_PATH, suffix: "0001" }),
    (error) => error instanceof SessionForkError && error.code === "subagent",
  );
});

test("the file timestamp is the header timestamp, made filename-safe", () => {
  assert.equal(sessionFileTimestamp("2026-10-20T16:39:54.260Z"), "2026-10-20T16-39-54-260Z");
});
