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
  const start = source.indexOf(") : sshHost ? (");
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
  // No mode radio, no host, no port, no password: the draft is the tunnel
  // draft, and `draftToBody` stamps `mode: "reverse_tunnel"` on every save.
  assert.match(body, /setDraft\(emptyDraft\(\)\)/);
  assert.match(body, /setSelectedSshId\(null\)/);
  assert.doesNotMatch(body, /mode:/);
});

test("the form has no way to type a dialled host", () => {
  // A host the gateway reaches arrives from ~/.ssh/config, so a second, drifting
  // way to describe the same machine must not exist in the pane.
  // The last such block is the editable one: the read-only ssh branch has its own.
  const form = source.slice(
    source.lastIndexOf('<div className="settings-device-form">'),
    source.indexOf('{t("devices.secretNote")}'),
  );
  assert.doesNotMatch(form, /data-device-field="host"/);
  assert.doesNotMatch(form, /data-device-field="port"/);
  assert.doesNotMatch(form, /data-device-field="password"/);
  assert.doesNotMatch(form, /devices\.authMethod/);
  assert.doesNotMatch(form, /devices\.field\.mode/);
  // The tunnel command is the whole point of the form.
  assert.match(form, /devices\.tunnelCommand/);
});

test("showing an ssh row is not undone by the land-on-a-device effect", () => {
  // That effect fills the pane when there is no draft. An ssh row also has no
  // draft, so without the guard the pane would jump to the first saved device
  // the moment the row was picked.
  const start = source.indexOf("// Land on a device rather than an empty pane");
  const guard = source.slice(start, source.indexOf("const first =", start));
  assert.match(guard, /if \(addMode \|\| draft \|\| selectedSshId \|\| selectedProblem !== null\) return;/);
  assert.match(
    source,
    /\}, \[addMode, configs, draft, fetchPairingCommand, selectedId, selectedProblem, selectedSshId\]\);/,
  );
});

test("the list is split in two by direction, and the detail says how it is reached", () => {
  // Direction decides how a host behaves, and it is a property of the whole
  // group: repeating a tag on 17 rows was noise, so the split carries it.
  assert.match(source, /devices\.groupActive/);
  assert.match(source, /devices\.groupReverse/);
  assert.doesNotMatch(source, /devices\.groupHosts/);
  assert.doesNotMatch(source, /devices\.groupSaved/);
  assert.doesNotMatch(source, /devices\.groupSsh/);

  // 主动 first: the hosts ssh already describes are the ones a reader looks for.
  const active = source.indexOf('devices.groupActive');
  const reverse = source.indexOf('devices.groupReverse');
  const firstSshRow = source.indexOf('data-device-ssh-item=');
  assert.ok(active > 0 && reverse > active, "the active group heading comes first");
  assert.ok(firstSshRow > active && firstSshRow < reverse, "ssh rows sit under the active heading");

  // The jump hops belong to one host, so they are shown in its detail.
  assert.match(source, /devices\.sshJump/);
  assert.match(source, /sshHost\.jump\.join\(" → "\)/);

  // No direction tag on the rows themselves any more.
  const listStart = source.indexOf("<ConfigSidebar>");
  const listEnd = source.indexOf("</ConfigSidebar>");
  assert.doesNotMatch(source.slice(listStart, listEnd), /settings-device-kind/);
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

test("a stanza the pane cannot use is a row with a question mark, not a footnote", () => {
  // "2 hosts cannot be used, see the server log" is not something a reader can
  // act on: the row is where the host would have been, and the reason is in its
  // detail pane.
  assert.match(source, /data-device-ssh-problem=/);
  assert.match(source, /className="settings-device-problem"/);
  assert.match(source, /devices\.sshProblemShort/);
  assert.match(source, /devices\.sshProblemFix/);
  // The count-only line is gone.
  assert.doesNotMatch(source, /devices\.sshProblems/);
  // Problems stay inside the 主动 group, right after the hosts it could read.
  const active = source.indexOf("devices.groupActive");
  const reverse = source.indexOf("devices.groupReverse");
  const problems = source.indexOf("data-device-ssh-problem=");
  assert.ok(problems > active && problems < reverse, "problem rows sit under the active heading");
});

test("a discovered host is switched off until the user turns it on", () => {
  // `~/.ssh/config` is the user's whole address book. Serving every stanza in
  // the switcher would put machines there that were never offered, so each row
  // starts off and the switch lives in its detail header.
  assert.match(source, /isHostEnabled/);
  assert.match(source, /devices\.status\.disabled/);
  assert.match(source, /toggleEnabled\(sshHost\.id, checked\)/);
  // A host that is off has nothing to dial, so its connect button is inert.
  assert.match(source, /!isHostEnabled\(sshHost\)/);
  // The detail pane explains what the switch means in both positions.
  assert.match(source, /devices\.enabledHint/);
  assert.match(source, /devices\.disabledHint/);
});

test("the switch sits in the detail header, as a models.json provider's does", () => {
  // Left-side list rows are for picking a host, not for configuring one: a
  // switch in every row made the list read as a wall of toggles.
  const sshBranch = source.indexOf(") : sshHost ? (");
  assert.ok(sshBranch > 0, "the ssh detail branch must exist");
  const headerStart = source.indexOf("<ConfigDetailActions>", sshBranch);
  assert.ok(headerStart > 0, "the ssh detail header must have an actions slot");
  const actions = source.slice(headerStart, source.indexOf("</ConfigDetailActions>", headerStart));
  assert.match(actions, /<ConfigSwitch/, "the switch belongs in the header actions");
  assert.match(actions, /describedBy=\{switchNoteId\}/, "and points at the note under the header");
  // The note is what the switch points at, so both sides exist.
  assert.match(source, /id=\{switchNoteId\}/);
  // No switch is rendered inside the sidebar list.
  const sidebarStart = source.indexOf("<ConfigSidebarList>");
  const sidebarEnd = source.indexOf("</ConfigSidebarList>", sidebarStart);
  assert.doesNotMatch(source.slice(sidebarStart, sidebarEnd), /<ConfigSwitch/);
});

test("switching a host sends enable or disable, not a connection", () => {
  const start = source.indexOf("const toggleEnabled = useCallback(");
  assert.ok(start > 0, "the switch handler must exist");
  const body = source.slice(start, source.indexOf("}, [load, onDevicesChanged, t]);", start));
  assert.match(body, /action: enabled \? "enable" : "disable"/);
  assert.match(body, /"\/api\/devices\/control"/);
  // Off drops the connection on the gateway side, so a refresh must follow.
  assert.match(body, /await load\(\)/);
});
