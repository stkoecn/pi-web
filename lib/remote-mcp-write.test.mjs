import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// `server-only` is a Next.js marker package and is not resolvable outside a
// Next build; everything below is handed a driver, so an empty stub is enough.
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const {
  describeRemoteMcpFile,
  editRemoteMcpFile,
  readRemoteMcpEntry,
  remoteGlobalMcpPath,
  remoteNamesInFile,
  remoteOverrideConfig,
  remoteProjectMcpPath,
  setRemoteMcpServersEnabled,
} = await jiti.import("@/lib/remote-mcp-write");

const BASE64_MARKER = "@@piweb-file@@";

/**
 * A driver whose "device" is a Map of path → contents.
 *
 * Both of the module's device operations are one `sh` script: a batched read
 * prints a marker line and then the file's base64, and a write decodes into a
 * temporary file. Rather than interpret the script, this recognises the two
 * shapes and answers them, so a test asserts what was read and what landed
 * without a real SSH connection.
 */
function deviceDriver(files) {
  const calls = [];
  const writes = [];
  return {
    calls,
    writes,
    files,
    deviceId: "dev",
    exec: async (command, _args = [], opts = {}) => {
      calls.push({ command, opts });
      const script = Buffer.from(command.split(" ")[2] ?? "", "base64").toString("utf8");
      if (script.includes("cat ") && script.includes(".tmp")) {
        // write: `base64 -d > tmp`, then `cat tmp > target`
        const payload = /printf %s '([^']*)' \| base64 -d >/.exec(script);
        const target = /cat '([^']+)' > '([^']+)'/.exec(script);
        const contents = Buffer.from(payload?.[1] ?? "", "base64").toString("utf8");
        files.set(target?.[2] ?? "", contents);
        writes.push({ path: target?.[2], contents });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // read: one marker + base64 section per existing path
      const paths = [...script.matchAll(/\[ -f '([^']+)' \]/g)].map((match) => match[1]);
      const lines = [];
      for (const [index, path] of paths.entries()) {
        const contents = files.get(path);
        if (contents === undefined) continue;
        lines.push(`${BASE64_MARKER}${index}`);
        lines.push(Buffer.from(contents, "utf8").toString("base64"));
      }
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    },
  };
}

const GLOBAL = remoteGlobalMcpPath("/Users/x/.pi/agent");
const PROJECT = remoteProjectMcpPath("/Users/x/proj");

function configText(servers) {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

test("a device's paths are the two mcp.json files the SDK reads", () => {
  assert.equal(GLOBAL, "/Users/x/.pi/agent/mcp.json");
  assert.equal(PROJECT, "/Users/x/proj/.pi/mcp.json");
});

test("a switch reads and writes the device's own file, keeping its indentation", async () => {
  const files = new Map([[GLOBAL, configText({ a: { command: "a" }, b: { command: "b" } })]]);
  const driver = deviceDriver(files);
  const outcome = await setRemoteMcpServersEnabled(driver, { scope: "global", agentDir: "/Users/x/.pi/agent" }, ["a"], false);

  assert.deepEqual(outcome.value, [{ name: "a", outcome: "changed" }]);
  assert.equal(outcome.written, true);
  assert.equal(outcome.path, GLOBAL);
  assert.deepEqual(JSON.parse(files.get(GLOBAL)).mcpServers.a, { command: "a", enabled: false });
  // The other server is untouched, and the bytes are the writer's own shape.
  assert.equal(files.get(GLOBAL), configText({ a: { command: "a", enabled: false }, b: { command: "b" } }));
});

test("switching an entry that is already there writes nothing", async () => {
  const files = new Map([[GLOBAL, configText({ a: { command: "a", enabled: false } })]]);
  const driver = deviceDriver(files);
  const outcome = await setRemoteMcpServersEnabled(driver, { scope: "global", agentDir: "/Users/x/.pi/agent" }, ["a"], false);

  assert.deepEqual(outcome.value, [{ name: "a", outcome: "unchanged" }]);
  assert.equal(outcome.written, false);
  assert.equal(driver.writes.length, 0);
});

test("an unreadable file is never overwritten", async () => {
  const broken = '{ "mcpServers": { "a": ';
  const files = new Map([[GLOBAL, broken]]);
  const driver = deviceDriver(files);
  await assert.rejects(
    () => setRemoteMcpServersEnabled(driver, { scope: "global", agentDir: "/Users/x/.pi/agent" }, ["a"], true),
    (error) => error.reason === "unparsable" && error.path === GLOBAL,
  );
  assert.equal(files.get(GLOBAL), broken);
  assert.equal(driver.writes.length, 0);
});

test("a missing file is created with the servers map", async () => {
  const files = new Map();
  const driver = deviceDriver(files);
  const outcome = await editRemoteMcpFile(
    driver,
    { scope: "project", cwd: "/Users/x/proj" },
    () => ({ changed: true, value: "done" }),
  );
  assert.equal(outcome.value, "done");
  assert.equal(outcome.written, true);
  assert.equal(files.get(PROJECT), "{}\n");
});

test("a file's servers are listed for the pane, and a broken one says why", () => {
  const good = describeRemoteMcpFile(configText({ a: { command: "a" } }), GLOBAL, "global");
  assert.deepEqual(good.info, { path: GLOBAL, scope: "global", exists: true, problems: [] });
  assert.deepEqual(good.entries.map(([name]) => name), ["a"]);

  const absent = describeRemoteMcpFile(undefined, GLOBAL, "global");
  assert.equal(absent.info.exists, false);
  assert.deepEqual(absent.entries, []);

  const broken = describeRemoteMcpFile("{", GLOBAL, "global");
  assert.equal(broken.info.problems[0].reason, "unparsable");
  assert.equal(broken.entries.length, 0);
});

test("the names a file defines are the names an add must not take", () => {
  assert.deepEqual(remoteNamesInFile(configText({ a: {}, b: {} }), GLOBAL, "global"), ["a", "b"]);
  assert.deepEqual(remoteNamesInFile(undefined, GLOBAL, "global"), []);
  assert.deepEqual(remoteNamesInFile("nonsense", GLOBAL, "global"), []);
});

test("reading an entry answers the entry, its path, and why it is missing", () => {
  const text = configText({ a: { command: "a" } });
  const found = readRemoteMcpEntry(text, GLOBAL, "global", "a");
  assert.equal(found.ok, true);
  assert.equal(found.path, GLOBAL);
  assert.deepEqual(found.value, { command: "a" });

  const missing = readRemoteMcpEntry(text, GLOBAL, "global", "b");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "server-missing");
  assert.equal(missing.error, `${GLOBAL} does not define MCP server "b"`);
});

test("a project override is read as the global server it changes", () => {
  // The override says only what it changes; the URL comes from the global entry.
  const merged = remoteOverrideConfig({ command: "a", url: "https://x/mcp" }, { enabled: false });
  assert.deepEqual(merged, { command: "a", url: "https://x/mcp", enabled: false });
  // An override with no global entry behind it changes nothing to read.
  assert.equal(remoteOverrideConfig(undefined, { enabled: true }), undefined);
});
