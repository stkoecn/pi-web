import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The pane is a client component driven by fetch, so its shape is asserted from
// the source the way DeviceSelector's rows are: these are rules about what the
// pane may offer, not about markup it produces for one set of props.
const source = await readFile(new URL("./DevicesConfig.tsx", import.meta.url), "utf8");

test("a host from ~/.ssh/config is shown, never saved", () => {
  // Picking the row must not fill an editable draft: a draft is what Save posts.
  const handler = source.slice(source.indexOf("const showSshHost ="));
  const body = handler.slice(0, handler.indexOf("const startAdd ="));
  assert.match(body, /setDraft\(null\)/, "the ssh row must not become a draft");
  assert.match(body, /setSelectedSshId\(host\.id\)/);
  assert.doesNotMatch(body, /setAddMode\(true\)/, "showing a host is not adding one");
  // A host the gateway already dials opens as the device it is.
  assert.match(body, /configs\.find\(\(config\) => config\.id === host\.id\)/);
  assert.match(body, /select\(existing\)/);
});

test("the ssh row cannot be deleted, because nothing was written", () => {
  const start = source.indexOf("{sshHost ? (");
  const branch = source.slice(start, source.indexOf(") : !draft ? (", start));
  assert.ok(branch.length > 0, "the read-only branch must exist");
  assert.doesNotMatch(branch, /onClick=\{\(\) => void remove\(\)\}/);
  assert.doesNotMatch(branch, /i18n\.remove/);
  // Connecting is the one thing it can do.
  assert.match(branch, /toggleConnection/);
  // Its fields come from ssh, so they are read-only rather than a second copy.
  assert.match(branch, /readOnly/);
  assert.match(branch, /devices\.sshReadOnly/);
});

test("a new device can only be a reverse tunnel", () => {
  const start = source.indexOf("const startAdd =");
  const body = source.slice(start, source.indexOf("const problem =", start));
  assert.match(body, /mode: "reverse_tunnel"/);
  assert.match(body, /setSelectedSshId\(null\)/);
});

test("the mode switch hides active_ssh while adding, and keeps both when editing", () => {
  // A dialled host arrives from ~/.ssh/config, so offering to type one here
  // would be a second, drifting way to describe the same machine.
  assert.match(
    source,
    /addMode\s*\?\s*\(\["reverse_tunnel"\] as const\)\s*:\s*\(\["active_ssh", "reverse_tunnel"\] as const\)/,
  );
});

test("showing an ssh row is not undone by the land-on-a-device effect", () => {
  // That effect fills the pane when there is no draft. An ssh row also has no
  // draft, so without the guard the pane would jump to the first saved device
  // the moment the row was picked.
  const start = source.indexOf("// Land on a device rather than an empty pane");
  const guard = source.slice(start, source.indexOf("const first =", start));
  assert.match(guard, /if \(addMode \|\| draft \|\| selectedSshId\) return;/);
  assert.match(
    source,
    /\}, \[addMode, configs, draft, fetchPairingCommand, selectedId, selectedSshId\]\);/,
  );
});

test("one machine is one row: a saved device hides its ssh stanza", () => {
  // A device the gateway dials also has a stanza, so an unfiltered list would
  // show the same machine twice — once editable, once read-only.
  const start = source.indexOf("const sshOnlyHosts = useMemo(");
  assert.ok(start > 0, "the filtered list must exist");
  const body = source.slice(start, source.indexOf("});", start));
  assert.match(body, /data\?\.sshHosts \?\? \[\]/);
  assert.match(body, /!configs\.some\(\(config\) => config\.id === host\.id\)/);
  assert.match(source, /\{sshOnlyHosts\.map\(\(host\) => \{/);
  assert.doesNotMatch(source, /data\?\.sshHosts\?\.map/);
});
