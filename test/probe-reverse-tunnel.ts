/**
 * What a reverse tunnel actually needs, isolated from the app.
 *
 * Run on the gateway host, then from the device:
 *   ssh -N -R 0:localhost:22 tunnel@<gateway> -p 22999
 * The intent is to prove (a) which bound port must be sent back in the
 * forwarded-tcpip channel open, and (b) which bind address the OpenSSH client
 * accepts, because "Connection lost before handshake" is what a mismatch looks
 * like from the gateway side.
 */
import ssh2 from "ssh2";
import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] ?? 22999);
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  console.log("connection from peer");
  let id = "";
  client.on("authentication", (ctx: any) => {
    id = ctx.username ?? "";
    console.log("auth", ctx.method, "user", JSON.stringify(id));
    ctx.accept();
  });
  client.on("request", (accept: any, reject: any, name: string, info: any) => {
    console.log("request", name, JSON.stringify(info));
    if (name !== "tcpip-forward") return reject?.();
    let allocated = 0;
    const bound = net.createServer((sock) => {
      sock.on("error", (e: any) => console.log("gateway socket error", e.message));
      // The one variable under test: 0 means "let the client decide how to
      // match this against its own forward table".
      const destPort = process.env.ECHO_ZERO ? 0 : allocated;
      console.log("incoming tcp, opening forwarded-tcpip dst", JSON.stringify(info.bindAddr), destPort);
      client.forwardOut(info.bindAddr, destPort, sock.remoteAddress ?? "", sock.remotePort ?? 0, (err: any, ch: any) => {
        if (err) {
          console.log("forwardOut failed:", err.message);
          sock.destroy();
          return;
        }
        console.log("forwardOut ok");
        ch.on("error", (e: any) => console.log("channel error", e.message));
        sock.pipe(ch).pipe(sock);
      });
    });
    bound.listen(0, "127.0.0.1", () => {
      allocated = (bound.address() as net.AddressInfo).port;
      console.log("allocated local port", allocated, "answer to client", allocated);
      accept(allocated);
    });
  });
  client.on("close", () => console.log("connection closed"));
  client.on("error", (e: any) => console.log("connection error", e.message));
});

server.listen(PORT, "0.0.0.0", () => console.log("probe server on", PORT));
