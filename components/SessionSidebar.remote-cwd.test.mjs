import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * A remote device's workspace is only *defaulted* to its home, never forced to
 * it. Opening a workspace runs `/api/sessions` three times; each response used
 * to re-adopt the device home, which moved the composer out from under a
 * `?cwd=/some/project` the URL asked for. `handleCwdChange` then navigated to
 * the bare page, so a new remote session lost `?cwd=` and, once the first
 * message created it, appeared to bounce back to the home page instead of
 * staying on its session.
 *
 * The updater is extracted from `loadSessions` so this stays a statement about
 * the shipped code rather than a parallel reimplementation.
 */

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

function updaterSource() {
  const start = source.indexOf("      setSelectedCwd((prev) => {");
  assert.notEqual(start, -1, "setSelectedCwd updater in loadSessions not found");
  const end = source.indexOf("      });", start);
  assert.notEqual(end, -1, "setSelectedCwd updater is not terminated");
  return source.slice(start, end + "      });".length);
}

/** Run `updater` with the given `prev`, deviceId and device home. */
function adopt(prev, { deviceId, home, pendingSession = null }) {
  const code = ts.transpileModule(updaterSource(), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  let result;
  const getRecentProjects = () => [{ root: "/work/alpha" }];
  const deviceHomeOrRoot = () => home;
  vm.runInNewContext(code, {
    currentDeviceId: deviceId,
    data: { sessions: [] },
    deviceHomeOrRoot,
    getRecentProjects,
    pendingInitialSessionRef: { current: pendingSession },
    setSelectedCwd: (updater) => { result = updater(prev); },
  });
  return result;
}

test("a remote device keeps the workspace the URL asked for instead of re-adopting its home", () => {
  const previous = "/Users/me/proj/test";
  assert.equal(adopt(previous, { deviceId: "wsmac", home: "/Users/me" }), previous);
  // The same holds for a device path the home lookup has not resolved yet.
  assert.equal(adopt("/root/work", { deviceId: "fuckip-us", home: "/root" }), "/root/work");
});

test("a remote device still lands on its home while the workspace is only the placeholder", () => {
  assert.equal(adopt(null, { deviceId: "wsmac", home: "/Users/me" }), "/Users/me");
  assert.equal(adopt("/", { deviceId: "wsmac", home: "/Users/me" }), "/Users/me");
});

test("a local session list keeps its behaviour: the first project only when nothing is selected", () => {
  assert.equal(adopt(null, { deviceId: "localhost", home: "/Users/me" }), "/work/alpha");
  assert.equal(adopt("/work/beta", { deviceId: "localhost", home: "/Users/me" }), "/work/beta");
});

test("a `?session=` the URL asked for owns the cwd until the restore effect picks it", () => {
  // Adopting a cwd here fires onCwdChange, and the shell then navigates to the
  // bare href — wiping the `?session=` the page was opened with.
  assert.equal(
    adopt(null, { deviceId: "wsmac", home: "/Users/me", pendingSession: "01a15920" }),
    null,
  );
  assert.equal(
    adopt("/Users/me/proj/test", { deviceId: "localhost", home: "/Users/me", pendingSession: "01a15920" }),
    "/Users/me/proj/test",
  );
});
