import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";

const HOST = process.env.PROBE_HOST ?? "155.103.66.113";
const PORT = Number(process.env.PROBE_PORT ?? 35683);
const USER = process.env.PROBE_USER ?? "root";
const KEY = readFileSync(join(homedir(), ".ssh", "wshome"));
const BIG = process.env.PROBE_FILE ?? "/root/.pi/agent/sessions/--root--";

function connect(extra: Record<string, unknown>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host: HOST, port: PORT, username: USER, privateKey: KEY, readyTimeout: 30000, ...extra } as never);
  });
}

function execOnce(c: Client, cmd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      stream.resume();
      stream.on("close", () => resolve(Date.now() - t0));
      stream.stderr.resume();
    });
  });
}

// The two shapes the gateway actually issues: a tiny command (the common case)
// and a whole-transcript read (the expensive case).
const SMALL = `printf %s "$HOME"`;
const LARGE = process.env.PROBE_BIG === "1"
  ? `tar -cf - -C ${BIG} . | wc -c`
  : `for f in ${BIG}/*.jsonl; do cat "$f"; done`;

async function bench(label: string, extra: Record<string, unknown>) {
  const c = await connect(extra);
  await execOnce(c, SMALL); // warm
  const small: number[] = [];
  for (let i = 0; i < 6; i++) small.push(await execOnce(c, SMALL));
  const large: number[] = [];
  for (let i = 0; i < 4; i++) large.push(await execOnce(c, LARGE));
  console.log(`${label}  small ${small.join("/")} ms   large ${large.join("/")} ms`);
  c.end();
}

const which = process.argv[2] ?? "both";
if (which === "both" || which === "plain") await bench("plain   ", {});
if (which === "both" || which === "compress") await bench("compress", { compress: true });
