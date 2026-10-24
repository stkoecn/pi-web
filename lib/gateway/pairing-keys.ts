import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

/**
 * Gateway pairing key manager.
 *
 * Maintains a dedicated ed25519 keypair for the gateway (`~/.pi/gateway_ed25519`).
 * Remote devices that join the gateway via one-click curl scripts will add this
 * public key to their `~/.ssh/authorized_keys`, allowing the gateway to log in
 * securely without requiring manual key generation or password entry by the user.
 */

const KEY_DIR = path.join(os.homedir(), ".pi");
const PRIV_KEY_PATH = path.join(KEY_DIR, "gateway_ed25519");
const PUB_KEY_PATH = path.join(KEY_DIR, "gateway_ed25519.pub");
const LOGICAL_KEY_PATH = "~/.pi/gateway_ed25519";

export interface GatewayKeypair {
  privateKeyPath: string;
  publicKey: string;
}

/**
 * Converts a raw SPKI ed25519 public key into standard OpenSSH public key wire format:
 * `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... pi-web-gateway`
 */
function rawPubToOpenSsh(spkiDer: Buffer): string {
  const rawPub = spkiDer.subarray(spkiDer.length - 32);
  const typeBuf = Buffer.from("ssh-ed25519");

  const len1 = Buffer.alloc(4);
  len1.writeUInt32BE(typeBuf.length);

  const len2 = Buffer.alloc(4);
  len2.writeUInt32BE(rawPub.length);

  const wire = Buffer.concat([len1, typeBuf, len2, rawPub]);
  return `ssh-ed25519 ${wire.toString("base64")} pi-web-gateway`;
}

/**
 * Ensures the gateway keypair exists, generating it if missing.
 */
export function getOrCreateGatewayKeypair(): GatewayKeypair {
  if (!fs.existsSync(KEY_DIR)) {
    fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(PRIV_KEY_PATH) && fs.existsSync(PUB_KEY_PATH)) {
    try {
      const pubText = fs.readFileSync(PUB_KEY_PATH, "utf8").trim();
      if (pubText.startsWith("ssh-ed25519 ")) {
        return {
          privateKeyPath: LOGICAL_KEY_PATH,
          publicKey: pubText,
        };
      }
    } catch {}
  }

  // Generate new standard OpenSSH ed25519 keypair using ssh-keygen if available
  let generated = false;
  try {
    execSync(`ssh-keygen -t ed25519 -N "" -f "${PRIV_KEY_PATH}" -C "pi-web-gateway"`, {
      stdio: "ignore",
    });
    if (fs.existsSync(PUB_KEY_PATH)) {
      generated = true;
    }
  } catch {}

  // Fallback to pure node:crypto if ssh-keygen is unavailable
  if (!generated) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const pubDer = publicKey.export({ type: "spki", format: "der" });
    const openSshPub = rawPubToOpenSsh(pubDer);

    fs.writeFileSync(PRIV_KEY_PATH, privPem, { mode: 0o600 });
    fs.writeFileSync(PUB_KEY_PATH, openSshPub + "\n", { mode: 0o644 });
  }

  const pubContent = fs.readFileSync(PUB_KEY_PATH, "utf8").trim();
  return {
    privateKeyPath: LOGICAL_KEY_PATH,
    publicKey: pubContent,
  };
}
