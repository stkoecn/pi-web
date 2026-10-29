import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { disambiguateProjectPaths } = await jiti.import("./project-disambiguation.ts");

test("disambiguateProjectPaths without collisions returns basename", () => {
  const paths = ["/home/windsing/pi-web", "/home/windsing/chat-agent"];
  const res = disambiguateProjectPaths(paths);
  assert.equal(res.get("/home/windsing/pi-web"), "pi-web");
  assert.equal(res.get("/home/windsing/chat-agent"), "chat-agent");
});

test("disambiguateProjectPaths with collisions includes parent directories", () => {
  const paths = [
    "/data/repoA/pi-web",
    "/data/repoB/pi-web",
    "/data/common/tool"
  ];
  const res = disambiguateProjectPaths(paths);
  assert.equal(res.get("/data/repoA/pi-web"), "repoA/pi-web");
  assert.equal(res.get("/data/repoB/pi-web"), "repoB/pi-web");
  assert.equal(res.get("/data/common/tool"), "tool");
});

test("disambiguateProjectPaths with Windows backslashes", () => {
  const paths = [
    "D:\\work\\client\\pi-web",
    "D:\\personal\\client\\pi-web",
    "E:\\other\\pi-web"
  ];
  const res = disambiguateProjectPaths(paths);
  assert.equal(res.get("D:\\work\\client\\pi-web"), "work/client/pi-web");
  assert.equal(res.get("D:\\personal\\client\\pi-web"), "personal/client/pi-web");
  assert.equal(res.get("E:\\other\\pi-web"), "other/pi-web");
});
