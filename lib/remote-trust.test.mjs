import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// `server-only` is a Next.js marker package and is not resolvable outside a
// Next build; the helpers below are handed a driver, so an empty stub is enough.
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const {
  nearestRemoteTrustDecision,
  parseRemoteTrust,
  remoteFolderIsFresh,
  remoteProjectTrustStatus,
  remoteTrustBreadth,
  serializeRemoteTrust,
} = await jiti.import("@/lib/remote-trust");

/** A snapshot of what the device answered, without a device. */
function snapshot(fields = {}) {
  return {
    directoryExists: true,
    home: "/Users/x",
    realPath: "/Users/x/proj",
    entries: [],
    files: new Map(),
    ...fields,
  };
}

test("a trust file is written the way pi writes it: sorted, only decisions, one newline", () => {
  assert.equal(serializeRemoteTrust({ "/b": true, "/a": null, "/c": false }), '{\n  "/a": null,\n  "/b": true,\n  "/c": false\n}\n');
  // A value pi would refuse to read is dropped rather than written.
  assert.equal(serializeRemoteTrust({ "/a": "yes" }), "{}\n");
});

test("a trust file is read leniently about a BOM and strictly about values", () => {
  assert.deepEqual(parseRemoteTrust('\uFEFF{"/a": true}'), { trust: { "/a": true } });
  assert.deepEqual(parseRemoteTrust(undefined), {});
  assert.match(parseRemoteTrust("[]").trustError, /expected an object/);
  assert.match(parseRemoteTrust('{"/a": "yes"}').trustError, /must be true, false, or null/);
  assert.match(parseRemoteTrust("{").trustError, /Failed to read trust store/);
});

test("the nearest decision is found by walking up, and a null is walked past", () => {
  const trust = { "/Users/x": true, "/Users/x/proj/gone": null };
  assert.deepEqual(nearestRemoteTrustDecision(trust, "/Users/x/proj/gone"), { decision: true, path: "/Users/x", inherited: true });
  assert.deepEqual(nearestRemoteTrustDecision(trust, "/Users/x/proj"), { decision: true, path: "/Users/x", inherited: true });
  assert.deepEqual(nearestRemoteTrustDecision({ "/Users/x/proj": false }, "/Users/x/proj"), { decision: false, path: "/Users/x/proj", inherited: false });
  assert.equal(nearestRemoteTrustDecision(undefined, "/Users/x"), undefined);
});

test("a folder reached through a link finds the decision pi wrote for its target", () => {
  // The decision names the real folder; the path asked for is the link.
  const decision = nearestRemoteTrustDecision({ "/Users/x/real": true }, "/Users/x/link", "/Users/x/real");
  assert.deepEqual(decision, { decision: true, path: "/Users/x/real", inherited: false });
});

test("a folder needs trust when it has project config, and is trusted only by a true decision", () => {
  const untrusted = remoteProjectTrustStatus(snapshot({ entries: ["mcp.json"] }), "/Users/x/proj");
  assert.equal(untrusted.requiresTrust, true);
  assert.equal(untrusted.trusted, false);
  assert.equal(untrusted.decision, null);

  const trusted = remoteProjectTrustStatus(snapshot({ entries: ["mcp.json"], trust: { "/Users/x/proj": true } }), "/Users/x/proj");
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.decision, true);
  assert.equal(trusted.inherited, false);

  // A folder with nothing pi reads does not need trust, so it is usable as it is.
  const plain = remoteProjectTrustStatus(snapshot(), "/Users/x/proj");
  assert.equal(plain.requiresTrust, false);
  assert.equal(plain.trusted, true);
});

test("an unreadable trust store is reported instead of guessed", () => {
  const status = remoteProjectTrustStatus(snapshot({ entries: ["mcp.json"], trustError: "Invalid trust store: expected an object" }), "/Users/x/proj");
  assert.equal(status.decisionError, "Invalid trust store: expected an object");
  assert.equal(status.trusted, false);
});

test("trusting a folder too broad to trust is refused, in pi's order", () => {
  const home = snapshot();
  assert.deepEqual(remoteTrustBreadth(home, "/", "/Users/x/.pi/agent"), { kind: "root", path: "/" });
  assert.deepEqual(remoteTrustBreadth(home, "/Users/x", "/Users/x/.pi/agent"), { kind: "home", path: "/Users/x" });
  assert.deepEqual(remoteTrustBreadth(home, "/Users", "/Users/x/.pi/agent"), { kind: "contains-home", path: "/Users" });
  assert.deepEqual(remoteTrustBreadth(home, "/Users/x", "/Users/x/.pi/agent"), { kind: "home", path: "/Users/x" });
  assert.equal(remoteTrustBreadth(home, "/Users/x/proj", "/Users/x/.pi/agent"), undefined);
  // The agent directory itself is never a project to trust.
  assert.deepEqual(remoteTrustBreadth(home, "/Users/x/.pi", "/Users/x/.pi/agent"), { kind: "contains-agent-dir", path: "/Users/x/.pi" });
});

test("a folder is fresh only while nothing above it has a decision", () => {
  assert.equal(remoteFolderIsFresh(snapshot(), "/Users/x/proj"), true);
  assert.equal(remoteFolderIsFresh(snapshot({ entries: ["settings.json"] }), "/Users/x/proj"), false);
  assert.equal(remoteFolderIsFresh(snapshot({ skillsDir: "/Users/x/.agents/skills" }), "/Users/x/proj"), false);
  assert.equal(remoteFolderIsFresh(snapshot({ trust: { "/Users/x": true } }), "/Users/x/proj"), false);
  // A null is a removed decision: it does not make the folder stale.
  assert.equal(remoteFolderIsFresh(snapshot({ trust: { "/Users/x": null } }), "/Users/x/proj"), true);
});
