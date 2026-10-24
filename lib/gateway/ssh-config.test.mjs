import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseSshConfig, deviceIdFromAlias, sshHostToDevice } = await jiti.import("./ssh-config.ts");

const HOME = "/home/me";
const parse = (text, extra = {}) => parseSshConfig(text, {
  sourcePath: `${HOME}/.ssh/config`,
  home: HOME,
  osUser: "me",
  exists: () => true,
  ...extra,
});

test("a block becomes a host with the fields ssh would use", () => {
  const { hosts } = parse(`
Host wsmac
  HostName 192.168.1.7
  User windsing
  IdentityFile ~/.ssh/wshome
  IdentitiesOnly yes
`);
  assert.deepEqual(hosts, [{
    alias: "wsmac",
    hostName: "192.168.1.7",
    port: 22,
    username: "windsing",
    privateKeyPath: "/home/me/.ssh/wshome",
  }]);
});

test("a block with no HostName dials the alias itself", () => {
  const { hosts } = parse(`
Host build.example.com
  User ci
`);
  assert.equal(hosts[0].hostName, "build.example.com");
  assert.equal(hosts[0].port, 22);
});

test("several aliases on one Host line each become a host", () => {
  const { hosts } = parse(`
Host 192.168.1.7 wsmac mac
  User windsing
`);
  assert.deepEqual(hosts.map((host) => host.alias), ["192.168.1.7", "wsmac", "mac"]);
  // Without a HostName each alias is its own address, exactly as `ssh wsmac`
  // would resolve it: the block only shares the options, not the name.
  assert.deepEqual(hosts.map((host) => host.hostName), ["192.168.1.7", "wsmac", "mac"]);
  assert.ok(hosts.every((host) => host.username === "windsing"));
});

test("a wildcard block contributes defaults but is not itself a host", () => {
  const { hosts } = parse(`
Host *
  User deploy
  Port 2222

Host prod
  HostName prod.example.com
`);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].alias, "prod");
  // `Host *` above it supplies the defaults, as ssh resolves them.
  assert.equal(hosts[0].username, "deploy");
  assert.equal(hosts[0].port, 2222);
});

test("a concrete value beats the wildcard default, whichever comes first", () => {
  const { hosts } = parse(`
Host prod
  HostName prod.example.com
  User root

Host *
  User deploy
`);
  assert.equal(hosts[0].username, "root");
});

test("comments, blank lines, = and unknown keywords are tolerated", () => {
  const { hosts, problems } = parse(`
# the desktop
Host wscomp
  HostName=10.8.8.10
  User Administrator   # a trailing comment
  ForwardAgent yes
  ServerAliveInterval 30
`);
  assert.equal(problems.length, 0);
  assert.equal(hosts[0].hostName, "10.8.8.10");
  assert.equal(hosts[0].username, "Administrator");
});

test("ProxyJump resolves the hop alias to that alias' own address, port and key", () => {
  const { hosts } = parse(
    `
Host wscomp
  HostName 10.20.30.33
  User Administrator
  Port 2200
  IdentityFile /keys/wscomp

Host 192.168.0.25
  HostName 192.168.0.25
  User windsing
  ProxyJump wscomp
`,
    { exists: () => true },
  );
  const target = hosts.find((host) => host.alias === "192.168.0.25");
  assert.equal(target.unsupported, undefined);
  assert.deepEqual(target.jump, [
    { alias: "wscomp", host: "10.20.30.33", port: 2200, username: "Administrator", privateKeyPath: "/keys/wscomp" },
  ]);
});

test("a ProxyJump alias later in the file still resolves", () => {
  const { hosts } = parse(`
Host 192.168.0.25
  HostName 192.168.0.25
  ProxyJump wscomp

Host wscomp
  HostName 10.20.30.33
`);
  const target = hosts.find((host) => host.alias === "192.168.0.25");
  assert.equal(target.jump?.[0]?.host, "10.20.30.33");
});

test("a ProxyJump chain keeps its order", () => {
  const { hosts } = parse(`
Host a
  HostName 10.0.0.1
Host b
  HostName 10.0.0.2
Host target
  HostName 10.0.0.3
  ProxyJump a,b
`);
  const target = hosts.find((host) => host.alias === "target");
  assert.deepEqual(target.jump?.map((hop) => hop.alias), ["a", "b"]);
});

test("a ProxyJump naming an unknown host is dialled at that name, as ssh would", () => {
  const { hosts } = parse(`
Host target
  HostName 10.0.0.3
  User windsing
  ProxyJump gateway.example
`);
  const target = hosts.find((host) => host.alias === "target");
  assert.equal(target.unsupported, undefined);
  assert.equal(target.jump?.[0]?.host, "gateway.example");
  assert.equal(target.jump?.[0]?.port, 22);
  assert.equal(target.jump?.[0]?.username, "me", "the OS user, since the hop names none");
});

test("ProxyJump none means a direct connection", () => {
  const { hosts } = parse(`
Host target
  HostName 10.0.0.3
  ProxyJump none
`);
  assert.equal(hosts[0].jump, undefined);
  assert.equal(hosts[0].unsupported, undefined);
});

test("ProxyCommand stays unsupported: the gateway has no shell to hand it to", () => {
  const { hosts } = parse(`
Host target
  HostName 10.0.0.3
  ProxyCommand nc -X connect -x proxy:1080 %h %p
`);
  assert.equal(hosts[0].unsupported, "ProxyCommand");
});

test("a code host is not a machine and is skipped with the reason", () => {
  const { hosts, problems } = parse(`
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_github
`);
  assert.equal(hosts.length, 0);
  assert.equal(problems[0].alias, "github.com");
  assert.match(problems[0].reason, /logs in as "git", so it is a code host, not a machine/);
  assert.match(problems[0].where, /ssh\/config:2$/);
});

test("a key path that does not exist is reported and dropped", () => {
  const { hosts, problems } = parse(`
Host mac
  HostName 192.168.1.7
  IdentityFile ~/.ssh/missing
`, { exists: () => false });
  assert.equal(hosts[0].privateKeyPath, undefined);
  assert.equal(problems[0].alias, "mac");
  assert.match(problems[0].reason, /names a key that does not exist: \/home\/me\/\.ssh\/missing/);
});

test("a port that is not a port skips the host", () => {
  const { hosts, problems } = parse(`
Host broken
  Port 70000
`);
  assert.equal(hosts.length, 0);
  assert.equal(problems[0].alias, "broken");
  assert.match(problems[0].reason, /has port 70000, which is not a port/);
});

test("a repeated alias is listed once", () => {
  const { hosts } = parse(`
Host dup
  User one

Host dup
  User two
`);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].username, "one");
});

test("%h and %r expand in HostName and IdentityFile", () => {
  const { hosts } = parse(`
Host jump
  HostName %h.example.com
  User bob
  IdentityFile ~/.ssh/%r-key
`);
  assert.equal(hosts[0].hostName, "jump.example.com");
  assert.equal(hosts[0].privateKeyPath, "/home/me/.ssh/bob-key");
});

test("an alias becomes a device id that survives URLs and session folders", () => {
  assert.equal(deviceIdFromAlias("wsmac"), "wsmac");
  assert.equal(deviceIdFromAlias("192.168.0.25.windsing"), "192.168.0.25.windsing");
  assert.equal(deviceIdFromAlias("ib-us1-et"), "ib-us1-et");
  assert.equal(deviceIdFromAlias("my host"), "my-host");
  assert.equal(deviceIdFromAlias("-weird"), "weird");
  assert.equal(deviceIdFromAlias("***"), "host");
});

test("a discovered host turns into a device the pool can dial", () => {
  const device = sshHostToDevice({
    alias: "wsmac",
    hostName: "192.168.1.7",
    port: 22,
    username: "windsing",
    privateKeyPath: "/home/me/.ssh/wshome",
  });
  assert.deepEqual(device, {
    id: "wsmac",
    name: "wsmac",
    host: "192.168.1.7",
    port: 22,
    username: "windsing",
    mode: "active_ssh",
    privateKeyPath: "/home/me/.ssh/wshome",
  });
});

test("a block that names its address is one host, under the first alias", () => {
  // `Host ib-us2-et 10.8.8.22` with `HostName 10.8.8.22` is two ways to say
  // the same machine, so listing both showed one host twice.
  const { hosts } = parse(`
Host ib-us2-et 10.8.8.22
  HostName 10.8.8.22
  User windsing
  Port 22
`);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].alias, "ib-us2-et");
  assert.equal(hosts[0].hostName, "10.8.8.22");
});

test("without HostName each pattern is its own address", () => {
  // Two bare addresses are two machines; only a HostName says they are one.
  const { hosts } = parse(`
Host 10.0.0.1 10.0.0.2
  User deploy
`);
  assert.deepEqual(hosts.map((host) => host.alias), ["10.0.0.1", "10.0.0.2"]);
});

test("the dropped alias still resolves as a jump hop", () => {
  // `ProxyJump` may name either spelling, so the alias map keeps both.
  const { hosts } = parse(`
Host edge edge-address
  HostName 10.8.8.22

Host behind
  HostName 10.9.9.9
  ProxyJump edge-address
`);
  assert.deepEqual(hosts.map((host) => host.alias), ["edge", "behind"]);
  assert.deepEqual(hosts[1].jump.map((hop) => hop.alias), ["edge-address"]);
  assert.equal(hosts[1].jump[0].host, "10.8.8.22");
});
