import { getGateway } from "@/lib/gateway/singleton";
import { getOrCreateGatewayKeypair } from "@/lib/gateway/pairing-keys";
import { createPairingToken, validatePairingToken } from "@/lib/gateway/pairing-tokens";
import {
  addDeviceToConfigs,
  readDevicesFile,
  updateDeviceInConfigs,
  writeDevicesFile,
} from "@/lib/gateway/device-config-file";

/**
 * Parses raw host string (e.g. `domain.com:8443` or `[::1]:9564` or `192.168.1.8`)
 * into hostname and optional port.
 */
export function parseHostAndPort(rawHost: string): { hostname: string; port?: string } {
  const host = rawHost.trim();
  if (host.startsWith("[")) {
    const closeBracket = host.indexOf("]");
    if (closeBracket !== -1) {
      const hostname = host.slice(1, closeBracket);
      const after = host.slice(closeBracket + 1);
      const port = after.startsWith(":") ? after.slice(1) : undefined;
      return { hostname, port };
    }
  }
  const parts = host.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { hostname: parts[0], port: parts[1] };
  }
  return { hostname: host };
}

/**
 * Resolves gateway URLs respecting reverse proxy headers (X-Forwarded-Host,
 * X-Forwarded-Proto, Forwarded) or the direct request URL.
 */
export function resolveGatewayUrls(req: Request): {
  origin: string;
  sshHost: string;
  sshPort: number;
} {
  const url = new URL(req.url);

  // 1. Resolve Protocol
  let protocol = "http";
  const xfp = req.headers.get("x-forwarded-proto");
  if (xfp) {
    protocol = xfp.split(",")[0].trim();
  } else if (url.protocol) {
    protocol = url.protocol.replace(":", "");
  }

  // 2. Resolve Host
  let host = "";
  const xfh = req.headers.get("x-forwarded-host");
  if (xfh) {
    host = xfh.split(",")[0].trim();
  } else {
    const forwarded = req.headers.get("forwarded");
    if (forwarded) {
      const hostMatch = forwarded.match(/host="?([^;,\s"]+)"?/i);
      if (hostMatch) host = hostMatch[1].trim();
    }
  }
  if (!host) {
    host = req.headers.get("host")?.trim() || url.host || "127.0.0.1:9564";
  }

  const origin = `${protocol}://${host}`;
  const { hostname } = parseHostAndPort(host);

  // 3. Resolve SSH Gateway Host and Port
  const sshHost = process.env.PI_GATEWAY_SSH_HOST?.trim() || hostname || "127.0.0.1";
  const sshPort = Number(process.env.PI_GATEWAY_SSH_PORT || 22222);

  return { origin, sshHost, sshPort };
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/devices/join
 *
 * Serves the one-click pairing bash script when requested with `?token=...`
 * (or generates a new token and returns JSON when `Accept: application/json` is requested).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const isJson = req.headers.get("accept")?.includes("application/json");
  const { origin: gatewayOrigin, sshHost: gatewayHost, sshPort: gatewaySshPort } = resolveGatewayUrls(req);

  // If no token or requesting json without token, generate a new pairing token
  if (!token) {
    const suggestedId = url.searchParams.get("id") || undefined;
    const suggestedName = url.searchParams.get("name") || undefined;
    const tokenInfo = createPairingToken({ suggestedId, suggestedName });

    const joinUrl = `${gatewayOrigin}/api/devices/join?token=${tokenInfo.token}`;
    const command = `curl -sSL "${joinUrl}" | bash`;

    return Response.json({
      ...tokenInfo,
      joinUrl,
      command,
    });
  }

  // Validate existing token
  const tokenInfo = validatePairingToken(token, false);
  if (!tokenInfo) {
    if (isJson) {
      return Response.json({ error: "Invalid or expired pairing token" }, { status: 400 });
    }
    const errScript = `#!/usr/bin/env bash
echo "❌ Error: Invalid or expired pairing token."
echo "Please generate a new join command from the Pi-Web device settings."
exit 1
`;
    return new Response(errScript, {
      status: 400,
      headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
    });
  }

  const keypair = getOrCreateGatewayKeypair();
  const pubkey = keypair.publicKey.trim();

  const suggestedId = tokenInfo.suggestedId || "";
  const suggestedName = tokenInfo.suggestedName || "";

  // Return the auto-join bash script
  const script = `#!/usr/bin/env bash
set -e

# ==========================================================
# Pi-Web One-Click Device Pairing Script
# ==========================================================

GATEWAY_ORIGIN="${gatewayOrigin}"
GATEWAY_HOST="${gatewayHost}"
GATEWAY_SSH_PORT="${gatewaySshPort}"
PAIRING_TOKEN="${token}"
GATEWAY_PUBKEY="${pubkey}"
SUGGESTED_ID="${suggestedId}"
SUGGESTED_NAME="${suggestedName}"

echo ""
echo "=================================================="
echo "🚀 [Pi-Web] Starting one-click device pairing..."
echo "=================================================="

# 1. Detect user
CURRENT_USER="$(id -un 2>/dev/null || whoami)"
if [ -z "$CURRENT_USER" ]; then
  echo "❌ Error: Failed to detect current username."
  exit 1
fi

# 2. Determine Device ID
if [ -n "$SUGGESTED_ID" ]; then
  DEVICE_ID="$SUGGESTED_ID"
else
  RAW_HOST="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "remote-node")"
  DEVICE_ID="$(echo "$RAW_HOST" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  if [ -z "$DEVICE_ID" ]; then
    DEVICE_ID="node-$(date +%s)"
  fi
fi

DEVICE_NAME="$SUGGESTED_NAME"
if [ -z "$DEVICE_NAME" ]; then
  DEVICE_NAME="$DEVICE_ID"
fi

echo "ℹ️  Device ID: $DEVICE_ID ($DEVICE_NAME)"
echo "ℹ️  User:      $CURRENT_USER"

# 3. Detect local SSH port
LOCAL_SSH_PORT=22
if command -v sshd >/dev/null 2>&1; then
  DETECTED_PORT="$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}' || true)"
  if [ -n "$DETECTED_PORT" ]; then
    LOCAL_SSH_PORT="$DETECTED_PORT"
  fi
elif [ -f /etc/ssh/sshd_config ]; then
  DETECTED_PORT="$(awk '/^[ \\t]*Port / {print $2; exit}' /etc/ssh/sshd_config || true)"
  if [ -n "$DETECTED_PORT" ]; then
    LOCAL_SSH_PORT="$DETECTED_PORT"
  fi
fi

echo "ℹ️  Local SSH Port: $LOCAL_SSH_PORT"

# 4. Install Gateway Public Key into authorized_keys
SSH_DIR="$HOME/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

if [ -f "$AUTH_KEYS" ]; then
  if grep -F "$GATEWAY_PUBKEY" "$AUTH_KEYS" >/dev/null 2>&1; then
    echo "✓ Gateway public key already authorized."
  else
    echo "$GATEWAY_PUBKEY" >> "$AUTH_KEYS"
    echo "✓ Added Gateway public key to $AUTH_KEYS."
  fi
else
  echo "$GATEWAY_PUBKEY" > "$AUTH_KEYS"
  echo "✓ Created $AUTH_KEYS with Gateway public key."
fi

chmod 600 "$AUTH_KEYS"

# 5. Register device with Gateway
echo "📡 Registering device with Pi-Web Gateway..."

REGISTER_PAYLOAD=$(cat <<EOF
{
  "token": "$PAIRING_TOKEN",
  "id": "$DEVICE_ID",
  "name": "$DEVICE_NAME",
  "username": "$CURRENT_USER",
  "port": $LOCAL_SSH_PORT
}
EOF
)

RESP=$(curl -s -X POST "$GATEWAY_ORIGIN/api/devices/join" \\
  -H "Content-Type: application/json" \\
  -d "$REGISTER_PAYLOAD")

SUCCESS=$(echo "$RESP" | grep -o '"success":true' || true)
if [ -z "$SUCCESS" ]; then
  echo "❌ Gateway registration failed:"
  echo "$RESP"
  exit 1
fi

echo "✓ Registered successfully with Gateway."

# 6. Terminate any previous reverse tunnel for this device
pkill -f "ssh.*$DEVICE_ID@$GATEWAY_HOST.*$GATEWAY_SSH_PORT" >/dev/null 2>&1 || true

# 7. Start reverse SSH tunnel in background
echo "🔌 Connecting reverse tunnel to $GATEWAY_HOST:$GATEWAY_SSH_PORT..."

ssh -N -R 0:127.0.0.1:$LOCAL_SSH_PORT "$DEVICE_ID@$GATEWAY_HOST" -p $GATEWAY_SSH_PORT \\
  -o StrictHostKeyChecking=no \\
  -o UserKnownHostsFile=/dev/null \\
  -o ServerAliveInterval=30 \\
  -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes \\
  -f

sleep 1

echo ""
echo "=================================================="
echo "🎉 [Pi-Web] Device '$DEVICE_ID' successfully joined and connected!"
echo "   Gateway URL: $GATEWAY_ORIGIN"
echo "   Status:      ONLINE"
echo "=================================================="
echo ""
`;

  return new Response(script, {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * POST /api/devices/join
 *
 * Called by the joining bash script on the remote device to register itself.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as {
      token?: string;
      id?: string;
      name?: string;
      username?: string;
      port?: number;
    } | null;

    if (!body || !body.token || !body.id || !body.username) {
      return Response.json(
        { error: "Missing required fields: token, id, username" },
        { status: 400 },
      );
    }

    // Validate and consume the token
    const tokenInfo = validatePairingToken(body.token, true);
    if (!tokenInfo) {
      return Response.json(
        { error: "Invalid or expired pairing token" },
        { status: 400 },
      );
    }

    const gateway = getGateway();
    const keypair = getOrCreateGatewayKeypair();
    const file = readDevicesFile(gateway.configPath());
    if (file.error) {
      return Response.json({ error: file.error }, { status: 409 });
    }

    const deviceId = body.id.trim();
    const deviceName = (body.name || deviceId).trim();
    const username = body.username.trim();

    // Check if device already exists in configs
    const existingIndex = file.configs.findIndex((c) => c.id === deviceId);

    const deviceConfig = {
      id: deviceId,
      name: deviceName,
      mode: "reverse_tunnel" as const,
      username,
      privateKeyPath: keypair.privateKeyPath,
    };

    let updatedConfigs = [...file.configs];
    if (existingIndex >= 0) {
      const updated = updateDeviceInConfigs(file.configs, deviceConfig);
      if ("reason" in updated) {
        return Response.json({ error: updated.reason }, { status: 400 });
      }
      updatedConfigs = updated.configs;
    } else {
      const added = addDeviceToConfigs(file.configs, deviceConfig);
      if ("reason" in added) {
        return Response.json({ error: added.reason }, { status: 400 });
      }
      updatedConfigs = added.configs;
    }

    writeDevicesFile(updatedConfigs, file.path);
    await gateway.syncDevices(updatedConfigs);

    return Response.json({
      success: true,
      deviceId,
      mode: "reverse_tunnel",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
