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

test("an offline host is still pickable, because picking it is the request to dial it", async () => {
  // A row that refuses the click leaves a sleeping machine with no way back
  // short of Settings. The safety moved to the switch itself: AppShell dials
  // first and only moves the view once the host answers, so the offline row
  // stays a live button.
  assert.equal(deviceSelectable("offline"), true);
  assert.equal(deviceSelectable("online"), true);
  assert.equal(deviceSelectable("connecting"), true);

  const source = await readFile(new URL("./DeviceSelector.tsx", import.meta.url), "utf8");
  // The row says what it is doing instead of silently doing nothing.
  assert.match(source, /const connecting = connectingDeviceId === device\.id;/);
  assert.match(source, /"connecting…"/);
  assert.match(source, /is offline: picking it dials it first/);
});

test("switching hosts dials the new one before the view moves", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  // The dial is awaited, and a refusal returns before setSelectedDeviceId.
  const handler = source.slice(
    source.indexOf("const handleSelectDevice = useCallback("),
    source.indexOf("const handleOpenTerminal = useCallback("),
  );
  assert.ok(handler.length > 0, "handleSelectDevice must exist");
  const dialAt = handler.indexOf('action: "connect"');
  const moveAt = handler.indexOf("setSelectedDeviceId(id);");
  assert.ok(dialAt > 0, "the switch must ask the gateway to connect first");
  assert.ok(moveAt > dialAt, "the view must move only after the dial is answered");
  // A failed dial says why and leaves the current host alone.
  assert.match(handler, /if \(!res\.ok \|\| body\.success !== true\) \{[\s\S]{0,200}return;/);
});
