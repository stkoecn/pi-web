import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { gzipSync } from "node:zlib";

// `readRemoteSlice*` runs one shell command on the device, so a fake driver that
// answers that command is enough to pin down the two things that matter: the
// bytes come back intact whether or not the device has gzip, and a preview
// never costs a second round trip.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readRemoteSlice, readRemoteSliceWithSize } = await jiti.import(
  "./remote-files.ts",
);

const MARKER = "@@piweb-size@@";

/**
 * A driver that answers the slice script the way `sh` would.
 *
 * `gzip: false` models a device without the binary, where the script's `else`
 * branch sends plain base64.
 */
function fakeDevice(files, { gzip = true } = {}) {
  const calls = [];
  return {
    calls,
    async exec(command) {
      calls.push(command);
      // The script arrives base64-wrapped; unwrap it so the fake can look at it.
      const encoded = command.replace(/^printf %s /, "").replace(/ \| base64 -d \| sh$/, "");
      const script = Buffer.from(encoded, "base64").toString("utf8");
      const quoted = /^if \[ ! -e '([^']*)' \]/m.exec(script)?.[1];
      const path = quoted ?? "";
      const contents = files[path];
      if (contents === undefined) return { stdout: `${MARKER}-1\n`, stderr: "", exitCode: 0 };
      if (contents === null) return { stdout: `${MARKER}-2\n`, stderr: "", exitCode: 0 };

      // `head -c (offset + length) | tail -c +(offset + 1)`: the head count is
      // the END position, not the span, so subtract the offset back out.
      const offset = Number(/\| tail -c \+(\d+)/.exec(script)?.[1] ?? 1) - 1;
      const end = Number(/head -c (\d+)/.exec(script)?.[1] ?? contents.length);
      const slice = contents.subarray(offset, Math.min(end, contents.length));
      const payload = gzip ? gzipSync(slice) : slice;
      return {
        stdout: `${MARKER}${contents.length}\n${payload.toString("base64")}\n`,
        stderr: "",
        exitCode: 0,
      };
    },
  };
}

test("a slice comes back byte for byte when the device can gzip", async () => {
  const body = Buffer.from("line one\nline two\nline three\n");
  const driver = fakeDevice({ "/tmp/a.txt": body });
  const { bytes, size } = await readRemoteSliceWithSize(driver, "/tmp/a.txt", 0, 1024);
  assert.deepEqual(bytes, body);
  assert.equal(size, body.length);
  assert.equal(driver.calls.length, 1, "one round trip, size included");
});

test("a slice comes back byte for byte when the device cannot gzip", async () => {
  const body = Buffer.from("plain text, no compressor here\n");
  const driver = fakeDevice({ "/tmp/a.txt": body }, { gzip: false });
  const { bytes, size } = await readRemoteSliceWithSize(driver, "/tmp/a.txt", 0, 1024);
  assert.deepEqual(bytes, body);
  assert.equal(size, body.length);
});

test("the script asks for gzip only when the device has it", async () => {
  const driver = fakeDevice({ "/tmp/a.txt": Buffer.from("x") });
  await readRemoteSliceWithSize(driver, "/tmp/a.txt", 0, 10);
  const script = Buffer.from(
    driver.calls[0].replace(/^printf %s /, "").replace(/ \| base64 -d \| sh$/, ""),
    "base64",
  ).toString("utf8");
  // A `||` fallback would not do: a pipeline reports its last command's status,
  // and `base64` of an empty stream exits 0 — so a gzip-less device would have
  // answered with nothing.
  assert.match(script, /if command -v gzip >\/dev\/null 2>&1; then/);
  assert.doesNotMatch(script, /\|\| /);
});

test("an offset reads from the middle, not from the start", async () => {
  const body = Buffer.from("0123456789abcdef");
  const driver = fakeDevice({ "/tmp/a.txt": body });
  const { bytes } = await readRemoteSliceWithSize(driver, "/tmp/a.txt", 10, 4);
  assert.deepEqual(bytes, Buffer.from("abcd"));
});

test("a missing path and a directory are told apart without a second round trip", async () => {
  const driver = fakeDevice({ "/tmp/dir": null });
  const missing = await readRemoteSliceWithSize(driver, "/tmp/nope", 0, 10);
  assert.deepEqual(missing, { bytes: Buffer.alloc(0), size: -1 });
  const directory = await readRemoteSliceWithSize(driver, "/tmp/dir", 0, 10);
  assert.deepEqual(directory, { bytes: Buffer.alloc(0), size: -2 });
});

test("an empty file is empty, not missing", async () => {
  const driver = fakeDevice({ "/tmp/empty": Buffer.alloc(0) });
  const { bytes, size } = await readRemoteSliceWithSize(driver, "/tmp/empty", 0, 10);
  assert.equal(bytes.length, 0);
  assert.equal(size, 0);
});

test("readRemoteSlice is the same read, without the size", async () => {
  const body = Buffer.from("the whole point of sharing one script");
  const driver = fakeDevice({ "/tmp/a.txt": body });
  const bytes = await readRemoteSlice(driver, "/tmp/a.txt", 0, 1024);
  assert.deepEqual(bytes, body);
  assert.equal(driver.calls.length, 1);
});
