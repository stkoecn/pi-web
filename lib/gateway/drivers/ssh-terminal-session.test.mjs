import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SSHHostDriver } = await jiti.import("./ssh-host-driver.ts");
const { PersistentShellPool } = await jiti.import("./persistent-shell.ts");
const { isChannelOpenFailure, withChannelRetry } = await jiti.import("./channel-retry.ts");

/**
 * Mock SSH2 Client that simulates OpenSSH MaxSessions channel limitation.
 */
class FakeSshClient extends EventEmitter {
  constructor(maxChannels = 10) {
    super();
    this.maxChannels = maxChannels;
    this.currentChannels = 0;
    this.totalAttempts = 0;
    this.channels = [];
  }

  createFakeStream() {
    const stream = new EventEmitter();
    stream.destroyed = false;
    stream.stdin = stream;
    stream.stderr = new EventEmitter();
    stream.write = (_data) => true;
    stream.end = () => {};
    stream.setWindow = () => {};
    stream.close = () => {
      if (!stream.destroyed) {
        stream.destroyed = true;
        this.currentChannels = Math.max(0, this.currentChannels - 1);
        stream.emit("close", 0);
      }
    };
    stream.destroy = () => {
      stream.close();
    };
    return stream;
  }

  shell(pty, cb) {
    this.totalAttempts++;
    if (this.currentChannels >= this.maxChannels) {
      const err = new Error("(SSH) Channel open failure: open failed");
      return cb(err);
    }
    this.currentChannels++;
    const stream = this.createFakeStream();
    this.channels.push(stream);
    cb(null, stream);
  }

  exec(cmd, optsOrCb, maybeCb) {
    const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
    this.totalAttempts++;
    if (this.currentChannels >= this.maxChannels) {
      const err = new Error("(SSH) Channel open failure: open failed");
      return cb(err);
    }
    this.currentChannels++;
    const stream = this.createFakeStream();
    this.channels.push(stream);
    cb(null, stream);
  }

  sftp(cb) {
    this.totalAttempts++;
    if (this.currentChannels >= this.maxChannels) {
      return cb(new Error("(SSH) Channel open failure: open failed"));
    }
    this.currentChannels++;
    const sftpObj = new EventEmitter();
    cb(null, sftpObj);
  }
}

test("isChannelOpenFailure correctly detects SSH channel exhaustion errors", () => {
  assert.equal(isChannelOpenFailure(new Error("(SSH) Channel open failure: open failed")), true);
  assert.equal(isChannelOpenFailure(new Error("open failed")), true);
  assert.equal(isChannelOpenFailure(new Error("Channel open failure: administratively prohibited")), true);
  assert.equal(isChannelOpenFailure(new Error("MaxSessions limit reached")), true);
  assert.equal(isChannelOpenFailure(new Error("Connection reset by peer")), false);
  assert.equal(isChannelOpenFailure(new Error("Permission denied")), false);
});

test("PersistentShellPool allows evicting idle shells to release channels", async () => {
  const fakeClient = new FakeSshClient(10);
  const pool = new PersistentShellPool(fakeClient, "test-device", 2);

  assert.equal(typeof pool.evictIdleShells, "function");
  assert.equal(pool.evictIdleShells(1), 0);

  pool.dispose();
});

test("SSHHostDriver automatically evicts idle shells when channel open failure occurs during createTerminal", async () => {
  // Setup client with max 3 channels
  const fakeClient = new FakeSshClient(3);
  const driver = new SSHHostDriver("test-dev", fakeClient);

  // Pre-occupy 2 channels with fake streams
  fakeClient.createFakeStream();
  fakeClient.createFakeStream();
  fakeClient.currentChannels = 2;

  // Let pool hold 1 idle shell -> currentChannels becomes 3 (100% full!)
  const pool = driver.getShellPool();
  const fakeShell = {
    busy: false,
    isUsable: () => true,
    dispose: () => {
      fakeClient.currentChannels--;
    },
  };
  pool.shells.push(fakeShell);
  fakeClient.currentChannels = 3;

  assert.equal(fakeClient.currentChannels, 3);

  // Now createTerminal will first hit (currentChannels >= maxChannels),
  // which will trigger onRetry -> evictIdleShells -> fakeClient.currentChannels goes to 2 -> retry succeeds!
  const session = await driver.createTerminal({ cols: 80, rows: 24 });
  assert.ok(session);
  assert.equal(session.isAlive(), true);

  // Cleaning up terminal session frees channel
  session.close();
  assert.equal(session.isAlive(), false);

  await driver.close();
});

test("SSHHostDriver automatically evicts idle shells when channel open failure occurs during spawnPiRpc", async () => {
  const fakeClient = new FakeSshClient(3);
  const driver = new SSHHostDriver("test-dev", fakeClient);

  fakeClient.currentChannels = 2;
  const pool = driver.getShellPool();
  const fakeShell = {
    busy: false,
    isUsable: () => true,
    dispose: () => {
      fakeClient.currentChannels--;
    },
  };
  pool.shells.push(fakeShell);
  fakeClient.currentChannels = 3;

  // spawnPiRpc hits channel limit, triggers evictIdleShells, and succeeds on retry
  const rpc = await driver.spawnPiRpc();
  assert.ok(rpc);

  rpc.close();
  await driver.close();
});

test("withChannelRetry invokes onRetry hook upon channel open refusal", async () => {
  let attempts = 0;
  let retryHookCalled = 0;

  const res = await withChannelRetry(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("(SSH) Channel open failure: open failed");
      }
      return "success";
    },
    {
      attempts: 4,
      baseDelayMs: 10,
      onRetry: async (_err, attempt) => {
        retryHookCalled++;
        assert.ok(_err);
      },
    },
  );

  assert.equal(res, "success");
  assert.equal(attempts, 3);
  assert.equal(retryHookCalled, 2);
});
