const t0 = Date.now();
const { getGateway } = await import("../lib/gateway/singleton");
const g = getGateway();
const d = await g.getOrConnectDriver("fuckip-us");
console.log("connect", Date.now() - t0);
for (let i = 0; i < 6; i++) {
  const t = Date.now();
  await d.exec("echo hi");
  console.log(`exec#${i}`, Date.now() - t);
}
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  await d.readDir("/root/.pi/agent/sessions");
  console.log(`readDir#${i}`, Date.now() - t);
}
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  await d.stat("/root/.pi/agent/sessions");
  console.log(`stat#${i}`, Date.now() - t);
}
process.exit(0);
