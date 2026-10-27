import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.PI_WEB_TEST_URL || "http://127.0.0.1:9566";

test("GET /api/devices/env validates id and inspects environment", async () => {
  let alive = false;
  try {
    const ping = await fetch(`${BASE_URL}/api/devices`);
    alive = ping.ok;
  } catch {}

  if (!alive) {
    return;
  }

  // Missing id
  const res1 = await fetch(`${BASE_URL}/api/devices/env`);
  assert.equal(res1.status, 400);

  // Nonexistent device
  const res2 = await fetch(`${BASE_URL}/api/devices/env?id=non-existent-device-xyz`);
  assert.equal(res2.status, 404);
});

test("POST /api/devices/env validates input", async () => {
  let alive = false;
  try {
    const ping = await fetch(`${BASE_URL}/api/devices`);
    alive = ping.ok;
  } catch {}

  if (!alive) {
    return;
  }

  const res1 = await fetch(`${BASE_URL}/api/devices/env`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res1.status, 400);

  const res2 = await fetch(`${BASE_URL}/api/devices/env`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "fuckip-us", action: "invalid" }),
  });
  assert.equal(res2.status, 400);
});
