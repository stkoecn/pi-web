import http from "node:http";
import type { Client } from "ssh2";
import { sendMeshMessage } from "./mesh-router";
import { getCanonicalHostId } from "./host-identity";

/** Default port on the remote device for the reverse bridge */
export const DEFAULT_MESH_BRIDGE_PORT = 29564;

/**
 * Attaches a reverse bridge port forward on an active SSH client connection.
 *
 * When enabled, the SSH client asks the remote sshd:
 * `client.forwardIn("127.0.0.1", port)`
 *
 * Whenever any process on the remote machine (even a standalone terminal `pi` CLI)
 * connects to `http://127.0.0.1:29564/send` (or any path), SSH forwards the connection
 * through the encrypted tunnel back to this gateway process.
 *
 * This provides a 100% reliable return path over the existing SSH tunnel,
 * completely immune to NAT, firewalls, or lack of direct HTTP routes!
 */
export function setupMeshReverseBridge(
  deviceId: string,
  client: Client,
  requestedPort = DEFAULT_MESH_BRIDGE_PORT,
): Promise<number> {
  return new Promise((resolve) => {
    let activeBridgePort = requestedPort;
    const MAX_HEADER_SIZE = 64 * 1024;

    // Listen for incoming connection forwards from remote sshd
    client.on("tcp connection", (info, accept, reject) => {
      // Check if this connection matches our forwarded bridge port
      if (info.destPort !== activeBridgePort && info.destPort !== 0) {
        // Explicitly reject mismatched ports so remote sshd does not hang
        reject();
        return;
      }

      const stream = accept();

      const streamTimeout = setTimeout(() => {
        try { stream.destroy(); } catch {}
      }, 15000);
      streamTimeout.unref?.();

      stream.on("error", () => {
        clearTimeout(streamTimeout);
        try { stream.destroy(); } catch {}
      });
      stream.on("close", () => {
        clearTimeout(streamTimeout);
      });

      let reqBuffer = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        reqBuffer = Buffer.concat([reqBuffer, chunk]);

        // Guard against memory exhaustion from malformed headers
        if (reqBuffer.length > MAX_HEADER_SIZE && reqBuffer.indexOf("\r\n\r\n") === -1) {
          try { stream.destroy(); } catch {}
          return;
        }

        // Look for end of HTTP headers
        const headerEnd = reqBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headerStr = reqBuffer.subarray(0, headerEnd).toString("utf8");
        const lines = headerStr.split("\r\n");
        const requestLine = lines[0] || "";
        const [method] = requestLine.split(" ");

        // Parse Content-Length
        let contentLength = 0;
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(":");
          if (colon !== -1) {
            const key = line.slice(0, colon).trim().toLowerCase();
            const val = line.slice(colon + 1).trim();
            if (key === "content-length") contentLength = parseInt(val, 10) || 0;
          }
        }

        const bodyStart = headerEnd + 4;
        if (reqBuffer.length >= bodyStart + contentLength) {
          const bodyBytes = reqBuffer.subarray(bodyStart, bodyStart + contentLength);
          const bodyStr = bodyBytes.toString("utf8");

          // Handle POST request
          (async () => {
            try {
              if (method !== "POST") {
                const resp = "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                stream.end(resp);
                return;
              }

              const payload = JSON.parse(bodyStr) as {
                target: string;
                message: string;
                mode?: "followup" | "steer" | "silent";
                sessionId?: string;
                senderContext?: {
                  deviceId?: string;
                  sessionId?: string;
                  cwd?: string;
                };
              };

              console.log(`[MeshReverseBridge:${deviceId}] Received bridge message:`, payload.target);

              const senderSessionId = payload.senderContext?.sessionId || payload.sessionId;
              const result = await sendMeshMessage({
                target: payload.target,
                message: payload.message,
                mode: payload.mode || "followup",
                currentDeviceId: deviceId,
                senderContext: {
                  deviceId: payload.senderContext?.deviceId || deviceId,
                  sessionId: senderSessionId,
                  cwd: payload.senderContext?.cwd,
                },
              });

              const respBody = JSON.stringify(result);
              const resp = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(respBody)}\r\nConnection: close\r\n\r\n${respBody}`;
              stream.end(resp);
            } catch (err) {
              console.error(`[MeshReverseBridge:${deviceId}] Error handling bridge message:`, err);
              const errBody = JSON.stringify({ error: String(err) });
              const resp = `HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(errBody)}\r\nConnection: close\r\n\r\n${errBody}`;
              stream.end(resp);
            }
          })();
        }
      });
    });

    client.forwardIn("127.0.0.1", requestedPort, (err, port) => {
      if (err) {
        console.warn(`[MeshReverseBridge:${deviceId}] Warning: forwardIn 127.0.0.1:${requestedPort} failed: ${err.message}. Retrying with dynamic port 0...`);
        client.forwardIn("127.0.0.1", 0, (err2, port2) => {
          if (err2) {
            console.error(`[MeshReverseBridge:${deviceId}] Failed to forward any bridge port: ${err2.message}`);
            resolve(0);
          } else {
            activeBridgePort = port2;
            console.log(`[MeshReverseBridge:${deviceId}] Bridge active on remote 127.0.0.1:${port2} via SSH reverse tunnel`);
            resolve(port2);
          }
        });
      } else {
        const bound = port || requestedPort;
        activeBridgePort = bound;
        console.log(`[MeshReverseBridge:${deviceId}] Bridge active on remote 127.0.0.1:${bound} via SSH reverse tunnel`);
        resolve(bound);
      }
    });
  });
}
