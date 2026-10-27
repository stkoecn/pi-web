import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

// `readSftpFile` / `writeSftpFile` are pure protocol plumbing: they only need
// the five `SFTPWrapper` calls they make, so a fake stands in for the channel
// and the test can assert on the window sizes instead of on a live device.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readSftpFile, writeSftpFile } = await jiti.import(
  "./ssh-host-driver.ts",
);

const HANDLE = Buffer.from("handle");

/**
 * A stand-in SFTP channel over an in-memory file.
 *
 * `inFlight` is the point of the exercise: the old code issued one READ at a
 * time, so a fake that records the peak number of outstanding requests can tell
 * the two implementations apart.
 */
function fakeSftp(initial = Buffer.alloc(0)) {
  let contents = Buffer.from(initial);
  const state = { reads: 0, writes: 0, peakReads: 0, peakWrites: 0, outstandingReads: 0, outstandingWrites: 0, closed: 0, opened: [] };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  return {
    contents: () => contents,
    state,
    open(path, flags, cb) {
      state.opened.push({ path, flags });
      cb(null, HANDLE);
    },
    fstat(handle, cb) {
      cb(null, { size: contents.length });
    },
    read(handle, buffer, offset, length, position, cb) {
      state.reads += 1;
      state.outstandingReads += 1;
      state.peakReads = Math.max(state.peakReads, state.outstandingReads);
      settle().then(() => {
        const available = Math.max(0, Math.min(length, contents.length - position));
        contents.copy(buffer, offset, position, position + available);
        state.outstandingReads -= 1;
        cb(null, available);
      });
    },
    write(handle, buffer, offset, length, position, cb) {
      state.writes += 1;
      state.outstandingWrites += 1;
      state.peakWrites = Math.max(state.peakWrites, state.outstandingWrites);
      settle().then(() => {
        const needed = position + length;
        if (needed > contents.length) {
          const grown = Buffer.alloc(needed);
          contents.copy(grown, 0, 0, contents.length);
          contents = grown;
        }
        buffer.copy(contents, position, offset, offset + length);
        state.outstandingWrites -= 1;
        cb(null);
      });
    },
    close(handle, cb) {
      state.closed += 1;
      cb();
    },
  };
}

test("a whole file comes back byte for byte", async () => {
  const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) & 0xff));
  const sftp = fakeSftp(payload);
  const read = await readSftpFile(sftp, "/tmp/file.bin", { chunkSize: 512, concurrency: 4 });
  assert.deepEqual(read, payload);
  // The handle is always released, even on the happy path.
  assert.equal(sftp.state.closed, 1);
});

test("reads go out in parallel, which is the whole point", async () => {
  const payload = Buffer.alloc(64 * 1024, 7);
  const sftp = fakeSftp(payload);
  await readSftpFile(sftp, "/tmp/file.bin", { chunkSize: 4096, concurrency: 8 });
  // One READ at a time was the old behaviour (peak 1) and cost a round trip per
  // chunk. Several in flight is what makes a 1 MiB file take 3 s instead of 8 s
  // on a 282 ms link.
  assert.ok(sftp.state.peakReads > 1, `expected parallel reads, saw ${sftp.state.peakReads}`);
  assert.equal(sftp.state.reads, 16);
});

test("an empty file reads as empty without issuing a READ", async () => {
  const sftp = fakeSftp(Buffer.alloc(0));
  const read = await readSftpFile(sftp, "/tmp/empty", { chunkSize: 1024, concurrency: 4 });
  assert.equal(read.length, 0);
  assert.equal(sftp.state.reads, 0);
});

test("a short final chunk is asked for only as long as the file", async () => {
  const sftp = fakeSftp(Buffer.alloc(1000, 1));
  const asked = [];
  const spy = { ...sftp, read: (h, b, off, len, pos, cb) => { asked.push(len); sftp.read(h, b, off, len, pos, cb); } };
  await readSftpFile(spy, "/tmp/file", { chunkSize: 400, concurrency: 1 });
  // 400 + 400 + 200: never a READ past the end.
  assert.deepEqual(asked, [400, 400, 200]);
});

test("a whole file is written back byte for byte, in parallel windows", async () => {
  const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 17 + 3) & 0xff));
  const sftp = fakeSftp();
  await writeSftpFile(sftp, "/tmp/file.bin", payload, { chunkSize: 512, concurrency: 4 });
  assert.deepEqual(sftp.contents(), payload);
  assert.ok(sftp.state.peakWrites > 1, `expected parallel writes, saw ${sftp.state.peakWrites}`);
  assert.equal(sftp.state.closed, 1);
});

test("writing an empty buffer still creates the file and closes it", async () => {
  const sftp = fakeSftp();
  await writeSftpFile(sftp, "/tmp/empty", Buffer.alloc(0));
  assert.equal(sftp.contents().length, 0);
  assert.equal(sftp.state.writes, 0);
  assert.equal(sftp.state.closed, 1);
  assert.deepEqual(sftp.state.opened, [{ path: "/tmp/empty", flags: "w" }]);
});

test("a failed READ rejects and still closes the handle", async () => {
  const sftp = fakeSftp(Buffer.alloc(4096));
  sftp.read = (handle, buffer, offset, length, position, cb) => {
    cb(new Error("device said no"));
  };
  await assert.rejects(
    () => readSftpFile(sftp, "/tmp/file", { chunkSize: 1024, concurrency: 2 }),
    /device said no/,
  );
  assert.equal(sftp.state.closed, 1);
});

test("a failed open rejects without pretending to have a handle", async () => {
  const sftp = fakeSftp();
  sftp.open = (path, flags, cb) => cb(new Error("No such file"));
  await assert.rejects(() => readSftpFile(sftp, "/tmp/missing"), /No such file/);
  assert.equal(sftp.state.closed, 0);
});
