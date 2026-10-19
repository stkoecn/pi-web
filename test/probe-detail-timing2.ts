const { listRemoteSessions, findRemoteSessionFile, readRemoteSessionContent } = await import("../lib/remote-session-store");
const dev = "fuckip-us";
let t = Date.now();
const list = await listRemoteSessions(dev, { force: true });
console.log("list(connect+scan)", Date.now() - t, "ms", list.length);
t = Date.now();
const f = await findRemoteSessionFile(dev, list[0].id);
console.log("find", Date.now() - t, "ms");
for (let i = 0; i < 3; i++) {
  t = Date.now();
  const c = await readRemoteSessionContent(dev, f!, { force: true });
  console.log("read", Date.now() - t, "ms", c.length, "bytes");
}
t = Date.now();
await listRemoteSessions(dev, { force: true });
console.log("list(warm)", Date.now() - t, "ms");
process.exit(0);
