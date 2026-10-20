import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  addDeviceToConfigs,
  publicDeviceConfig,
  readDevicesFile,
  removeDeviceFromConfigs,
  sameConnection,
  updateDeviceInConfigs,
  writeDevicesFile,
} = await jiti.import("./device-config-file.ts");

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-devices-"));
  return { dir, file: join(dir, "devices.json") };
};

const device = (over = {}) => ({
  id: "vps",
  name: "VPS",
  host: "203.0.113.10",
  port: 22,
  username: "root",
  privateKeyPath: "~/.ssh/id",
  ...over,
});

test("a missing file is empty rather than an error", () => {
  const { dir, file } = scratch();
  try {
    const read = readDevicesFile(file);
    assert.equal(read.exists, false);
    assert.deepEqual(read.configs, []);
    assert.equal(read.error, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed JSON is reported instead of throwing, so the gateway can still start", () => {
  const { dir, file } = scratch();
  try {
    writeFileSync(file, "{ not json");
    const read = readDevicesFile(file);
    assert.match(read.error ?? "", /not valid JSON/);
    assert.deepEqual(read.configs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one bad entry is skipped with a reason, the rest still load", () => {
  const { dir, file } = scratch();
  try {
    writeFileSync(file, JSON.stringify([
      device(),
      { id: "no-host", username: "root" },
      { id: "bad id", host: "h", username: "u" },
      { id: "vps", host: "h", username: "u" },
      device({ id: "key-and-password", password: "x" }),
      device({ id: "port-range", port: 70000 }),
    ]));
    const read = readDevicesFile(file);
    assert.deepEqual(read.configs.map((c) => c.id), ["vps"]);
    const reasons = read.issues.map((i) => i.reason);
    assert.ok(reasons.some((r) => /host/.test(r)), reasons.join(" | "));
    assert.ok(reasons.some((r) => /may use only letters/.test(r)), reasons.join(" | "));
    assert.ok(reasons.some((r) => /duplicate id/.test(r)), reasons.join(" | "));
    assert.ok(reasons.some((r) => /not both/.test(r)), reasons.join(" | "));
    assert.ok(reasons.some((r) => /port/.test(r)), reasons.join(" | "));
    assert.equal(read.issues.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a port defaults to 22, since almost every host wants it", () => {
  const { dir, file } = scratch();
  try {
    writeFileSync(file, JSON.stringify([{ id: "vps", host: "h", username: "u" }]));
    const [config] = readDevicesFile(file).configs;
    assert.equal(config.port, 22);
    assert.equal(config.mode, "active_ssh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writing keeps the file's own line endings and stops writing default noise", () => {
  const { dir, file } = scratch();
  try {
    // The real file is CRLF: rewriting it must not turn one edit into a
    // whole-file diff.
    writeFileSync(file, `[\r\n]\r\n`);
    writeDevicesFile([device(), device({ id: "two", mode: "active_ssh" })], file);
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("\r\n"), "line endings are preserved");
    assert.equal(text.replace(/\r/g, "").split("\n").filter((l) => l.trim() === "").length > 0, true);
    const parsed = JSON.parse(text);
    assert.equal(parsed.length, 2);
    // active_ssh is the default, so it should not be spelled out.
    assert.equal("mode" in parsed[0], false);
    assert.equal("mode" in parsed[1], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an inline private key is never written, because the file is committed", () => {
  const { dir, file } = scratch();
  try {
    writeDevicesFile([device({ privateKey: "-----BEGIN KEY-----..." })], file);
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("BEGIN KEY"), false);
    assert.equal(text.includes("privateKey\""), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved password is reduced to a flag when read back outwards", () => {
  const pub = publicDeviceConfig(device({ password: "hunter2" }));
  assert.equal(pub.hasPassword, true);
  assert.equal("password" in pub, false);
  assert.equal("privateKey" in pub, false);
  assert.equal(publicDeviceConfig(device()).hasPassword, false);
});

test("adding a device rejects a duplicate id, which would shadow a live host", () => {
  const configs = [device()];
  assert.match(addDeviceToConfigs(configs, device()).reason ?? "", /already exists/);
  const added = addDeviceToConfigs(configs, { id: "two", host: "h", username: "u" });
  assert.deepEqual(added.configs.map((c) => c.id), ["vps", "two"]);
  assert.equal(added.config.id, "two");
  // The input array is untouched: the caller decides when to persist.
  assert.equal(configs.length, 1);
});

test("an update keeps the fields the form never sees", () => {
  const configs = [device({ password: "hunter2", privateKeyPath: undefined, defaultCwd: "/srv" })];
  const updated = updateDeviceInConfigs(configs, { id: "vps", name: "Renamed" });
  assert.equal(updated.config.name, "Renamed");
  // A form that never received the password must not wipe it by omitting it.
  assert.equal(updated.config.password, "hunter2");
  assert.equal(updated.config.defaultCwd, "/srv");
  assert.equal(updated.config.host, "203.0.113.10");
  assert.match(updateDeviceInConfigs(configs, { id: "nope" }).reason ?? "", /no device/);
});

test("an empty string clears a field, because that is what the form shows", () => {
  const configs = [device({ defaultCwd: "/srv" })];
  const updated = updateDeviceInConfigs(configs, { id: "vps", defaultCwd: "" });
  assert.equal(updated.config.defaultCwd, undefined);
});

test("removing the last device leaves an empty list, not an error", () => {
  assert.deepEqual(removeDeviceFromConfigs([device()], "vps").configs, []);
  assert.match(removeDeviceFromConfigs([device()], "nope").reason ?? "", /no device/);
  // localhost is the process itself: there is no file entry to remove it from.
  assert.match(removeDeviceFromConfigs([device()], "localhost").reason ?? "", /localhost/);
});

test("a rename does not count as a connection change, so it never drops a session", () => {
  const base = device();
  // Host list edits are frequent and cheap; reconnecting to apply a label
  // would kill every open terminal and session on that machine.
  assert.equal(sameConnection(base, { ...base, name: "other", defaultCwd: "/x" }), true);
  assert.equal(sameConnection(base, { ...base, host: "other" }), false);
  assert.equal(sameConnection(base, { ...base, port: 2222 }), false);
  assert.equal(sameConnection(base, { ...base, username: "root2" }), false);
  assert.equal(sameConnection(base, { ...base, privateKeyPath: "~/.ssh/other" }), false);
  assert.equal(sameConnection(base, { ...base, password: "x" }), false);
  assert.equal(sameConnection(base, { ...base, mode: "reverse_tunnel" }), false);
});

test("what is written can be read back unchanged", () => {
  const { dir, file } = scratch();
  try {
    // Key path and password are mutually exclusive by design, so a password
    // device must not also carry a key path.
    const saved = [device({ privateKeyPath: undefined, defaultCwd: "/srv", password: "hunter2" })];
    writeDevicesFile(saved, file);
    const read = readDevicesFile(file);
    assert.equal(read.error, undefined);
    assert.deepEqual(read.issues, []);
    assert.equal(read.configs.length, 1);
    assert.equal(read.configs[0].defaultCwd, "/srv");
    assert.equal(read.configs[0].password, "hunter2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
