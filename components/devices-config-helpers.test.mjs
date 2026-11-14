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
  id: "winsingair",
  name: "winsingair",
  host: "192.168.1.6",
  port: 22,
  username: "windsing",
  privateKeyPath: "~/.ssh/id_ed25519",
  defaultCwd: "/Users/windsing/proj",
  hasPassword: false,
};

test("a draft carries the address the gateway dials", () => {
  const draft = draftFromConfig(saved);
  assert.equal(draft.host, "192.168.1.6");
  assert.equal(draft.port, "22");
  // The secret itself never comes back from the server, so the draft has
  // nowhere to put one: clearing the key path is what the user asked for.
  assert.equal("password" in draft, false);
  const body = draftToBody(draft);
  assert.equal(body.host, "192.168.1.6");
  assert.equal(body.port, 22);
  assert.equal("password" in body, false);
});

test("a new draft opens with the standard port and blank fields", () => {
  const draft = emptyDraft();
  assert.equal(draft.port, "22");
  assert.equal(draft.host, "");
  assert.equal(draft.privateKeyPath, "");
  assert.equal(draftFromConfig({ ...saved, privateKeyPath: undefined }).privateKeyPath, "");
  assert.equal(draftFromConfig({ ...saved, privateKeyPath: "~/.ssh/other" }).privateKeyPath, "~/.ssh/other");
});

test("an empty draft needs an id, a host, a port and a username", () => {
  const draft = emptyDraft();
  assert.equal(draftProblem(draft), "devices.problem.id");
  assert.equal(draftProblem({ ...draft, id: "home-nas" }), "devices.problem.host");
  assert.equal(draftProblem({ ...draft, id: "home-nas", host: "h", port: "" }), "devices.problem.port");
  assert.equal(draftProblem({ ...draft, id: "home-nas", host: "h", port: "0" }), "devices.problem.port");
  assert.equal(draftProblem({ ...draft, id: "home-nas", host: "h", port: "22" }), "devices.problem.username");
  assert.equal(draftProblem({ ...draft, id: "home-nas", host: "h", port: "22", username: "windsing" }), null);
  // A default folder is optional: demanding one would block the common case.
  assert.equal(draftProblem({ ...draft, id: "home-nas", host: "h", port: "22", username: "windsing", defaultCwd: "" }), null);
});

test("clearing the key path is visible in the form, so it reaches the server", () => {
  const body = draftToBody({ ...draftFromConfig(saved), privateKeyPath: "" });
  assert.equal(body.privateKeyPath, "");
  assert.equal(body.defaultCwd, "/Users/windsing/proj");
});

test("an id must be usable in a URL and as a map key", () => {
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "my nas", host: "h", port: "22", username: "u" }),
    "devices.problem.idFormat",
  );
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "-nas", host: "h", port: "22", username: "u" }),
    "devices.problem.idFormat",
  );
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "us-east.1_a-b", host: "h", port: "22", username: "u" }),
    null,
  );
});

test("an existing id is recognised so the form edits instead of adding a duplicate", () => {
  assert.equal(isSavedId([saved], " winsingair "), true);
  assert.equal(isSavedId([saved], "winsingair2"), false);
});

test("a reload summary distinguishes a real change from a no-op", () => {
  assert.equal(reloadSummary(undefined), null);
  assert.equal(reloadSummary({ connected: [], removed: [], unchanged: ["a", "b"] }), "unchanged");
  assert.equal(reloadSummary({ connected: ["a"], removed: [], unchanged: ["b"] }), "changed");
  assert.equal(reloadSummary({ connected: [], removed: ["a"], unchanged: [] }), "changed");
});
