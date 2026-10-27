import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// `server-only` is a Next.js marker package and is not resolvable outside a
// Next build; the helpers below are handed a driver, so an empty stub is enough.
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const {
  RemoteSkillsError,
  installSkillOn,
  installSucceeded,
  skillInstallArgs,
  stripAnsi,
  updateSkillOn,
} = await jiti.import("@/lib/remote-skill-writes");

/** A driver that records what it was asked to run and answers with `result`. */
function fakeDriver(result = { stdout: "", stderr: "", exitCode: 0 }) {
  const calls = [];
  return {
    calls,
    deviceId: "dev",
    exec: async (cmd, args = [], opts = {}) => {
      calls.push({ cmd, args, opts });
      return result;
    },
  };
}

const INSTALL_OK = "✓ Installation complete\n";

test("a global install asks the CLI for -g, a project install does not", () => {
  assert.deepEqual(skillInstallArgs("owner/repo", "global"), [
    "skills", "add", "owner/repo", "-y", "--agent", "pi", "-g",
  ]);
  assert.deepEqual(skillInstallArgs("owner/repo", "project"), [
    "skills", "add", "owner/repo", "-y", "--agent", "pi",
  ]);
});

test("the install runs npx on the device, in the project folder only for a project install", async () => {
  const project = fakeDriver({ stdout: INSTALL_OK, stderr: "", exitCode: 0 });
  await installSkillOn(project, { package: "owner/repo", scope: "project", cwd: "/proj/x" });
  assert.equal(project.calls.length, 1);
  assert.equal(project.calls[0].cmd, "npx");
  assert.deepEqual(project.calls[0].args, ["skills", "add", "owner/repo", "-y", "--agent", "pi"]);
  assert.equal(project.calls[0].opts.cwd, "/proj/x");
  // Colour codes would end up in the panel's message.
  assert.equal(project.calls[0].opts.env.FORCE_COLOR, "0");

  const global = fakeDriver({ stdout: INSTALL_OK, stderr: "", exitCode: 0 });
  await installSkillOn(global, { package: "owner/repo", scope: "global", cwd: "/proj/x" });
  assert.equal(global.calls[0].opts.cwd, undefined, "a global install must not run inside a project");
});

test("success is decided by the CLI's own words, as the local route decides it", async () => {
  assert.equal(installSucceeded(INSTALL_OK), true);
  assert.equal(installSucceeded("Installed 3 skills"), true);
  // The CLI exits 0 after refusing a package, so an exit status alone would
  // report a failed install as a success.
  const refused = fakeDriver({ stdout: "Installation failed", stderr: "", exitCode: 0 });
  await assert.rejects(
    () => installSkillOn(refused, { package: "owner/repo", scope: "global" }),
    (error) => error instanceof RemoteSkillsError,
  );
});

test("a failed install keeps the tail of the CLI's message", async () => {
  const output = `${"x".repeat(400)}Installation failed: no access`;
  const driver = fakeDriver({ stdout: output, stderr: "", exitCode: 0 });
  await assert.rejects(
    () => installSkillOn(driver, { package: "owner/repo", scope: "global" }),
    (error) => {
      assert.match(error.message, /Installation failed: no access$/);
      assert.ok(error.message.length <= 300, "the whole log must not be returned");
      return true;
    },
  );
});

test("terminal control sequences never reach the caller", async () => {
  assert.equal(stripAnsi("\x1b[1G\x1b[J✓ done\x1b[?25h"), "✓ done");
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  const driver = fakeDriver({ stdout: "\x1b[1G" + INSTALL_OK, stderr: "", exitCode: 0 });
  const { output } = await installSkillOn(driver, { package: "owner/repo", scope: "global" });
  assert.equal(output.includes("\x1b"), false);
});

test("an update re-runs the install command the lock file recorded", async () => {
  const driver = fakeDriver({ stdout: "updated", stderr: "", exitCode: 0 });
  await updateSkillOn(driver, {
    install: {
      package: "owner/repo@my-skill",
      scope: "global",
      source: "owner/repo",
      skillPath: "skills/my-skill/SKILL.md",
      ref: "v1.0.0",
      canCheckForUpdates: true,
    },
  });
  const [call] = driver.calls;
  assert.equal(call.cmd, "npx");
  // Same arguments the local route builds: the CLI has no separate upgrade verb.
  assert.deepEqual(call.args, [
    "skills", "add", "owner/repo/skills/my-skill#v1.0.0", "--skill", "my-skill", "-y", "--agent", "pi", "-g",
  ]);
});

test("an update that exits non-zero is an error even with success-looking output", async () => {
  const driver = fakeDriver({ stdout: "Installation complete", stderr: "boom", exitCode: 1 });
  await assert.rejects(
    () => updateSkillOn(driver, {
      install: { package: "o/r@s", scope: "global", source: "o/r", skillPath: "s/SKILL.md", canCheckForUpdates: true },
    }),
    (error) => error instanceof RemoteSkillsError && /boom/.test(error.message),
  );
});

// --- skill toggle -------------------------------------------------------

const { isDeviceSkillPath, toggleSkillsOn } = await jiti.import("@/lib/remote-skill-writes");

/** A device whose files live in `files`, recording every write it is asked for. */
function deviceWithFiles(files) {
  const writes = [];
  const scripts = [];
  return {
    writes,
    scripts,
    deviceId: "dev",
    exec: async (command) => {
      scripts.push(command);
      // Both operations arrive as a base64-encoded `sh` script, so the inner
      // script says which one it is: a read pipes each file through base64, a
      // write copies a temp file over the target.
      const wrapper = /printf %s (\S+) \| base64 -d \| sh/.exec(command);
      const inner = wrapper ? Buffer.from(wrapper[1], "base64").toString("utf8") : "";
      if (!inner.includes(" > ")) {
        // The reader numbers the paths it was given, not the whole fake device.
        const wanted = [...inner.matchAll(/\[ -f '([^']*)' \]/g)].map((match) => match[1]);
        const parts = [];
        wanted.forEach((path, index) => {
          const contents = files.get(path);
          if (contents === undefined) return;
          parts.push(`@@piweb-file@@${index}\n${Buffer.from(contents, "utf8").toString("base64")}`);
        });
        return { stdout: parts.length > 0 ? parts.join("\n") + "\n" : "", stderr: "", exitCode: 0 };
      }
      const target = /cat '[^']*' > '([^']*)'/.exec(inner);
      const payload = /printf %s (\S+) \| base64 -d > /.exec(inner);
      if (target && payload) {
        writes.push({
          path: target[1],
          contents: Buffer.from(payload[1], "base64").toString("utf8"),
        });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

const SKILL = "---\nname: demo\n---\nbody\n";

test("only a Markdown file under a skills directory may be toggled", () => {
  assert.equal(isDeviceSkillPath("/Users/x/.pi/agent/skills/demo/SKILL.md"), true);
  // A symlink into a project is still a skill.
  assert.equal(isDeviceSkillPath("/Users/x/proj/app/skills/demo/SKILL.md"), true);
  // The same agent directory holds files a frontmatter edit would destroy.
  assert.equal(isDeviceSkillPath("/Users/x/.pi/agent/settings.json"), false);
  assert.equal(isDeviceSkillPath("/Users/x/.pi/agent/auth.json"), false);
  assert.equal(isDeviceSkillPath("/Users/x/.pi/agent/skills/demo/notes.txt"), false);
  // A relative path would resolve against whatever cwd the shell happens to have.
  assert.equal(isDeviceSkillPath("skills/demo/SKILL.md"), false);
});

test("a toggle writes the frontmatter and leaves the body alone", async () => {
  const driver = deviceWithFiles(new Map([["/a/skills/d/SKILL.md", SKILL]]));
  const results = await toggleSkillsOn(driver, ["/a/skills/d/SKILL.md"], true);
  assert.deepEqual(results, [{ filePath: "/a/skills/d/SKILL.md" }]);
  assert.equal(driver.writes.length, 1);
  assert.match(driver.writes[0].contents, /^---\ndisable-model-invocation: true\nname: demo\n---\nbody\n$/);
});

test("a skill already in the requested state is not written", async () => {
  // Rewriting an unchanged file would move its mtime for no reason; the local
  // route makes the same promise.
  const already = "---\ndisable-model-invocation: true\nname: demo\n---\nbody\n";
  const driver = deviceWithFiles(new Map([["/a/skills/d/SKILL.md", already]]));
  const results = await toggleSkillsOn(driver, ["/a/skills/d/SKILL.md"], true);
  assert.deepEqual(results, [{ filePath: "/a/skills/d/SKILL.md" }]);
  assert.equal(driver.writes.length, 0);
});

test("a batch reads once and reports each file on its own", async () => {
  const driver = deviceWithFiles(new Map([
    ["/a/skills/one/SKILL.md", SKILL],
    ["/a/skills/two/SKILL.md", SKILL],
    ["/a/settings.json", "{}"],
    ["/a/skills/gone/SKILL.md", undefined],
  ]));
  const results = await toggleSkillsOn(driver, [
    "/a/skills/one/SKILL.md",
    "/a/settings.json",
    "/a/skills/two/SKILL.md",
    "/a/skills/gone/SKILL.md",
  ], true);
  // Results follow the request order, because the panel pairs each answer with
  // the row it came from.
  assert.deepEqual(results, [
    { filePath: "/a/skills/one/SKILL.md" },
    { filePath: "/a/settings.json", error: "Not a skill file" },
    { filePath: "/a/skills/two/SKILL.md" },
    { filePath: "/a/skills/gone/SKILL.md", error: "file not found" },
  ]);
  assert.equal(driver.writes.length, 2, "the refused paths must not be written");
});

test("a read-modify-write cycle does not grow the file", async () => {
  // Regression: the batched reader used to add a newline per file, so toggling
  // a skill off and on again appended blank lines to the device's file.
  const driver = deviceWithFiles(new Map([["/a/skills/d/SKILL.md", SKILL]]));
  await toggleSkillsOn(driver, ["/a/skills/d/SKILL.md"], true);
  const once = driver.writes.at(-1).contents;
  const second = deviceWithFiles(new Map([["/a/skills/d/SKILL.md", once]]));
  await toggleSkillsOn(second, ["/a/skills/d/SKILL.md"], false);
  assert.equal(second.writes.at(-1).contents, SKILL);
});
