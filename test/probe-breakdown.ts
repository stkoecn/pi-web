const t0 = Date.now();
const { getGateway } = await import("../lib/gateway/singleton");
const g = getGateway();
const d = await g.getOrConnectDriver("fuckip-us");
console.log("connect", Date.now() - t0);

const t1 = Date.now();
const dir = await d.exec('printf "%s" "$HOME/.pi/agent/sessions"');
console.log("resolveSessionsDir", Date.now() - t1, JSON.stringify(dir.stdout));

const t2 = Date.now();
const cat = await d.exec(
  "cd /root/.pi/agent/sessions && find . -name '*.jsonl' -type f -printf '%p\\t%s\\t%T@\\n' 2>/dev/null | head -n 200",
);
console.log("scanCatalogue", Date.now() - t2, cat.stdout.split("\n").length - 1);

const t3 = Date.now();
const det = await d.exec(
  "for f in /root/.pi/agent/sessions/--root--/*.jsonl; do printf '@@%s\\n' \"$f\"; head -n 1 \"$f\"; awk '/\"type\":\"message\"/{c++} END{print \"@@count \" c+0}' \"$f\"; done",
);
console.log("scanDetails", Date.now() - t3, det.stdout.split("\n").length);

const { listRemoteSessions, invalidateRemoteSessionCache } = await import("../lib/remote-session-store");
invalidateRemoteSessionCache("fuckip-us");
const t4 = Date.now();
const s = await listRemoteSessions("fuckip-us", { force: true });
console.log("listRemoteSessions", Date.now() - t4, s.length);
process.exit(0);
