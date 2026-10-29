import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readProjectTeamConfig,
  writeProjectTeamConfig,
  toggleProjectEnabledForContacts,
  isProjectEnabledForContacts,
  readGlobalMeshDescriptions,
  setProjectDescription,
  getProjectDescription,
  setSessionDescription,
  getSessionDescription,
} from "./team-mesh-config.ts";

test("team-mesh-config project-level enabled contacts", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-mesh-test-"));
  try {
    // 1. Initially empty
    const initial = readProjectTeamConfig(tmpDir);
    assert.deepEqual(initial.enabledProjects, []);
    assert.equal(isProjectEnabledForContacts(tmpDir, "wshome", "D:/proj/pi-web"), false);

    // 2. Toggle enable
    toggleProjectEnabledForContacts(tmpDir, "wshome", "D:/proj/pi-web", true);
    assert.equal(isProjectEnabledForContacts(tmpDir, "wshome", "D:/proj/pi-web"), true);
    assert.equal(isProjectEnabledForContacts(tmpDir, "wshome", "d:/proj/pi-web"), true); // case-insensitive check

    const updated = readProjectTeamConfig(tmpDir);
    assert.equal(updated.enabledProjects.length, 1);
    assert.equal(updated.enabledProjects[0], "wshome:D:/proj/pi-web");

    // 3. Toggle disable
    toggleProjectEnabledForContacts(tmpDir, "wshome", "D:/proj/pi-web", false);
    assert.equal(isProjectEnabledForContacts(tmpDir, "wshome", "D:/proj/pi-web"), false);
    const emptied = readProjectTeamConfig(tmpDir);
    assert.deepEqual(emptied.enabledProjects, []);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("team-mesh-config global project & session descriptions", () => {
  // Test setters and getters
  setProjectDescription("test-device", "/test/project", "Test Project Description");
  assert.equal(getProjectDescription("test-device", "/test/project"), "Test Project Description");

  setSessionDescription("test-device", "session-123", "Session Handling Task A");
  assert.equal(getSessionDescription("test-device", "session-123"), "Session Handling Task A");

  // Clean up
  setProjectDescription("test-device", "/test/project", "");
  assert.equal(getProjectDescription("test-device", "/test/project"), "");

  setSessionDescription("test-device", "session-123", "");
  assert.equal(getSessionDescription("test-device", "session-123"), "");
});
