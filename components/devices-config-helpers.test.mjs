import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  draftFromConfig,
  draftProblem,
  draftToBody,
  emptyDraft,
  isSavedId,
  reloadSummary,
} = await jiti.import("./devices-config-helpers.ts");

const saved = {
  id: "wsmac",
  name: "wsmac (Mac Mini)",
  host: "192.168.1.7",
  port: 22,
  username: "windsing",
  privateKeyPath: "~/.ssh/wshome",
  defaultCwd: "/Users/windsing/proj",
  mode: "active_ssh",
  hasPassword: false,
};

test("a saved password is reported but never sent back", () => {
  const draft = draftFromConfig({ ...saved, hasPassword: true });
  assert.equal(draft.hasPassword, true);
  assert.equal(draft.password, "");
  // The blank field means "keep the saved one": the body must not carry an
  // empty password, which `PUT` would read as clearing it.
  assert.equal("password" in draftToBody(draft), false);
});

test("a typed password is sent", () => {
  const body = draftToBody({ ...draftFromConfig(saved), password: "hunter2" });
  assert.equal(body.password, "hunter2");
});

test("the port travels as the text in the field, and blank visible fields are sent", () => {
  const body = draftToBody({ ...draftFromConfig(saved), port: " 2222 ", privateKeyPath: "" });
  assert.equal(body.port, "2222");
  assert.equal(body.host, "192.168.1.7");
  // Clearing the key path is visible in the form, so it must reach the server.
  assert.equal(body.privateKeyPath, "");
});

test("an empty draft fills the default port and passes only once the rest is filled", () => {
  const draft = emptyDraft();
  assert.equal(draft.port, "22");
  assert.equal(draftProblem(draft), "devices.problem.id");
  assert.equal(draftProblem({ ...draft, id: "vps" }), "devices.problem.host");
  assert.equal(draftProblem({ ...draft, id: "vps", host: "h" }), "devices.problem.username");
  assert.equal(
    draftProblem({ ...draft, id: "vps", host: "h", username: "root", port: "0" }),
    "devices.problem.port",
  );
  assert.equal(
    draftProblem({ ...draft, id: "vps", host: "h", username: "root", port: "65536" }),
    "devices.problem.port",
  );
  assert.equal(
    draftProblem({ ...draft, id: "vps", host: "h", username: "root", port: "22" }),
    null,
  );
});

test("an id must be usable in a URL and as a map key", () => {
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "my vps", host: "h", username: "u" }),
    "devices.problem.idFormat",
  );
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "-vps", host: "h", username: "u" }),
    "devices.problem.idFormat",
  );
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "us-east.1_a-b", host: "h", username: "u" }),
    null,
  );
});

test("an existing id is recognised so the form edits instead of adding a duplicate", () => {
  assert.equal(isSavedId([saved], " wsmac "), true);
  assert.equal(isSavedId([saved], "wsmac2"), false);
});

test("a reload summary distinguishes a real change from a no-op", () => {
  assert.equal(reloadSummary(undefined), null);
  assert.equal(reloadSummary({ connected: [], removed: [], unchanged: ["a", "b"] }), "unchanged");
  assert.equal(reloadSummary({ connected: ["a"], removed: [], unchanged: ["b"] }), "changed");
  assert.equal(reloadSummary({ connected: [], removed: ["a"], unchanged: [] }), "changed");
});
