const { getGateway } = await import("../lib/gateway/singleton");
const g = getGateway();
const d = await g.getOrConnectDriver("fuckip-us");
console.log("driver ok");

const t = Date.now();
const channel = await d.spawnPiRpc({ cwd: "/root" });
console.log("spawn ms", Date.now() - t);

const messages: any[] = [];
channel.onMessage((m) => {
  messages.push(m);
  if (m.type === "response") console.log("RESP", m.command, m.success, JSON.stringify(m.data).slice(0, 200));
});

await new Promise((r) => setTimeout(r, 300));
channel.send({ type: "get_state" });
await new Promise((r) => setTimeout(r, 1500));
channel.send({ type: "prompt", message: "reply with the single word: ok" });
await new Promise((r) => setTimeout(r, 75000));

const state = messages.find((m) => m.type === "response" && m.command === "get_state");
console.log("sessionId:", state?.data?.sessionId, "sessionFile:", state?.data?.sessionFile);
const evtTypes = messages.filter((m) => m.type !== "response").map((m) => m.type);
console.log("event count", evtTypes.length, evtTypes.slice(0, 12).join(","));
console.log("agent_end seen:", evtTypes.includes("agent_end"));

const ls = await d.exec("ls -la ~/.pi/agent/sessions/--root--/ | tail -4");
console.log("remote files:\n" + ls.stdout);
const ps = await d.exec("ps aux | grep '[p]i' | head -5");
console.log("remote procs:\n" + ps.stdout);
process.exit(0);
