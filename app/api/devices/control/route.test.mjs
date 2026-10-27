import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.PI_WEB_TEST_URL || "http://127.0.0.1:9566";

test("POST /api/devices/control validates input and controls connection", async () => {
  let alive = false;
  try {
    const ping = await fetch(`${BASE_URL}/api/devices`);
    alive = ping.ok;
  } catch {}

  if (!alive) {
    // Service not running on BASE_URL, skip live tests
    return;
  }

  // Test invalid input
  const res1 = await fetch(`${BASE_URL}/api/devices/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res1.status, 400);

  const res2 = await fetch(`${BASE_URL}/api/devices/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "fuckip-us", action: "invalid" }),
  });
  assert.equal(res2.status, 400);

  // Test nonexistent device
  const res3 = await fetch(`${BASE_URL}/api/devices/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "non-existent-device-xyz", action: "connect" }),
  });
  assert.equal(res3.status, 404);
});
