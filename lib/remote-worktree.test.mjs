import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// `server-only` is a Next.js marker package and is not resolvable outside a
// Next build; the pure helpers below do not touch the gateway, so an empty stub
// is enough to load the module in a plain node test.
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: { "server-only": fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) },
});
const { parseWorktreePorcelain, worktreeForPath } = await jiti.import("@/lib/remote-worktree");

test("parses the main worktree and linked worktrees", () => {
  const stdout = [
    "worktree /Users/a/proj/repo",
    "HEAD 811133a4fa3002e8d80211f163f4c4b7e3b8df24",
    "branch refs/heads/main",
    "",
    "worktree /Users/a/proj/repo-worktrees/feature-x",
    "HEAD 1234567890abcdef",
    "branch refs/heads/feature/x",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: "/Users/a/proj/repo", branch: "main", isMain: true },
    { path: "/Users/a/proj/repo-worktrees/feature-x", branch: "feature/x", isMain: false },
  ]);
});

test("detached worktree keeps a null branch", () => {
  const stdout = ["worktree /repo", "HEAD abc123", "detached", ""].join("\n");
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: "/repo", branch: null, isMain: true },
  ]);
});

test("prunable worktrees are skipped and do not claim the main slot", () => {
  const stdout = [
    "worktree /repo-gone",
    "HEAD abc123",
    "prunable gitdir file points to non-existent location",
    "",
    "worktree /repo",
    "HEAD def456",
    "branch refs/heads/main",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: "/repo", branch: "main", isMain: true },
  ]);
});

test("CRLF output from a plain sh is tolerated", () => {
  const stdout = "worktree /repo\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n";
  assert.deepEqual(parseWorktreePorcelain(stdout), [
    { path: "/repo", branch: "main", isMain: true },
  ]);
});

test("empty output has no worktrees", () => {
  assert.deepEqual(parseWorktreePorcelain(""), []);
});

test("worktreeForPath matches ignoring a trailing slash", () => {
  const worktrees = [
    { path: "/repo", branch: "main", isMain: true },
    { path: "/repo-worktrees/x", branch: "x", isMain: false },
  ];
  assert.equal(worktreeForPath(worktrees, "/repo-worktrees/x/"), "/repo-worktrees/x");
  assert.equal(worktreeForPath(worktrees, "/repo-worktrees/y"), null);
});
