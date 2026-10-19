const store = await import("../lib/remote-session-store");
const dev = "fuckip-us"; const id = "01a1405a-564b-767e-8f15-ac65e7a65cf8";
let t = Date.now();
await store.openRemoteSessionManager(dev, id);
console.log("open1", Date.now() - t, "ms");
for (let i = 0; i < 3; i++) { t = Date.now(); await store.openRemoteSessionManager(dev, id); console.log("open-warm", Date.now() - t, "ms"); }
for (let i = 0; i < 3; i++) { t = Date.now(); await store.listRemoteSessions(dev, {}); console.log("list", Date.now() - t, "ms"); }
process.exit(0);
