import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildConnectConfig } = await jiti.import("./ssh-connect-config.ts");

const device = (overrides = {}) => ({
  id: "vps",
  name: "vps",
  host: "203.0.113.9",
  port: 22,
  username: "root",
  ...overrides,
});

test("a key device offers publickey first, so no round trip is spent on `none`", () => {
  // ssh2's default handler starts with `none` and waits for USERAUTH_FAILURE
  // before trying the key: one full round trip that says nothing.
  const { config } = buildConnectConfig(device({ privateKey: Buffer.from("x") }));
  assert.deepEqual(config.authHandler, ["publickey", "none"]);
});

test("a password device offers password first and keeps keyboard-interactive as the fallback", () => {
  const { config } = buildConnectConfig(device({ password: "hunter2" }));
  assert.deepEqual(config.authHandler, ["password", "keyboard-interactive", "none"]);
});

test("a device with no credentials keeps ssh2's own order", () => {
  // Nothing to prefer: let ssh2 try `none` so a tunnel endpoint that accepts
  // any user still connects.
  const { config } = buildConnectConfig(device());
  assert.equal(config.authHandler, undefined);
});

test("a key that cannot be read falls back to the password order, and says so", () => {
  const { config, warning } = buildConnectConfig(
    device({ privateKeyPath: "~/.ssh/definitely-not-here", password: "hunter2" }),
  );
  assert.match(warning, /cannot read private key for vps at /);
  assert.deepEqual(config.authHandler, ["password", "keyboard-interactive", "none"]);
});

test("the timeout and keepalive settings survive the auth change", () => {
  const { config } = buildConnectConfig(device({ privateKey: Buffer.from("x") }));
  assert.equal(config.keepaliveInterval, 10000);
  assert.equal(config.keepaliveCountMax, 3);
  assert.equal(config.readyTimeout, 15000);
  assert.equal(config.username, "root");
});
