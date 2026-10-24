import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// `enabled-hosts.ts` imports pi's `getAgentDir`, so the path is always passed
// in: these tests never touch the real agent directory.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { enabledHostsPath, isHostEnabled, readEnabledHosts, setHostEnabled } =
  await jiti.import("./enabled-hosts.ts");

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), "pi-web-enabled-")), "pi-web-enabled-hosts.json");
}

test("nothing is enabled until the file says so", () => {
  const path = tempFile();
  const state = readEnabledHosts(path);
  assert.equal(state.defaultEnabled, false);
  assert.deepEqual(state.enabled, []);
  // A host the file has never mentioned follows the default, which is off: an
  // untouched `~/.ssh/config` must not mean every stanza is served.
  assert.equal(isHostEnabled("some-host", path), false);
});

test("switching a host on writes it, and reading it back agrees", async () => {
  const path = tempFile();
  await setHostEnabled("wscomp", true, path);
  assert.equal(isHostEnabled("wscomp", path), true);
  assert.equal(isHostEnabled("other", path), false);
  // Sorted and newline-terminated, so a diff of the file is stable.
  assert.equal(readFileSync(path, "utf8"), '{\n  "defaultEnabled": false,\n  "enabled": [\n    "wscomp"\n  ],\n  "disabled": []\n}\n');
});

test("switching a host off moves it between the lists instead of adding to both", async () => {
  const path = tempFile();
  await setHostEnabled("wscomp", true, path);
  await setHostEnabled("wscomp", false, path);
  const state = readEnabledHosts(path);
  assert.deepEqual(state.enabled, []);
  assert.deepEqual(state.disabled, ["wscomp"]);
  assert.equal(isHostEnabled("wscomp", path), false);
});

test("a host can be turned back on after being turned off", async () => {
  const path = tempFile();
  await setHostEnabled("wscomp", false, path);
  await setHostEnabled("wscomp", true, path);
  const state = readEnabledHosts(path);
  assert.deepEqual(state.enabled, ["wscomp"]);
  assert.deepEqual(state.disabled, []);
});

test("an unreadable file reads as nothing enabled rather than throwing", () => {
  const path = tempFile();
  writeFileSync(path, "{ not json");
  assert.deepEqual(readEnabledHosts(path), { defaultEnabled: false, enabled: [], disabled: [] });
  assert.equal(isHostEnabled("wscomp", path), false);
});

test("the file lives beside pi's own files, not in the checkout", () => {
  assert.equal(enabledHostsPath("/tmp/agent"), join("/tmp/agent", "pi-web-enabled-hosts.json"));
});
