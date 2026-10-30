import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseMeshTarget, resolveProjectPath } = await jiti.import("./mesh-target.ts");

test("parseMeshTarget with [projectPath] brackets", () => {
  const t1 = parseMeshTarget("sess123@[/home/user/work/pi-web].wsnas");
  assert.deepEqual(t1, {
    raw: "sess123@[/home/user/work/pi-web].wsnas",
    sessionTarget: "sess123",
    projectTarget: "/home/user/work/pi-web",
    deviceTarget: "wsnas",
    isNewSession: false,
  });

  const t2 = parseMeshTarget("@[D:/work/repoA/pi-web].wshome");
  assert.deepEqual(t2, {
    raw: "@[D:/work/repoA/pi-web].wshome",
    sessionTarget: undefined,
    projectTarget: "D:/work/repoA/pi-web",
    deviceTarget: "wshome",
    isNewSession: true,
  });
});

test("parseMeshTarget with host:absolutePath syntax for new sessions", () => {
  const t1 = parseMeshTarget("wsnas:/home/windsing/pi-web");
  assert.deepEqual(t1, {
    raw: "wsnas:/home/windsing/pi-web",
    sessionTarget: undefined,
    projectTarget: "/home/windsing/pi-web",
    deviceTarget: "wsnas",
    isNewSession: true,
  });

  const t2 = parseMeshTarget("wshome:D:/proj/pi-web");
  assert.deepEqual(t2, {
    raw: "wshome:D:/proj/pi-web",
    sessionTarget: undefined,
    projectTarget: "D:/proj/pi-web",
    deviceTarget: "wshome",
    isNewSession: true,
  });
});

test("parseMeshTarget with direct session.host syntax", () => {
  const t1 = parseMeshTarget("sess123.wsnas");
  assert.deepEqual(t1, {
    raw: "sess123.wsnas",
    sessionTarget: "sess123",
    projectTarget: undefined,
    deviceTarget: "wsnas",
    isNewSession: false,
  });

  const t2 = parseMeshTarget("442d76a5-d050-4822-ba74-3ee1d1469e76.wshome");
  assert.deepEqual(t2, {
    raw: "442d76a5-d050-4822-ba74-3ee1d1469e76.wshome",
    sessionTarget: "442d76a5-d050-4822-ba74-3ee1d1469e76",
    projectTarget: undefined,
    deviceTarget: "wshome",
    isNewSession: false,
  });
});
