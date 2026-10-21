import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// `server-only` is a Next.js marker package and is not resolvable outside a
// Next build; the parser below never touches the gateway, so an empty stub is
// enough to load the module in a plain node test.
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const { parseRemoteModelsConfig } = await jiti.import("@/lib/remote-models-config");
// Imported through the same alias the module under test uses: a relative path
// would resolve to a second copy of the class, and `instanceof` would fail.
const { ModelsConfigReadError } = await jiti.import("@/lib/models-config-store");

const PATH = "/Users/x/.pi/agent/models.json";

test("a missing file reads as no providers, exactly like the local reader", () => {
  assert.deepEqual(parseRemoteModelsConfig(null, PATH), { providers: {} });
  assert.deepEqual(parseRemoteModelsConfig("", PATH), { providers: {} });
  assert.deepEqual(parseRemoteModelsConfig("   \n", PATH), { providers: {} });
});

test("unknown keys survive a read, so a save cannot drop them", () => {
  const stored = { $schema: "https://pi.dev/schemas/models.schema.json", providers: { a: 1 }, handWritten: true };
  assert.deepEqual(parseRemoteModelsConfig(JSON.stringify(stored), PATH), stored);
});

test("comments and a BOM are tolerated, as pi's own loader tolerates them", () => {
  const text = '\uFEFF{\n  // a comment\n  "providers": { "a": 1 },\n}\n';
  assert.deepEqual(parseRemoteModelsConfig(text, PATH), { providers: { a: 1 } });
});

test("unusable contents throw instead of reading as empty", () => {
  // The panel saves its whole draft, so an empty read would delete every
  // provider on the next save.
  for (const text of ["{ broken", "[]", "null", '"a string"']) {
    assert.throws(
      () => parseRemoteModelsConfig(text, PATH),
      (error) => error instanceof ModelsConfigReadError,
      `expected a refusal for ${JSON.stringify(text)}`,
    );
  }
});

test("the refusal names the file it could not read", () => {
  assert.throws(() => parseRemoteModelsConfig("{ broken", PATH), (error) => error.message.includes(PATH));
});
