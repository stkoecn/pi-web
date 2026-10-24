# AGENTS.md

## Dev server

Always bind the dev server to `0.0.0.0`, never `127.0.0.1` — this machine is reached
over the LAN (192.168.1.8) and Tailscale (100.74.135.43), and phones/other hosts need
to open the UI.

```bash
(NODE_OPTIONS=--max-old-space-size=4096 nohup node node_modules/next/dist/bin/next dev \
  --turbopack -H 0.0.0.0 -p 9564 > /tmp/next-server.log 2>&1 &)
```

Restart it with:

```bash
PID=$(netstat -ano | grep ":9564" | grep LISTENING | awk '{print $5}' | head -1)
powershell -Command "Stop-Process -Id $PID -Force"
```

Notes:

- Turbopack serves stale modules. After editing `lib/`, restart before trusting a curl
  result — `gateway.X is not a function` / `Export Y doesn't exist in target module`
  usually means the old build, not a broken edit.
- `next build --webpack` OOMs even at a 12 GB heap. Stay on the dev server.
- `-H 0.0.0.0` also means the reverse-tunnel SSH server binds `0.0.0.0:22222`.

## Tests

- `node --test <file>` for single suites; `node --test components/*.test.mjs` for the UI.
- `./node_modules/.bin/tsc --noEmit 2>&1 | grep -v ".next/dev/types"` for types.
- `.mjs` test files cannot contain TypeScript. Loading a `server-only` module needs
  `createJiti(import.meta.url, { tsconfigPaths: true, alias: { "server-only":
  fileURLToPath(new URL("../test/fixtures/server-only-stub.mjs", import.meta.url)) } })`.

## Files that are CRLF

`lib/mcp-config-file.ts`, `lib/plugin-updates.ts`, `app/api/worktrees/route.ts`,
`app/api/sessions/[id]/fork/route.ts`, `lib/i18n/messages/zh-TW.ts`. The `edit` tool
matches LF and will fail; use python with `io.open(..., newline='')` and literals that
carry `\r\n`. Check `'\r\n' in s` first — do not assume.

## devices.json

Git-tracked. Preserve CRLF, never write secret values inline, never add
`mode: "active_ssh"` noise. User edits to it are frequently uncommitted — stage
specific paths with `git add <file>`, never `git checkout -- devices.json` to "exclude"
them.
