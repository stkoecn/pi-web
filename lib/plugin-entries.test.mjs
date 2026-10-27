import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  applyPackagesDisabled,
  configuredVersionOf,
  getPackageSource,
  hasEntrySettings,
  isDisabledPackage,
} = await jiti.import("@/lib/plugin-entries");

const disabled = (source) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });

test("reads the source of both entry forms", () => {
  assert.equal(getPackageSource("npm:left-pad"), "npm:left-pad");
  assert.equal(getPackageSource({ source: "npm:left-pad" }), "npm:left-pad");
});

test("an entry with every resource list empty is disabled", () => {
  assert.equal(isDisabledPackage(disabled("a")), true);
  assert.equal(isDisabledPackage("a"), false);
  assert.equal(isDisabledPackage({ source: "a", extensions: [] }), false);
});

test("an enabled object entry has settings worth keeping", () => {
  assert.equal(hasEntrySettings({ source: "a", autoload: true }), true);
  assert.equal(hasEntrySettings(disabled("a")), false);
  assert.equal(hasEntrySettings("a"), false);
});

test("disabling writes the four empty lists and leaves other entries alone", () => {
  const edit = applyPackagesDisabled(["a", "b"], ["a"], true);
  assert.equal(edit.changed, true);
  assert.deepEqual(edit.next, [disabled("a"), "b"]);
  assert.deepEqual([...edit.missing], []);
});

test("an entry already in the requested state is not rewritten", () => {
  const entries = [disabled("a")];
  const edit = applyPackagesDisabled(entries, ["a"], true);
  assert.equal(edit.changed, false);
  assert.equal(edit.next[0], entries[0]);
});

test("disabling with keepEntrySettings leaves a filtered package alone", () => {
  const entries = [{ source: "a", extensions: ["./ext"] }];
  const edit = applyPackagesDisabled(entries, ["a"], true, { keepEntrySettings: true });
  assert.equal(edit.changed, false);
  assert.deepEqual([...edit.kept], ["a"]);
  assert.equal(edit.next[0], entries[0]);
});

test("without keepEntrySettings a filtered package is still disabled", () => {
  const edit = applyPackagesDisabled([{ source: "a", extensions: ["./ext"] }], ["a"], true);
  assert.equal(edit.changed, true);
  assert.deepEqual(edit.next[0], disabled("a"));
});

test("enabling drops only the emptied lists and keeps the rest", () => {
  const edit = applyPackagesDisabled([{ ...disabled("a"), autoload: true }], ["a"], false);
  assert.equal(edit.changed, true);
  assert.deepEqual(edit.next[0], { source: "a", autoload: true });
});

test("enabling an entry whose only key was source collapses it to the string", () => {
  const edit = applyPackagesDisabled([disabled("a")], ["a"], false);
  assert.deepEqual(edit.next, ["a"]);
});

test("sources this list does not configure are reported as missing", () => {
  const edit = applyPackagesDisabled(["a"], ["a", "b"], true);
  assert.deepEqual([...edit.missing], ["b"]);
  assert.equal(edit.changed, true);
});

test("the pinned version of an npm source is its range", () => {
  assert.equal(configuredVersionOf("npm:@agegr/pi-web@^0.11.0"), "^0.11.0");
  assert.equal(configuredVersionOf("npm:@agegr/pi-web"), undefined);
});

test("the pinned version of a git source is the ref after the last @", () => {
  assert.equal(configuredVersionOf("git:github.com/a/b@v1"), "v1");
  assert.equal(configuredVersionOf("git:github.com/a/b"), undefined);
  assert.equal(configuredVersionOf("https://github.com/a/b@main"), "main");
  assert.equal(configuredVersionOf("./local/path"), undefined);
});
