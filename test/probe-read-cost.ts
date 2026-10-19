import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { SSHHostDriver } from "../lib/gateway/drivers/ssh-host-driver";

const device = process.argv[2] ?? "fuckip-us";
const devices = JSON.parse(readFileSync(join(process.cwd(), "devices.json"), "utf8"));
const cfg = (devices.devices ?? devices).find((d: { id: string }) => d.id === device);

const client = await new Promise<ssh2.Client>((resolve, reject) => {
  const c = new ssh2.Client();
  c.on("ready", () => resolve(c));
  c.on("error", reject);
  c.connect({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    privateKey: readFileSync(cfg.privateKeyPath.replace(/^~[\/]/, homedir() + "/")),
  });
});
const driver = new SSHHostDriver(device, client);

const dir = (await driver.exec(`printf %s "$HOME"`)).stdout.trim() + "/.pi/agent/sessions";
const list = await driver.exec(`ls -S ${dir}/*/*.jsonl 2>/dev/null | head -n 3`);
const files = list.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
console.log("files:", files.map((f) => f.split("/").pop()));

for (const f of files.slice(0, 2)) {
  const size = Number((await driver.exec(`wc -c < '${f}'`)).stdout.trim());
  const b64: number[] = [];
  const raw: number[] = [];
  for (let i = 0; i < 3; i++) {
    let t = Date.now();
    await driver.exec(`base64 '${f}'`);
    b64.push(Date.now() - t);
    t = Date.now();
    await driver.exec(`cat '${f}'`);
    raw.push(Date.now() - t);
  }
  console.log(`${(size / 1024).toFixed(1)} KiB  base64 ${b64.join("/")} ms   cat ${raw.join("/")} ms`);
}
driver.close();
