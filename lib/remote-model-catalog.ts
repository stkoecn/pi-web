import "server-only";
import { getGateway } from "@/lib/gateway/singleton";

/**
 * The catalogue refresh a device runs on itself.
 *
 * The local pass (`lib/model-catalog-refresh.ts`) creates a runtime here and
 * calls `refresh()` against pi.dev, persisting the overlay to this machine's
 * `models-store.json`. A device's picker reads the device's own store, so the
 * refresh has to run there: the probe locates the device's pi build (the same
 * finder the model test uses), creates a runtime over the device's default
 * agent dir, and refreshes with the network enabled. pi writes its
 * `models-store.json`; the next device catalogue read picks it up.
 */

const REFRESH_TIMEOUT_MS = 60_000;

interface ModelsRefreshResultShape {
  completed: boolean;
  changed: boolean;
  reason?: string;
}

function findPiPackageDirSnippet(): string {
  return `
function findPiPackageDir() {
  const path = require('path');
  const fs = require('fs');
  const candidates = [];
  try { candidates.push(path.dirname(require.resolve('@earendil-works/pi-coding-agent/package.json'))); } catch {}
  try {
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
      const bin = path.join(dir, 'pi');
      if (!fs.existsSync(bin)) continue;
      try {
        const real = fs.realpathSync(bin);
        candidates.push(path.resolve(path.dirname(real), '..', '..'));
        candidates.push(path.resolve(path.dirname(real), '..', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'));
      } catch {}
    }
  } catch {}
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch {}
  }
  return null;
}
`;
}

const CATALOG_REFRESH_SCRIPT = `
const path = require('path');
${findPiPackageDirSnippet()}
function out(result) {
  try { process.stdout.write('__PIWEB_RESULT__' + JSON.stringify(result)); } catch {}
  process.exit(0);
}
(async () => {
  try {
    const providers = JSON.parse(Buffer.from(process.env.PIWEB_REFRESH || '', 'base64').toString('utf8'));
    const pkgDir = findPiPackageDir();
    if (!pkgDir) return out({ completed: false, changed: false, reason: "pi's package directory was not found on the device" });
    const sdk = require(path.join(pkgDir, 'dist', 'index.js'));
    const ModelRuntime = sdk && (sdk.ModelRuntime || (sdk.default && sdk.default.ModelRuntime));
    if (!ModelRuntime || typeof ModelRuntime.create !== 'function') {
      return out({ completed: false, changed: false, reason: "the device's pi build does not export a usable ModelRuntime" });
    }
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const before = JSON.stringify((runtime.getModels ? runtime.getModels() : []).map((m) => [m.provider, m.id]));
    const result = await runtime.refresh({
      ...(providers && providers.length ? { providers } : {}),
      force: true,
      allowNetwork: true,
    });
    const after = JSON.stringify((runtime.getModels ? runtime.getModels() : []).map((m) => [m.provider, m.id]));
    out({
      completed: true,
      changed: before !== after || Boolean(result && result.changed),
      reason: result && result.reason ? String(result.reason) : undefined,
    });
  } catch (error) {
    out({ completed: false, changed: false, reason: (error && error.message) || String(error) });
  }
})();
`;

/** Refresh the device's catalogue on the device; never rejects. */
export async function refreshRemoteCatalog(
  deviceId: string,
  provider?: string,
): Promise<ModelsRefreshResultShape> {
  try {
    const gateway = getGateway();
    const driver = await gateway.getDriverForRequest(deviceId);
    const { REMOTE_PATH_PREFIX } = await import("@/lib/gateway/drivers/persistent-shell");
    const scriptB64 = Buffer.from(CATALOG_REFRESH_SCRIPT, "utf8").toString("base64");
    const providersB64 = Buffer.from(JSON.stringify(provider ? [provider] : []), "utf8").toString("base64");
    const cmd = `${REMOTE_PATH_PREFIX} PIWEB_REFRESH=${providersB64} node -e "eval(Buffer.from('${scriptB64}','base64').toString('utf8'))"`;
    const result = await driver.exec(cmd, [], { timeoutMs: REFRESH_TIMEOUT_MS });
    const marker = result.stdout.indexOf("__PIWEB_RESULT__");
    if (marker < 0) {
      const detail = (result.stderr || result.stdout || "no output").trim().slice(0, 200);
      return { completed: false, changed: false, reason: `the device's refresh produced no result: ${detail}` };
    }
    return JSON.parse(result.stdout.slice(marker + "__PIWEB_RESULT__".length)) as ModelsRefreshResultShape;
  } catch (error) {
    return {
      completed: false,
      changed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
