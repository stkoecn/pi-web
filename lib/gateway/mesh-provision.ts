import path from "node:path";
import fs from "node:fs";
import type { SFTPWrapper } from "ssh2";
import type { SSHHostDriver } from "./drivers/ssh-host-driver";
import { sendMeshMessage } from "./mesh-router";
import { getCanonicalHostId } from "./host-identity";

const EXTENSION_LOCAL_PATH = path.join(process.cwd(), "lib", "gateway", "mesh-agent-extension.mjs");
const EXTENSION_REMOTE_NAME = "mesh-agent-extension.mjs";

/**
 * Ensure the remote machine has the latest mesh-agent-extension.mjs in ~/.pi/agent/
 * Returns the remote path to the extension.
 */
export async function ensureRemoteMeshExtension(driver: SSHHostDriver): Promise<string> {
  const remoteExtensionDir = "~/.pi/agent";
  const remoteExtensionPath = `${remoteExtensionDir}/${EXTENSION_REMOTE_NAME}`;

  try {
    const localContent = fs.readFileSync(EXTENSION_LOCAL_PATH, "utf8");
    // Ensure parent dir exists
    await driver.exec(`mkdir -p "${remoteExtensionDir}" 2>/dev/null || true`).catch(() => {});
    // Write via SFTP
    await driver.writeFile(remoteExtensionPath, localContent);
  } catch (err) {
    console.warn(`[MeshProvision] Failed to upload mesh extension to ${driver.deviceId}:`, err);
  }

  return remoteExtensionPath;
}

/**
 * Scan and drain any messages left in ~/.pi/agent/mesh/outbox/ on the remote device.
 */
export async function drainRemoteMeshOutbox(driver: SSHHostDriver): Promise<number> {
  if (!driver.isAlive()) return 0;

  const outboxDir = "~/.pi/agent/mesh/outbox";

  try {
    const listRes = await driver.exec(`ls -1 "${outboxDir}" 2>/dev/null || true`);
    const files = (listRes.stdout || "")
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".json"));

    if (files.length === 0) return 0;

    let drained = 0;
    for (const file of files) {
      const filePath = `${outboxDir}/${file}`;
      try {
        const contentBuf = await driver.readFile(filePath);
        const item = JSON.parse(contentBuf.toString("utf8"));

        if (item && item.target && item.message) {
          console.log(`[MeshOutbox] Draining queued message from ${driver.deviceId} to ${item.target}`);
          await sendMeshMessage({
            target: item.target,
            message: item.message,
            mode: item.mode || "followup",
            currentDeviceId: driver.deviceId,
            senderContext: {
              deviceId: driver.deviceId,
              sessionId: item.sender?.sessionId,
              cwd: item.sender?.cwd,
            },
          });
          drained++;
        }

        // Delete delivered message from outbox
        await driver.exec(`rm -f "${filePath}" 2>/dev/null || true`).catch(() => {});
      } catch (e) {
        console.error(`[MeshOutbox] Failed to drain message file ${filePath}:`, e);
      }
    }

    return drained;
  } catch {
    return 0;
  }
}
