import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: {
    "server-only": fileURLToPath(new URL("../../test/fixtures/server-only-stub.mjs", import.meta.url)),
  },
});

const { interceptMeshReplyFromText } = jiti("./mesh-interceptor.ts");

test("interceptMeshReplyFromText extracts and ignores empty text", async () => {
  const count = await interceptMeshReplyFromText("", "s1", "h1");
  assert.equal(count, 0);

  const count2 = await interceptMeshReplyFromText("Hello world without reply block", "s1", "h1");
  assert.equal(count2, 0);
});

test("interceptMeshReplyFromText handles :::mesh-reply[target]...::: syntax", async () => {
  const text = `
I received your instructions.

:::mesh-reply[test-session.wshome]
Task has been completed successfully! Here is the summary.
:::

Done!
`;
  assert.ok(text.includes(":::mesh-reply[test-session.wshome]"));
});
