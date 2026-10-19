const { attachSessionProjectInfo } = await import("../lib/session-reader");
let t = Date.now();
const r = await attachSessionProjectInfo([{ path: "/root/.pi/agent/sessions/x.jsonl", id: "x", cwd: "/root", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: "a", transient: false }] as any);
console.log("attachSessionProjectInfo(/root)", Date.now() - t, "ms", JSON.stringify(r[0]?.projectKey));
t = Date.now();
await attachSessionProjectInfo([{ path: "/root/.pi/agent/sessions/x.jsonl", id: "x", cwd: "/root", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: "a", transient: false }] as any);
console.log("warm", Date.now() - t, "ms");
process.exit(0);
