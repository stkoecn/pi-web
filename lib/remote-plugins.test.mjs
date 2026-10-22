import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const {
  parseRemoteSettingsFile,
  pluginCommandArgs,
  readRemotePackageEntry,
  readRemotePackages,
  remotePackageEntries,
  serializeRemoteSettings,
  settingsWithPackages,
} = await jiti.import("@/lib/remote-plugins");

test("a settings body that is not an object reads as undefined", () => {
  assert.equal(parseRemoteSettingsFile(undefined), undefined);
  assert.equal(parseRemoteSettingsFile("[]"), undefined);
  assert.equal(parseRemoteSettingsFile("nope"), undefined);
  assert.deepEqual(parseRemoteSettingsFile('{"a":1}'), { a: 1 });
});

test("a packages list that is not a list reads as empty", () => {
  assert.deepEqual(remotePackageEntries(undefined), []);
  assert.deepEqual(remotePackageEntries({ packages: "x" }), []);
  assert.deepEqual(remotePackageEntries({ packages: ["a"] }), ["a"]);
});

test("a string entry is installed and unfiltered", () => {
  assert.deepEqual(readRemotePackageEntry("npm:left-pad"), {
    source: "npm:left-pad",
    disabled: false,
    filtered: false,
  });
});

test("an entry with every resource list empty reads as disabled", () => {
  assert.deepEqual(
    readRemotePackageEntry({ source: "a", extensions: [], skills: [], prompts: [], themes: [] }),
    { source: "a", disabled: true, filtered: false },
  );
});

test("an enabled object entry reads as filtered", () => {
  assert.deepEqual(readRemotePackageEntry({ source: "a", autoload: true }), {
    source: "a",
    disabled: false,
    filtered: true,
  });
});

test("an entry without a source is skipped", () => {
  assert.equal(readRemotePackageEntry({ autoload: true }), undefined);
  assert.equal(readRemotePackageEntry(42), undefined);
});

test("the list puts global packages before project ones and marks what can be checked", () => {
  const packages = readRemotePackages(
    { packages: ["npm:@agegr/pi-web", "npm:@agegr/pi-web@0.11.0"] },
    { packages: ["../local/pkg"] },
  );
  assert.deepEqual(packages.map((pkg) => [pkg.source, pkg.scope, pkg.canCheckForUpdates]), [
    ["npm:@agegr/pi-web", "global", true],
    ["npm:@agegr/pi-web@0.11.0", "global", false],
    ["../local/pkg", "project", false],
  ]);
  assert.equal(packages[0].status, "installed");
  assert.equal(packages[0].configuredVersion, undefined);
  assert.equal(packages[1].configuredVersion, "0.11.0");
});

test("a disabled package reports the disabled status", () => {
  const packages = readRemotePackages(
    { packages: [{ source: "a", extensions: [], skills: [], prompts: [], themes: [] }] },
    undefined,
  );
  assert.equal(packages[0].status, "disabled");
  assert.equal(packages[0].disabled, true);
});

test("writing keeps the settings the file already had", () => {
  const next = settingsWithPackages({ defaultModel: "x", packages: ["old"] }, ["new"]);
  assert.deepEqual(next, { defaultModel: "x", packages: ["new"] });
});

test("a written settings file is two-space JSON with no trailing newline", () => {
  const text = serializeRemoteSettings({ a: 1 });
  assert.equal(text, '{\n  "a": 1\n}');
});

test("install and remove pass -l only for a project package", () => {
  assert.deepEqual(pluginCommandArgs("install", "npm:a", "global"), ["install", "npm:a"]);
  assert.deepEqual(pluginCommandArgs("install", "npm:a", "project"), ["install", "npm:a", "-l"]);
  assert.deepEqual(pluginCommandArgs("remove", "npm:a", "project"), ["remove", "npm:a", "-l"]);
});

test("update names one source, or every extension when there is none", () => {
  assert.deepEqual(pluginCommandArgs("update", "npm:a", "global"), ["update", "npm:a"]);
  assert.deepEqual(pluginCommandArgs("update", undefined, "global"), ["update", "--extensions"]);
});
