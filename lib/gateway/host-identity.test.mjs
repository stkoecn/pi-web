import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getCanonicalHostId, isLocalHostId } = await jiti.import("./host-identity.ts");

test("host-identity canonicalHostId and isLocalHostId", () => {
  const hostId = getCanonicalHostId();
  assert.ok(hostId && typeof hostId === "string");
  assert.notEqual(hostId, "localhost");

  // Local identifiers should all resolve to true
  assert.equal(isLocalHostId("localhost"), true);
  assert.equal(isLocalHostId("local"), true);
  assert.equal(isLocalHostId("127.0.0.1"), true);
  assert.equal(isLocalHostId("::1"), true);
  assert.equal(isLocalHostId(hostId), true);
  assert.equal(isLocalHostId(hostId.toUpperCase()), true);

  // Remote identifiers should resolve to false
  assert.equal(isLocalHostId("wsnas"), false);
  assert.equal(isLocalHostId("192.168.1.5"), false);
});
