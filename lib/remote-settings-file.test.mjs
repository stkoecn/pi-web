import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const { readRemoteFiles, writeRemoteFile } = await jiti.import("@/lib/remote-settings-file");

const MARKER = "@@piweb-file@@";

/** Answer a batched read the way the device's `sh` does: marker line + base64. */
function readerFor(files) {
  const scripts = [];
  const entries = [...files.entries()];
  return {
    scripts,
    deviceId: "dev",
    exec: async (script) => {
      scripts.push(script);
      const parts = [];
      entries.forEach(([, contents], index) => {
        if (contents === undefined) return; // absent file: no section at all
        parts.push(`${MARKER}${index}\n${Buffer.from(contents, "utf8").toString("base64")}`);
      });
      return { stdout: parts.length > 0 ? parts.join("\n") + "\n" : "", stderr: "", exitCode: 0 };
    },
  };
}

test("a file read comes back byte for byte, trailing newline included", async () => {
  // The bug this pins down: the reader used to append a newline to every file,
  // so a read-modify-write cycle (the skill toggle) grew the file by one blank
  // line each time until the whole diff was blank lines.
  const cases = [
    "no trailing newline",
    "one trailing newline\n",
    "two trailing newlines\n\n",
    "",
    "\n",
    "---\r\nname: crlf\r\n---\r\nbody\r\n",
    "unicode 中文 ✓",
  ];
  const files = new Map(cases.map((contents, index) => [`/f/${index}`, contents]));
  const read = await readRemoteFiles(readerFor(files), [...files.keys()]);
  for (const [path, contents] of files) {
    assert.equal(read.get(path), contents, `round trip changed ${JSON.stringify(contents)}`);
  }
});

test("an empty file is present and a missing file is absent", async () => {
  const read = await readRemoteFiles(readerFor(new Map([["/empty", ""], ["/gone", undefined]])), ["/empty", "/gone"]);
  // "present, zero bytes" and "absent" are different answers: the settings
  // merge writes a file that is missing but leaves an empty one alone.
  assert.equal(read.has("/empty"), true);
  assert.equal(read.get("/empty"), "");
  assert.equal(read.has("/gone"), false);
});

test("every file is read in one round trip", async () => {
  const files = new Map([["/a", "a"], ["/b", "b"], ["/c", "c"]]);
  const driver = readerFor(files);
  await readRemoteFiles(driver, [...files.keys()]);
  assert.equal(driver.scripts.length, 1, "a per-file read would cost one RTT each");
});

test("a failed read is an empty result, not an exception", async () => {
  const driver = { deviceId: "dev", exec: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }) };
  assert.equal((await readRemoteFiles(driver, ["/a"])).size, 0);
});

/** The device-side script, decoded from the base64 wrapper the driver sends. */
function innerScript(command) {
  const match = /printf %s (\S+) \| base64 -d \| sh/.exec(command);
  assert.ok(match, `not the expected wrapper: ${command}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

test("a write keeps the file's mode by copying over it instead of replacing it", async () => {
  const scripts = [];
  const driver = {
    deviceId: "dev",
    exec: async (script) => {
      scripts.push(script);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  await writeRemoteFile(driver, "/dir/settings.json", "hello\n");
  assert.equal(scripts.length, 1);
  const inner = innerScript(scripts[0]);
  assert.match(inner, /mkdir -p '\/dir'/);
  // `mv` would replace the inode and lose the file's mode.
  assert.match(inner, /cat '[^']*' > '\/dir\/settings\.json'/);
  assert.match(inner, /rm -f /, "the temp file must be cleaned up");
  // The bytes travel as base64, so no quoting can mangle them.
  const payload = Buffer.from("hello\n", "utf8").toString("base64");
  assert.ok(inner.includes(payload), "the contents must be sent base64-encoded");
});

test("a write that fails reports the device's own message", async () => {
  const driver = { deviceId: "dev", exec: async () => ({ stdout: "", stderr: "Read-only file system", exitCode: 6 }) };
  await assert.rejects(() => writeRemoteFile(driver, "/ro/x", "y"), /Read-only file system/);
});
