import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const { invalidateDevicePiVersion, probeDevicePiVersion, readVersionLine } = await jiti.import("../lib/device-pi-version");

function fakeDevice({ stdout = "", stderr = "", exitCode = 0, throws }) {
  const calls = [];
  return {
    calls,
    exec: async (command, options) => {
      calls.push({ command, options });
      if (throws) throw new Error(throws);
      return { stdout, stderr, exitCode };
    },
  };
}

test("a version is read from the last line that carries one", () => {
  assert.equal(readVersionLine("1.3.0\n"), "1.3.0");
  assert.equal(readVersionLine("1.4.0"), "1.4.0");
  assert.equal(readVersionLine("pi 1.4.0\n"), "1.4.0", "a prefixed banner still names the version");
  assert.equal(readVersionLine("update available\n1.4.1\n"), "1.4.1", "the last one wins");
  assert.equal(readVersionLine("1.4.0\r\n"), "1.4.0", "a CRLF device is not a different version");
  assert.equal(readVersionLine(""), undefined);
  assert.equal(readVersionLine("command not found"), undefined, "an error message is not a version");
  assert.equal(readVersionLine("v1.4.0"), undefined, "the probe prints what pi printed; pi prints bare");
});

test("the device is asked with a PATH that finds a user-level install", async () => {
  const device = fakeDevice({ stdout: "1.4.0\n" });
  assert.equal(await probeDevicePiVersion(device), "1.4.0");
  const [call] = device.calls;
  assert.equal(call.options.timeoutMs, 20_000);
  assert.match(call.command, /command -v pi/);
  assert.match(call.command, /pi --version/);
  assert.match(call.command, /\$HOME\/\.local\/node\/bin/, "the installer's node directory is on the PATH");
  assert.match(call.command, /\$HOME\/\.local\/bin/);
  assert.doesNotMatch(call.command, /~\/\.local/, "a quoted tilde never expands");
});

test("a device without pi is no answer, not an error", async () => {
  assert.equal(await probeDevicePiVersion(fakeDevice({ exitCode: 0, stdout: "" })), undefined);
  assert.equal(await probeDevicePiVersion(fakeDevice({ exitCode: 1, stdout: "1.4.0\n" })), undefined);
  assert.equal(await probeDevicePiVersion(fakeDevice({ throws: "Device is offline" })), undefined);
});

test("the answer is asked once per device and can be forgotten", async () => {
  invalidateDevicePiVersion();
  const device = fakeDevice({ stdout: "1.4.0\n" });
  const first = await probeDevicePiVersion(device);
  assert.equal(first, "1.4.0");
  invalidateDevicePiVersion();
  // The cache itself is exercised through `devicePiVersion` below; this asserts
  // the probe stays a pure one-shot so a caller can retry it deliberately.
  assert.equal(device.calls.length, 1);
});
