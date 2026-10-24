import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { DeviceSelector, deviceSelectable } = await jiti.import("./DeviceSelector.tsx");

const noop = () => {};

function render(props) {
  return renderToStaticMarkup(
    React.createElement(DeviceSelector, { selectedDeviceId: "localhost", onSelectDevice: noop, ...props }),
  );
}

test("the full selector names the device and offers the caret", () => {
  const markup = render({ selectedDeviceId: "wsmac" });
  assert.match(markup, /Current Device: wsmac/);
  assert.match(markup, /Local|wsmac/);
  // The caret and the name are the desktop affordances; the dropdown is closed.
  assert.match(markup, /<polyline points="6 9 12 15 18 9"/);
  assert.match(markup, /aria-expanded="false"/);
});

test("the compact selector keeps the name in its accessible label only", () => {
  // A phone has no room for the name, but hiding it must not hide the host
  // from assistive tech or from the tooltip.
  const markup = render({ selectedDeviceId: "wsmac", compact: true });
  assert.match(markup, /title="Current Device: wsmac \(offline\)"/);
  assert.match(markup, /aria-label="Current Device: wsmac \(offline\)"/);
  assert.doesNotMatch(markup, /<polyline points="6 9 12 15 18 9"/);
  assert.doesNotMatch(markup, />wsmac</);
  // One square button the size of the bar's other icons.
  assert.match(markup, /width:36px/);
});

test("the status dot is on the glyph in both forms, so neither hides offline", () => {
  const compact = render({ selectedDeviceId: "wsmac", compact: true });
  const full = render({ selectedDeviceId: "wsmac" });
  for (const markup of [compact, full]) {
    assert.match(markup, /border-radius:50%/);
    assert.match(markup, /background-color:#ef4444/);
  }
});

test("the phone top bar renders the switcher, not only the desktop bar", async () => {
  // The selector used to live entirely inside `{!isMobile && …}`, which left a
  // phone with no way to change host at all. It is now the first item of the
  // mobile toolbar, in its compact form, and the desktop bar keeps the full one.
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const mobileToolbar = source.indexOf('data-mobile-toolbar="true"');
  assert.ok(mobileToolbar > 0, "the mobile toolbar must exist");
  const switcher = source.indexOf("<DeviceSelector", mobileToolbar);
  assert.ok(switcher > mobileToolbar, "the mobile toolbar must render the device selector");
  // Read the whole element, not a fixed window: its props grow, and a test that
  // counts characters fails for a reason that has nothing to do with the phone.
  const elementEnd = source.indexOf("/>", switcher);
  assert.ok(elementEnd > switcher, "the mobile selector must be self-closing");
  assert.match(source.slice(switcher, elementEnd), /compact/);
  // Both call sites share one handler, so a phone switches host the same way.
  const handlers = source.match(/onSelectDevice=\{handleSelectDevice\}/g) ?? [];
  assert.equal(handlers.length, 2);
});

test("a disconnected host cannot be picked, so the switcher never trades a working view for the offline banner", async () => {
  // The row used to call onSelectDevice() unconditionally, so tapping an
  // offline host replaced a working chat with a 503. Only "offline" is barred:
  // "connecting" is on its way back and must stay reachable.
  assert.equal(deviceSelectable("offline"), false);
  assert.equal(deviceSelectable("online"), true);
  assert.equal(deviceSelectable("connecting"), true);

  const source = await readFile(new URL("./DeviceSelector.tsx", import.meta.url), "utf8");
  assert.match(source, /data-device-disabled=\{selectable \? undefined : "true"\}/);
  assert.match(source, /aria-disabled=\{selectable \? undefined : true\}/);
  assert.match(source, /tabIndex=\{selectable \? 0 : -1\}/);
  // The guard sits in the handler itself, not only in the styling.
  assert.match(source, /if \(!selectable\) return;[\s\S]{0,40}onSelectDevice\(device\.id\);/);
  // A host with no connection has no shell to open either.
  assert.match(source, /onOpenTerminalOnDevice && selectable &&/);
});
