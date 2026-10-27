import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

// POST /api/devices/reload is what makes a hand-edited devices.json take effect
// without a restart. These cases stub the gateway, so what is checked is the
// answer the button shows: which hosts are connected now, and why a file that
// cannot be read changes nothing.
const root = mkdtempSync(join(tmpdir(), "pi-web-devices-reload-"));
const file = join(root, "devices.json");

let outcome;
const gateway = {
  configPath: () => file,
  registry: { list: () => [{ id: "localhost", name: "Local Host", mode: "active_ssh", status: "online" }] },
  reloadDevicesFromFile: async () => outcome,
};
globalThis.__piWebGateway = gateway;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { POST } = await jiti.import("./route.ts");

const config = (id) => ({ id, name: id, host: "h", port: 22, username: "u", mode: "active_ssh" });

beforeEach(() => {
  writeFileSync(file, JSON.stringify([config("a"), config("b")]));
  outcome = {
    path: file,
    configs: [config("a"), config("b")],
    issues: [],
    sync: { connected: [], removed: [], unchanged: ["a", "b"] },
  };
});
after(() => {
  delete globalThis.__piWebGateway;
  rmSync(root, { recursive: true, force: true });
});

test("a reload that changed nothing says so and keeps every connection", async () => {
  const res = await POST();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, file);
  assert.deepEqual(body.configuredIds, ["a", "b"]);
  assert.deepEqual(body.sync.unchanged, ["a", "b"]);
  assert.equal(body.devices[0].id, "localhost");
});

test("a reload that added a host reports what was connected", async () => {
  outcome = { ...outcome, configs: [config("a"), config("b"), config("c")], sync: { connected: ["c"], removed: [], unchanged: ["a", "b"] } };
  const body = await (await POST()).json();
  assert.deepEqual(body.sync.connected, ["c"]);
  assert.deepEqual(body.configuredIds, ["a", "b", "c"]);
});

test("an unusable file answers 409 and names the path, so nothing is dropped", async () => {
  outcome = { path: file, configs: [], issues: [], error: "devices.json is not valid JSON: Unexpected token" };
  const res = await POST();
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /not valid JSON/);
  // The path matters: a reload most often fails because it is reading a
  // different file than the one being edited.
  assert.equal(body.path, file);
});

test("entries the file could not use still leave the good ones connected", async () => {
  outcome = {
    ...outcome,
    issues: [{ index: 1, id: "b", reason: "missing username" }],
    sync: { connected: [], removed: ["b"], unchanged: ["a"] },
  };
  const body = await (await POST()).json();
  assert.equal(body.issues[0].reason, "missing username");
  assert.deepEqual(body.sync.removed, ["b"]);
});
