import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Extensionless, as the components import it: jiti keys its cache by
// specifier, so a second spelling would hand back a different module (and a
// second snapshot) than the one the components share.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { appUpdateAvailable, appUpdateSnapshot, checkAppUpdate, resetAppUpdateCheck } =
  await jiti.import("../lib/app-update-client");

function fakeFetch(answer) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return {
      ok: answer.ok ?? true,
      json: async () => answer.body,
    };
  };
  return { calls, impl };
}

test("one request answers every reader on the page", async () => {
  resetAppUpdateCheck();
  const original = globalThis.fetch;
  const { calls, impl } = fakeFetch({
    body: { currentVersion: "0.12.2", latestVersion: "0.13.0", updateAvailable: true, releaseUrl: "https://example.test/v0.13.0", piVersion: "1.3.0" },
  });
  globalThis.fetch = impl;
  try {
    assert.equal(appUpdateSnapshot(), null, "nothing is known before the first read");
    const [first, second, third] = await Promise.all([checkAppUpdate(), checkAppUpdate(), checkAppUpdate()]);
    assert.deepEqual(first, second);
    assert.deepEqual(first, third);
    assert.equal(calls.length, 1, "three readers, one request");
    assert.equal(calls[0], "/api/app-update");
    // The answer stays in hand, so the next header paints it without a request.
    assert.equal(appUpdateSnapshot()?.piVersion, "1.3.0");
    assert.deepEqual(await checkAppUpdate(), first);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
    resetAppUpdateCheck();
  }
});

test("a failed check is forgotten, so a later header asks again", async () => {
  resetAppUpdateCheck();
  const original = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("offline");
    return { ok: true, json: async () => ({ currentVersion: "0.12.2", latestVersion: "0.12.2", updateAvailable: false, releaseUrl: "", piVersion: "1.4.0" }) };
  };
  try {
    assert.equal(await checkAppUpdate(), null, "a failure reads as no answer, never as a throw");
    assert.equal(appUpdateSnapshot(), null);
    assert.equal((await checkAppUpdate())?.piVersion, "1.4.0");
    assert.equal(attempt, 2, "the second header retried");
  } finally {
    globalThis.fetch = original;
    resetAppUpdateCheck();
  }
});

test("a non-200 answer is no answer", async () => {
  resetAppUpdateCheck();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ updateAvailable: true }) });
  try {
    assert.equal(await checkAppUpdate(), null);
    assert.equal(appUpdateSnapshot(), null);
  } finally {
    globalThis.fetch = original;
    resetAppUpdateCheck();
  }
});

test("only an answer naming a newer release is offered as a link", () => {
  const base = { currentVersion: "0.12.2", latestVersion: "0.13.0", updateAvailable: true, releaseUrl: "https://example.test/v0.13.0" };
  assert.equal(appUpdateAvailable(null), null);
  assert.equal(appUpdateAvailable({ ...base, updateAvailable: false }), null, "the registry's latest is what we run");
  assert.equal(appUpdateAvailable({ ...base, releaseUrl: "" }), null, "nowhere to point the link");
  assert.equal(appUpdateAvailable({ ...base, latestVersion: "" }), null, "no version to name it by");
  assert.deepEqual(appUpdateAvailable(base), base);
});
