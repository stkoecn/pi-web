import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// A `pi` installed by pi's own installer lives next to a private Node in
// ~/.local/share/pi-node/current/bin, and its shim's shebang is
// `#!/usr/bin/env node`. A host whose /usr/bin/node predates what pi needs
// (Debian 12 ships 18) then runs the shim with that node and dies on the first
// modern syntax — so the probe must put pi's directory first, not last.
const here = fileURLToPath(new URL(".", import.meta.url));
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

test("the shell prefix finds a pi installed beside its own Node", async () => {
  // jiti, not a plain import: the module has a TS parameter property, which
  // Node's strip-only loader refuses.
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { REMOTE_PATH_PREFIX } = await jiti.import("./persistent-shell.ts");
  const first = REMOTE_PATH_PREFIX.match(/PATH="([^"]*)"/)[1].split(":")[0];
  assert.equal(first, "$HOME/.local/share/pi-node/current/bin");
  // The older layouts stay behind it, so a plain `npm i -g` install still works.
  assert.match(REMOTE_PATH_PREFIX, /\$HOME\/\.local\/bin/);
  assert.match(REMOTE_PATH_PREFIX, /\$HOME\/\.local\/node\/bin/);
  // Never a bare `~`: quoted, it is a literal directory name.
  assert.doesNotMatch(REMOTE_PATH_PREFIX, /~/, "a quoted ~ would never expand");
});

test("the environment probe searches the same directories, in the same order", async () => {
  const route = read("../../../app/api/devices/env/route.ts");
  const line = route.match(/const PATH_PROBE = `export PATH="([^"]*)"/)[1];
  const dirs = line.split(":");
  assert.equal(dirs[0], "$HOME/.local/share/pi-node/current/bin", "pi's private Node must come first");
  for (const dir of ["$HOME/.local/node/bin", "$HOME/.local/bin", "$HOME/.cargo/bin", "$HOME/.bun/bin"]) {
    assert.ok(dirs.includes(dir), `${dir} must still be searched`);
  }
  assert.ok(!line.includes("~"), "a quoted ~ would never expand");
});
