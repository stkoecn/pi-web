import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  mergeDefaultPreferences,
  parseSettingsObject,
  readDefaultsFromSettings,
  serializeSettings,
  shadowingRemoteProjectKeys,
  writtenKeys,
} = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./remote-settings-merge.ts");

test("an edit adds its keys and leaves every other key alone", () => {
  const current = {
    defaultProvider: "openai",
    defaultModel: "gpt-5",
    lastChangelogVersion: "1.3.0",
    handWritten: { nested: true },
  };
  const merged = mergeDefaultPreferences(current, { model: { provider: "stkoe", modelId: "glm-5" } });
  assert.deepEqual(merged, {
    defaultProvider: "stkoe",
    defaultModel: "glm-5",
    lastChangelogVersion: "1.3.0",
    handWritten: { nested: true },
  });
  assert.equal(current.defaultProvider, "openai", "the input object must not be mutated");
});

test("a thinking-level edit does not touch the saved model", () => {
  const merged = mergeDefaultPreferences(
    { defaultProvider: "openai", defaultModel: "gpt-5" },
    { thinkingLevel: "low" },
  );
  assert.equal(merged.defaultProvider, "openai");
  assert.equal(merged.defaultModel, "gpt-5");
  assert.equal(merged.defaultThinkingLevel, "low");
});

test("a missing file produces just the edited keys", () => {
  const merged = mergeDefaultPreferences(null, { thinkingLevel: "max" });
  assert.deepEqual(merged, { defaultThinkingLevel: "max" });
});

test("both edits at once write all three keys", () => {
  const merged = mergeDefaultPreferences(null, {
    model: { provider: "stkoe", modelId: "glm-5" },
    thinkingLevel: "medium",
  });
  assert.deepEqual(merged, {
    defaultProvider: "stkoe",
    defaultModel: "glm-5",
    defaultThinkingLevel: "medium",
  });
  assert.deepEqual(writtenKeys({ model: { provider: "a", modelId: "b" }, thinkingLevel: "medium" }),
    ["defaultProvider", "defaultModel", "defaultThinkingLevel"]);
});

test("writtenKeys reports only what the edit changes", () => {
  assert.deepEqual(writtenKeys({ model: { provider: "a", modelId: "b" } }), ["defaultProvider", "defaultModel"]);
  assert.deepEqual(writtenKeys({ thinkingLevel: "low" }), ["defaultThinkingLevel"]);
});

test("comments are accepted, a broken file is reported instead of replaced", () => {
  const parsed = parseSettingsObject(`{
    // which provider
    "defaultProvider": "openai",
    "defaultModel": "gpt-5",
  }`);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.defaultProvider, "openai");

  const broken = parseSettingsObject("{ broken json");
  assert.equal(broken.value, null);
  assert.ok(broken.error, "a file that cannot be parsed must report why");

  const array = parseSettingsObject("[1,2,3]");
  assert.equal(array.value, null);
  assert.equal(array.error, "not a JSON object");

  assert.deepEqual(parseSettingsObject("   "), { value: null }, "an empty file is simply empty");
});

test("serialized settings end with exactly one newline", () => {
  const newline = serializeSettings({ a: 1 }, "{\n  \"a\": 0\n}\n");
  assert.ok(newline.endsWith("}\n"), "a file that ended with a newline keeps one");
  assert.equal(newline.indexOf("}\n"), newline.length - 2);

  const noNewline = serializeSettings({ a: 1 }, "{\"a\":0}");
  assert.ok(noNewline.endsWith("\n"), "the writer always ends with a newline so later appends stay clean");

  const created = serializeSettings({ a: 1 }, null);
  assert.ok(created.endsWith("\n"), "a new file ends with a newline too");
});

test("project settings shadow only the keys they define", () => {
  const project = { defaultProvider: "openai", defaultModel: "gpt-5" };
  assert.deepEqual(
    shadowingRemoteProjectKeys(project, { model: { provider: "stkoe", modelId: "glm-5" } }),
    ["defaultProvider", "defaultModel"],
  );
  assert.deepEqual(
    shadowingRemoteProjectKeys(project, { thinkingLevel: "low" }),
    [],
    "a project that sets no thinking level cannot hide a global one",
  );
  assert.deepEqual(shadowingRemoteProjectKeys(null, { model: { provider: "a", modelId: "b" } }), []);
});

test("reading defaults ignores non-string and empty values", () => {
  const read = readDefaultsFromSettings({
    defaultProvider: "openai",
    defaultModel: "",
    defaultThinkingLevel: 42,
  });
  assert.equal(read.defaultProvider, "openai");
  assert.equal(read.defaultModel, null, "an empty model name is not a model");
  assert.equal(read.defaultThinkingLevel, null, "a number is not a thinking level");

  assert.deepEqual(readDefaultsFromSettings(null), {
    defaultProvider: null,
    defaultModel: null,
    defaultThinkingLevel: null,
  });
});
