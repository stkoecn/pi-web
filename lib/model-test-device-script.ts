/**
 * The model probe a REMOTE device runs on itself, over its SSH channel: locate
 * the device's own pi build, write a temp models.json holding just the provider
 * under test, and answer one tiny chat request through that build's
 * ModelRuntime — the same probe the local runtime runs in-process
 * (lib/model-test.ts). One `__PIWEB_RESULT__` JSON line goes to stdout.
 *
 * The script is plain JS (the device's node runs it), delivered base64-encoded
 * with the probe config in the PIWEB_PROBE env var.
 */
export const MODEL_TEST_DEVICE_SCRIPT = `
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
function out(result) {
  try { process.stdout.write('__PIWEB_RESULT__' + JSON.stringify(result)); } catch {}
  process.exit(0);
}
function findPiPackageDir() {
  const candidates = [];
  try { candidates.push(path.dirname(require.resolve('@earendil-works/pi-coding-agent/package.json'))); } catch {}
  try {
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
      const bin = path.join(dir, 'pi');
      if (!fs.existsSync(bin)) continue;
      try {
        const real = fs.realpathSync(bin);
        // .../bin/pi runs .../dist/cli.js of the package: the root is three
        // levels up (dist/cli.js -> package root), plus the global layout
        // (bin/pi -> ../lib/node_modules/@earendil-works/pi-coding-agent).
        candidates.push(path.resolve(path.dirname(real), '..', '..'));
        candidates.push(path.resolve(path.dirname(real), '..', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'));
        const binSrc = fs.readFileSync(real, 'utf8');
        const shebang = binSrc.split('\\n')[0] || '';
        const nodeMatch = shebang.match(/^#!\\s*(.+?)\\s*$/);
        if (nodeMatch) candidates.push(path.dirname(nodeMatch[1]));
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
(async () => {
  try {
    const cfg = JSON.parse(Buffer.from(process.env.PIWEB_PROBE || '', 'base64').toString('utf8'));
    const pkgDir = findPiPackageDir();
    if (!pkgDir) return out({ ok: false, error: "pi's package directory was not found on the device" });
    const sdk = require(path.join(pkgDir, 'dist', 'index.js'));
    // ModelRuntime is a class, so its type here is 'function', not 'object';
    // what the probe actually needs is the static create().
    const ModelRuntime = sdk && (sdk.ModelRuntime || (sdk.default && sdk.default.ModelRuntime));
    if (!ModelRuntime || typeof ModelRuntime.create !== 'function') {
      return out({ ok: false, error: "the device's pi build does not export a usable ModelRuntime (found: " + (ModelRuntime ? typeof ModelRuntime : String(ModelRuntime)) + ")" });
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-model-test-'));
    const modelsPath = path.join(tempDir, 'models.json');
    fs.writeFileSync(modelsPath, JSON.stringify({
      providers: { [cfg.providerName]: { ...cfg.provider, models: [{ ...cfg.model, id: cfg.modelId }] } },
    }, null, 2), 'utf8');
    const startedAt = Date.now();
    const finish = (result) => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      out(result);
    };
    sdk.ModelRuntime.create({ modelsPath }).then((modelRuntime) => {
      const loadError = modelRuntime.getError();
      if (loadError) return finish({ ok: false, error: loadError });
      const model = modelRuntime.getModel(cfg.providerName, cfg.modelId);
      if (!model) return finish({ ok: false, error: 'Model not found: ' + cfg.providerName + '/' + cfg.modelId });
      if (!modelRuntime.getProviderAuthStatus(cfg.providerName).configured) {
        return finish({ ok: false, error: 'No API key found for "' + cfg.providerName + '"' });
      }
      let status;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      modelRuntime.completeSimple(model, {
        messages: [{ role: 'user', content: 'Reply with OK only.', timestamp: Date.now() }],
      }, {
        sessionId: randomUUID(),
        maxTokens: 16,
        timeoutMs: 20000,
        maxRetries: 0,
        cacheRetention: 'none',
        signal: controller.signal,
        onResponse: (r) => { status = r.status; },
      }).then((message) => {
        clearTimeout(timeout);
        const latencyMs = Date.now() - startedAt;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          return finish({
            ok: false,
            error: message.errorMessage || (controller.signal.aborted ? 'Test timed out' : 'Model returned an error'),
            latencyMs,
            status,
          });
        }
        const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        finish({ ok: true, latencyMs, status, responseText: String(text).slice(0, 300) });
      }).catch((e) => {
        clearTimeout(timeout);
        finish({ ok: false, error: e && e.message ? e.message : String(e), latencyMs: Date.now() - startedAt });
      });
    }).catch((e) => finish({ ok: false, error: e && e.message ? e.message : String(e) }));
  } catch (e) {
    out({ ok: false, error: e && e.message ? e.message : String(e) });
  }
})();
`;
