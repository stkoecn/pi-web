# Devices and the gateway

The gateway (`lib/gateway/`) owns every non-local machine: `devices.json` entries it dials, hosts `~/.ssh/config` offers (read-only discovery), the SSH client pool, and the per-device runtime the rest of the app asks for (`getDeviceRuntime(deviceId)` → `LocalDeviceRuntime` or `SshRemoteDeviceRuntime`, `lib/device-runtime/`). The two runtimes implement one `IDeviceRuntime` contract — sessions, tools, models, files, settings — so a panel never branches on where a machine is; the runtime does.

## Every host is dialled

The passive dial-in mode is **removed** (it was a reverse-tunnel SSH server on 0.0.0.0:22222 plus a `join` pairing flow a device ran to attach itself; deleted with `lib/gateway/ssh-server.ts`, `app/api/devices/join/`, the pairing helpers, and the `mode` field everywhere). A host the gateway serves is one of:

- A stanza in `~/.ssh/config`, offered read-only by discovery, off until the user switches it on (`lib/gateway/enabled-hosts.ts`, the `pi-web-enabled-hosts.json` switch file). Discovery never writes anything: editing belongs to ssh.
- A `devices.json` entry typed into the Settings › Devices form: id, name, **host, port, username**, key path or password, default folder. The file is validated strictly (`parseDeviceEntry()`), written atomically, and preserves its own EOL; `devices.json` is tracked by git, so key contents and passwords are never written into it (an inline key works until restart, and the API says so).

There is no `mode` field, no "dials in" group, and no `boundPort`; `DeviceInfo` carries what a dialled host has. Removing a mode is a reminder for any future connection mode: half the fields of one mode are meaningless for the other, and the split leaked into a dozen files before it was cut.

## Every panel request carries the deviceId

`getRequestDeviceId()` reads `?deviceId=` or a header; `withDeviceId(url, deviceId)` appends it. **Every request a settings panel makes must go through it** — the recurring failure of this area was a read that carried the device and a write that did not, which fell to the local branch and either refused a device path (`existsSync` → 404 "file not found", the Skills toggle; file-access → "Pi Web 无权读取此文件夹", the MCP Test) or edited this host's files instead of the device's (the Agents panel's profile writes). When a route gains a device branch, check the panel's every call, not just the one being fixed. Routes that take the device from the body (`agent/new`, MCP Test's fallback) say so in their comment; the query/header still wins.

Routes also share one refusal vocabulary (`McpRefusalReason`), so a panel cannot tell the transports apart. New device refusals reuse it; a state that is not a refusal (device offline, 503) travels as a plain error with its status code.

## Device-side probes

Anything a device must answer about itself runs **on the device**, over the same SSH channel, as a plain-JS script delivered base64 (`node -e "eval(Buffer.from('<b64>','base64').toString('utf8'))"`) with its input in a base64 env var, prefixed by `REMOTE_PATH_PREFIX` so pi's own node runtime is found. The script prints one `__PIWEB_RESULT__<json>` line; the gateway parses, masks, and shapes it. Existing probes:

- `lib/model-test-device-script.ts` — the model test: locates the device's pi build (PATH scan of the `pi` binary's realpath), writes a temp models.json, and answers one tiny chat through that build's `ModelRuntime`. The export is a **class** (`typeof` is `'function'`): probe `ModelRuntime.create`, never the type of the binding. Also never put a backtick inside those script templates — the script is a template literal; one stray backtick breaks the whole route module with a syntax error far from the cause.
- `lib/mcp-test-device-script.ts` — the MCP Test: stdio spawn or HTTP, the MCP handshake bounded like the local test, `!command` values resolved **on the device** (they are meant to run there), the process group killed at the end. The gateway masks the answer against the entry's secrets (`lib/mcp-test-remote.ts`) before a browser sees it.

Probes are best effort: no node, a dead driver — the caller degrades to what the file read already said. The same shape (probe on device, mask and shape in the gateway, one result type shared with the local path) is the template for the next capability.

## Deploying to a remote node

The build is made locally only (the 铁律 in AGENTS.md). Two lessons from the first wsk40 deploy:

- **Ship `package-lock.json` and `npm ci --omit=dev` on the remote.** The tree has `^` ranges, and a remote whose `node_modules` predates the build serves a Next version one minor behind the build — the build's chunks die on their first request with a minified `TypeError` and no stack. The lock is generated from the installed tree (`npm install --package-lock-only`) and matches it; `npm ci` reproduces it.
- **Native modules build on the target**: wsk40 is ARM, so copying a node_modules from anywhere else is wrong; `npm ci` there compiles (13 min on that box).

Service management per machine: wsnas runs the `pi-web` systemd user unit (`systemctl --user restart pi-web`, Environment carries `PI_WEB_PASSWORD` and `PI_WEB_ALLOWED_HOSTS`). wsk40 is a container **without systemd** — pi-web runs under its **supervisord** (`/etc/supervisor/conf.d/pi-web.conf`, `sudo supervisorctl status`; the unit file's `PI_WEB_PASSWORD` is where its password lives). wsk40's user has no `~/.config/systemd` bus and a nonstandard uid, so `systemctl --user` there is unusable.

After any deploy: `scripts/normalize-next-symlinks.mjs` on the node, then a real check — an unauthenticated fetch answering 307/401 is healthy, a 500 is not; log in with the node's password and count rendered `<div`s.

## Pending extension dialogs on a remote session

An extension dialog (`ask`/`select`/`input`) crosses the SSE stream once, so a client whose stream was down at that moment would never see it and the run sat parked for ever. Three closures since: `RemoteRpcSession.pendingUiRequests` keeps every unanswered blocking frame (`trackRemoteRunState()`), `toRemoteEventSession()` replays them to each client that (re)subscribes (the client's queue deduplicates by request id), and `clearRemotePendingUiRequest()` plus `agent_end`/`agent_settled` retire them. The lease route answers `awaitingInput` for a device session from the same set — the sidebar's "waiting for your answer" works remotely now. A dead device cannot fake liveness either: `getRemoteRpcSessionState()` probes the channel (3 s) before trusting its cache and closes the session on the second dead probe, which tells the clients and puts the next use on a fresh resume.
