import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
// dev 删除了 package-lock.json（bun.lock 惯例）：锁文件完整性只在跟踪 npm
// lockfile 的分支上有意义，这里整体跳过而不是让 require 直接抛错。
const hasPackageLock = (() => {
  try { require.resolve("../package-lock.json"); return true; } catch { return false; }
})();
const packageLock = hasPackageLock ? require("../package-lock.json") : null;

// pi's packages up to 1.2.0 depend on each other with `^` ranges (1.3.0 pins
// them exactly), and an install of the published pi-web resolves them afresh:
// package-lock.json is not published. So every pi package in the tree is a
// direct dependency at the exact version locked here, which npm reuses for the
// SDK's own ranges. pi-web 0.12.0 pinned only four of them, and installs after
// pi 1.2.0 came out paired pi-coding-agent 1.1.0 with pi-codemode 1.2.0, which
// it cannot load.
const PI_SCOPE = "@earendil-works/";

test("every pi package in the tree is a direct dependency pinned to its locked version", { skip: !hasPackageLock && "no package-lock.json on this branch (bun.lock convention)" }, () => {
  const nameOf = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const locked = Object.entries(packageLock.packages).filter(([path]) => nameOf(path).startsWith(PI_SCOPE));
  assert.ok(locked.length > 0, "the lockfile holds pi packages");
  for (const [path, entry] of locked) {
    const name = nameOf(path);
    assert.equal(path, `node_modules/${name}`, `${path}: a second copy of ${name}`);
    assert.equal(packageJson.dependencies[name], entry.version, `${name} must be a dependency pinned to ${entry.version}`);
  }
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    if (!name.startsWith(PI_SCOPE)) continue;
    assert.equal(packageLock.packages[`node_modules/${name}`]?.version, version, `${name} is pinned but not locked at ${version}`);
  }
});
