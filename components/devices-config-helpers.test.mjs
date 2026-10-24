import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  PAIRING_KEY_PATH,
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
  username: "windsing",
  privateKeyPath: PAIRING_KEY_PATH,
  defaultCwd: "/Users/windsing/proj",
  mode: "reverse_tunnel",
  hasPassword: false,
};

test("a tunnel draft has no address, port or password to carry", () => {
  const draft = draftFromConfig(saved);
  // The gateway cannot dial this host, so there is no address to ask for, and
  // the device already holds the key the gateway pairs with: nothing secret is
  // typed here at all.
  assert.equal("host" in draft, false);
  assert.equal("port" in draft, false);
  assert.equal("password" in draft, false);
  const body = draftToBody(draft);
  assert.equal("host" in body, false);
  assert.equal("port" in body, false);
  assert.equal("password" in body, false);
});

test("every save is a reverse tunnel, because that is the only entry this pane writes", () => {
  assert.equal(draftToBody(emptyDraft()).mode, "reverse_tunnel");
  assert.equal(draftToBody(draftFromConfig(saved)).mode, "reverse_tunnel");
  // A saved entry that predates this rule still saves back as a tunnel rather
  // than silently keeping a direction the form no longer offers.
  const legacy = draftFromConfig({ ...saved, mode: "active_ssh" });
  assert.equal(draftToBody(legacy).mode, "reverse_tunnel");
});

test("a new draft starts on the gateway's own pairing key", () => {
  const draft = emptyDraft();
  // The device authorises this key when it runs the join command, so the form
  // opens with it filled in rather than asking for a path the user has to find.
  assert.equal(draft.privateKeyPath, PAIRING_KEY_PATH);
  assert.equal(draftFromConfig({ ...saved, privateKeyPath: undefined }).privateKeyPath, PAIRING_KEY_PATH);
  assert.equal(draftFromConfig({ ...saved, privateKeyPath: "~/.ssh/other" }).privateKeyPath, "~/.ssh/other");
});

test("an empty draft passes only once an id and a username are filled", () => {
  const draft = emptyDraft();
  assert.equal(draftProblem(draft), "devices.problem.id");
  assert.equal(draftProblem({ ...draft, id: "home-nas" }), "devices.problem.username");
  assert.equal(draftProblem({ ...draft, id: "home-nas", username: "windsing" }), null);
  // A default folder is optional: a device that dials in need not say where to
  // start, and demanding one would block the common case.
  assert.equal(draftProblem({ ...draft, id: "home-nas", username: "windsing", defaultCwd: "" }), null);
});

test("clearing the key path is visible in the form, so it reaches the server", () => {
  const body = draftToBody({ ...draftFromConfig(saved), privateKeyPath: "" });
  assert.equal(body.privateKeyPath, "");
  assert.equal(body.defaultCwd, "/Users/windsing/proj");
});

test("an id must be usable in a URL and as a map key", () => {
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "my nas", username: "u" }),
    "devices.problem.idFormat",
  );
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "-nas", username: "u" }),
    "devices.problem.idFormat",
  );
  assert.equal(
    draftProblem({ ...emptyDraft(), id: "us-east.1_a-b", username: "u" }),
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
