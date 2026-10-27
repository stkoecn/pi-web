import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isChannelOpenFailure, withChannelRetry } = await jiti.import("./channel-retry.ts");

const failure = () => new Error("(SSH) Channel open failure: open failed");

test("a refused channel open is recognised, an ordinary failure is not", () => {
  assert.equal(isChannelOpenFailure(failure()), true);
  assert.equal(isChannelOpenFailure("(SSH) Channel open failure: administratively prohibited"), true);
  assert.equal(isChannelOpenFailure(new Error("resource shortage")), true);
  assert.equal(isChannelOpenFailure(new Error("connect ECONNREFUSED 1.2.3.4:22")), false);
  assert.equal(isChannelOpenFailure(new Error("All configured authentication methods failed")), false);
  assert.equal(isChannelOpenFailure(undefined), false);
});

test("a transient refusal is retried until the channel opens", async () => {
  let attempts = 0;
  const value = await withChannelRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw failure();
    return "opened";
  }, { baseDelayMs: 1 });
  assert.equal(value, "opened");
  assert.equal(attempts, 3);
});

test("retrying stops at the attempt budget and rethrows the server's error", async () => {
  let attempts = 0;
  await assert.rejects(
    withChannelRetry(async () => {
      attempts += 1;
      throw failure();
    }, { attempts: 3, baseDelayMs: 1 }),
    /Channel open failure/,
  );
  assert.equal(attempts, 3);
});

test("an error that is not a channel refusal is not retried", async () => {
  let attempts = 0;
  await assert.rejects(
    withChannelRetry(async () => {
      attempts += 1;
      throw new Error("All configured authentication methods failed");
    }, { baseDelayMs: 1 }),
    /authentication methods failed/,
  );
  assert.equal(attempts, 1);
});
