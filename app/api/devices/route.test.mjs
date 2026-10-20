import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";

// The devices API is the only writer of devices.json, so these cases run it
// against a scratch file and a stubbed gateway: what matters here is what
// reaches the file and what the browser is told, not whether SSH connects.
const root = mkdtempSync(join(tmpdir(), "pi-web-devices-route-"));
const file = join(root, "devices.json");

const syncs = [];
/** The configs the gateway now believes are live; `listConfiguredDevices` reads it back. */
let configured = [];
const gateway = {
  configPath: () => file,
  registry: { list: () => [{ id: "localhost", name: "Local Host", mode: "active_ssh", status: "online" }] },
  // Mirrors the real gateway: connected devices plus configured reverse-tunnel
  // devices that have not dialled in, so a waiting host still appears.
  listDevices: () => [
    { id: "localhost", name: "Local Host", mode: "active_ssh", status: "online" },
    ...configured
      .filter((c) => c.mode === "reverse_tunnel")
      .map((c) => ({
        id: c.id,
        name: c.name,
        mode: "reverse_tunnel",
        remoteAddr: "",
        status: "offline",
        lastSeen: 0,
      })),
  ],
  listConfiguredDevices: () => configured.map((c) => ({ ...c })),
  syncDevices: async (configs) => {
    syncs.push(configs.map((c) => c.id));
    configured = configs.map((c) => ({ ...c }));
    return { connected: [], removed: [], unchanged: configs.map((c) => c.id) };
  },
};

globalThis.__piWebGateway = gateway;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET, POST, PUT, DELETE } = await jiti.import("./route.ts");

const initial = [
  {
    id: "wsmac",
    name: "wsmac (Mac Mini)",
    host: "192.168.1.7",
    port: 22,
    username: "windsing",
    privateKeyPath: "~/.ssh/wshome",
  },
  {
    id: "vps",
    name: "VPS",
    host: "203.0.113.10",
    port: 2222,
    username: "root",
    password: "hunter2",
  },
];

before(() => writeFileSync(file, JSON.stringify(initial, null, 2)));
beforeEach(() => {
  syncs.length = 0;
  configured = initial.map((c) => ({ ...c, mode: "active_ssh" }));
  writeFileSync(file, JSON.stringify(initial, null, 2));
});
after(() => {
  delete globalThis.__piWebGateway;
  rmSync(root, { recursive: true, force: true });
});

const request = (method, body, query = "") =>
  new Request(`http://127.0.0.1:9564/api/devices${query}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

const saved = () => JSON.parse(readFileSync(file, "utf8"));

test("GET reports the file's path, its entries and no secrets", async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configPath, file);
  assert.equal(body.devices[0].id, "localhost");
  assert.deepEqual(body.configs.map((c) => c.id), ["wsmac", "vps"]);
  // The password itself must not travel to the browser, only the fact of one.
  assert.equal(body.configs[1].hasPassword, true);
  assert.equal(body.configs[1].password, undefined);
  assert.deepEqual(body.issues, []);
});

test("POST writes the device, then asks the gateway to connect it", async () => {
  const res = await POST(request("POST", {
    id: "new-box",
    name: "New Box",
    host: "198.51.100.4",
    port: "2200",
    username: "deploy",
    privateKeyPath: "~/.ssh/new",
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deviceId, "new-box");
  assert.equal(body.config.port, 2200);
  assert.deepEqual(saved().map((c) => c.id), ["wsmac", "vps", "new-box"]);
  assert.deepEqual(syncs, [["wsmac", "vps", "new-box"]]);
});

test("POST refuses a duplicate id with 409, and leaves the file alone", async () => {
  const res = await POST(request("POST", initial[0]));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already exists/);
  assert.deepEqual(saved().map((c) => c.id), ["wsmac", "vps"]);
  assert.equal(syncs.length, 0);
});

test("POST rejects an id that would break URLs, and a missing host", async () => {
  const badId = await POST(request("POST", { id: "my box", host: "h", username: "u" }));
  assert.equal(badId.status, 400);
  assert.match((await badId.json()).error, /may use only letters/);

  const noHost = await POST(request("POST", { id: "box", username: "u" }));
  assert.equal(noHost.status, 400);
  assert.match((await noHost.json()).error, /host/);
  assert.deepEqual(saved().map((c) => c.id), ["wsmac", "vps"]);
});

test("POST warns that key contents are not persisted, since the file is committed", async () => {
  const res = await POST(request("POST", {
    id: "inline", host: "h", username: "u", privateKey: "-----BEGIN KEY-----",
  }));
  assert.equal(res.status, 200);
  assert.match((await res.json()).warning ?? "", /privateKey contents are not saved/);
  assert.equal(readFileSync(file, "utf8").includes("BEGIN KEY"), false);
});

test("PUT renames in place and keeps the credential the form never saw", async () => {
  const res = await PUT(request("PUT", { id: "vps", name: "Renamed VPS" }));
  assert.equal(res.status, 200);
  const after = saved();
  assert.deepEqual(after.map((c) => c.id), ["wsmac", "vps"]);
  assert.equal(after[1].name, "Renamed VPS");
  // The pane never received the password, so an edit must not drop it.
  assert.equal(after[1].password, "hunter2");
  assert.equal(after[1].port, 2222);
});

test("PUT answers 404 for an unknown device and 400 for an invalid field", async () => {
  assert.equal((await PUT(request("PUT", { id: "nope", name: "x" }))).status, 404);
  assert.equal((await PUT(request("PUT", { id: "vps", port: "abc" }))).status, 400);
  assert.equal((await PUT(request("PUT", { id: "vps", port: 70000 }))).status, 400);
});

test("DELETE removes the entry and refuses the process itself", async () => {
  const res = await DELETE(request("DELETE", undefined, "?id=vps"));
  assert.equal(res.status, 200);
  assert.deepEqual(saved().map((c) => c.id), ["wsmac"]);
  assert.deepEqual(syncs, [["wsmac"]]);

  assert.equal((await DELETE(request("DELETE", undefined, "?id=vps"))).status, 404);
  assert.equal((await DELETE(request("DELETE", undefined, "?id=localhost"))).status, 400);
  assert.equal((await DELETE(request("DELETE", undefined))).status, 400);
});

test("a file that cannot be parsed is reported instead of overwritten", async () => {
  writeFileSync(file, "{ broken");
  const get = await GET();
  assert.equal(get.status, 200);
  assert.match((await get.json()).fileError, /not valid JSON/);

  // Writing over a file we could not read would throw away every device in it.
  assert.equal((await POST(request("POST", { id: "x", host: "h", username: "u" }))).status, 409);
  assert.equal(readFileSync(file, "utf8"), "{ broken");
});

test("a reverse-tunnel device that has not dialled in is still listed", async () => {
  const res = await POST(request("POST", {
    id: "home", name: "Home (dial-in)", mode: "reverse_tunnel", username: "windsing",
  }));
  assert.equal(res.status, 200);

  const body = await (await GET()).json();
  const waiting = body.devices.find((d) => d.id === "home");
  // Absent would mean the user cannot see or select the host they just added.
  assert.ok(waiting, "configured reverse-tunnel device must appear");
  assert.equal(waiting.status, "offline");
  assert.equal(waiting.mode, "reverse_tunnel");
  // No address is invented: nothing is known until it connects.
  assert.equal(waiting.remoteAddr, "");
});

test("a reverse-tunnel device needs no host or port in the file", async () => {
  const res = await POST(request("POST", { id: "home", mode: "reverse_tunnel", username: "windsing" }));
  assert.equal(res.status, 200);
  const entry = saved().find((c) => c.id === "home");
  assert.equal(entry.mode, "reverse_tunnel");
  assert.equal(entry.port, 0);
  assert.equal(entry.host, "127.0.0.1");
});
