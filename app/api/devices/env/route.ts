import { getGateway } from "@/lib/gateway/singleton";

export const dynamic = "force-dynamic";

/**
 * Where a user-level install can hide, ahead of the default PATH.
 *
 * `$HOME`, not `~`: a tilde expands only when it is unquoted, so the previous
 * `PATH="$PATH:~/..."` added a literal `~/...` entry and never found anything.
 * The node directory comes first because that is where the installer below puts
 * it — no root, no apt.
 */
const PATH_PROBE = `export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH:/usr/local/bin:/usr/bin:/usr/local/node/bin"
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1)"
  [ -n "$LATEST_NVM" ] && export PATH="$HOME/.nvm/versions/node/$LATEST_NVM/bin:$PATH"
fi
`;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return Response.json({ error: "Missing device id" }, { status: 400 });
    }

    const gateway = getGateway();
    const driver = gateway.getOnlineDriver(id);
    if (!driver || !driver.isAlive()) {
      return Response.json({
        online: false,
        hasPi: false,
        error: "Device is offline or unreachable",
      });
    }

    const probeCmd = `${PATH_PROBE}
PI_PATH="$(command -v pi 2>/dev/null || which pi 2>/dev/null || true)"
PI_VER="$([ -n "$PI_PATH" ] && pi --version 2>/dev/null || true)"
NODE_PATH="$(command -v node 2>/dev/null || which node 2>/dev/null || true)"
NODE_VER="$([ -n "$NODE_PATH" ] && node -v 2>/dev/null || true)"
NPM_PATH="$(command -v npm 2>/dev/null || which npm 2>/dev/null || true)"
NPM_VER="$([ -n "$NPM_PATH" ] && npm -v 2>/dev/null || true)"
UNAME="$(uname -s -m 2>/dev/null || true)"
printf "PI_PATH=%s\nPI_VER=%s\nNODE_PATH=%s\nNODE_VER=%s\nNPM_PATH=%s\nNPM_VER=%s\nUNAME=%s\n" \
  "$PI_PATH" "$PI_VER" "$NODE_PATH" "$NODE_VER" "$NPM_PATH" "$NPM_VER" "$UNAME"
`;

    const result = await driver.exec(probeCmd);
    const lines = (result.stdout || "").split("\n");
    const map: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    const piPath = map["PI_PATH"] || "";
    const piVer = map["PI_VER"] || "";
    const nodePath = map["NODE_PATH"] || "";
    const nodeVer = map["NODE_VER"] || "";
    const npmPath = map["NPM_PATH"] || "";
    const npmVer = map["NPM_VER"] || "";
    const uname = map["UNAME"] || "";

    return Response.json({
      online: true,
      hasPi: Boolean(piPath),
      piPath: piPath || undefined,
      piVersion: piVer || undefined,
      hasNode: Boolean(nodePath),
      nodeVersion: nodeVer || undefined,
      hasNpm: Boolean(npmPath),
      npmVersion: npmVer || undefined,
      system: uname || undefined,
    });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Failed to inspect device environment" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { id, action } = body as { id?: string; action?: "install_pi" };

    if (!id || typeof id !== "string") {
      return Response.json({ error: "Missing device id" }, { status: 400 });
    }

    if (action !== "install_pi") {
      return Response.json({ error: "Unsupported action" }, { status: 400 });
    }

    const gateway = getGateway();
    const driver = gateway.getOnlineDriver(id);
    if (!driver || !driver.isAlive()) {
      return Response.json(
        { error: "Device is offline or unreachable" },
        { status: 400 },
      );
    }

    // Remote host only needs the pi CLI agent (e.g. @earendil-works/pi-coding-agent)
    // Supports bun (lightweight & OOM-safe on low-memory VPS) or npm
    const installCmd = `${PATH_PROBE}
echo "==> Preparing a Node.js runtime (no root needed)"
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "==> Using the Node.js already on PATH ($(node -v))"
elif command -v bun >/dev/null 2>&1; then
  echo "==> Using Bun"
  bun add -g @earendil-works/pi-coding-agent || exit 1
  pi --version || exit 1
  exit 0
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   NODE_ARCH=x64 ;;
    Linux-aarch64)  NODE_ARCH=arm64 ;;
    Darwin-x86_64)  NODE_ARCH=x64 ;;
    Darwin-arm64)   NODE_ARCH=arm64 ;;
    *) echo "Cannot pick a Node.js build for $(uname -s) $(uname -m)"; exit 1 ;;
  esac
  # The newest 22.x LTS: pi needs >= 22.19, and 24+ links libatomic, which a
  # minimal Debian/Ubuntu image does not ship. 22.x is built without it.
  NODE_VER="$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v22[0-9.]*"' | head -n 1 | cut -d '"' -f4)"
  [ -n "$NODE_VER" ] || NODE_VER=v22.19.0
  echo "==> Downloading Node.js $NODE_VER for linux-$NODE_ARCH"
  rm -rf "$HOME/.local/node" "$HOME/.local/node.tmp" || exit 1
  mkdir -p "$HOME/.local/node.tmp" || exit 1
  NODE_TARBALL="/tmp/piweb-node-$NODE_VER.tar.xz"
  curl -fsSL -o "$NODE_TARBALL" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$NODE_ARCH.tar.xz" || {
    echo "Cannot download Node.js $NODE_VER"; rm -f "$NODE_TARBALL"; exit 1; }
  tar -xJf "$NODE_TARBALL" -C "$HOME/.local/node.tmp" --strip-components=1 || {
    echo "Cannot extract Node.js $NODE_VER"; rm -rf "$HOME/.local/node.tmp"; exit 1; }
  rm -f "$NODE_TARBALL"
  mv "$HOME/.local/node.tmp" "$HOME/.local/node" || exit 1
  export PATH="$HOME/.local/node/bin:$PATH"
  if ! node -v; then
    echo "Node.js $NODE_VER cannot run on this system:"
    ldd "$HOME/.local/node/bin/node" 2>&1 | grep "not found" || true
    echo "Install the missing libraries (e.g. apt-get install -y libatomic1) or use a distro Node.js."
    exit 1
  fi
  echo "==> Node.js $(node -v), npm $(npm -v)"
fi

echo "==> Installing the pi CLI (@earendil-works/pi-coding-agent)"
NODE_OPTIONS="--max-old-space-size=512" npm install -g @earendil-works/pi-coding-agent || exit 1
PI_PATH="$(command -v pi || true)"
echo "==> pi is at \${PI_PATH:-nowhere}"
[ -n "$PI_PATH" ] || exit 1
pi --version || exit 1
`;

    const execResult = await driver.exec(installCmd);
    const success = execResult.exitCode === 0;

    return Response.json({
      success,
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
    });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Failed to install pi environment" },
      { status: 500 },
    );
  }
}
