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

## Topic Notes

Design decisions and traps live in `docs/agents/`, one note per area. Read every note whose files a change touches before making it. Add new notes to the area's file, not here.

- [sessions.md](docs/agents/sessions.md): AgentSession lifecycle and shutdown, fork vs in-session branching, the sidebar's on-disk Fork, session file rewrites, toolCall normalization, a run's message keys across the file read, SSE reconnect and tool events, a tool card's flat arguments as rows, transcript system / usage / context-edit entries, running-state polling, custom-message collapsing, streamed chunks re-rendering only the reply, streaming markdown block by block, hand-written anchors in rendered Markdown landing after the sanitizer's id prefix, long thinking rendered in pieces, a finished turn's duration, history caches (tool-result images, subagent runs, session views) and deferred code highlighting with Prism languages loaded on demand, a patch shown in one column or two, the session sidebar (toolbar row and its brand, project groups, their order and display names, pins, archive, new-session project adoption, the files below the sessions or in a tab), the project/worktree bar above a fresh composer (the header: brand, then the bar) and what it carries across the remount, exported HTML, the extension status bar and its `command:` buttons, cache and cost notices (`showCacheMissNotices`). Files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/session-fork*.ts`, `lib/session-delete.ts`, `lib/normalize.ts`, `lib/message-keys.ts`, `lib/session-tree.ts`, `lib/session-ui-state*.ts`, `lib/sidebar-prefs.ts`, `lib/sidebar-actions.ts`, `lib/session-links.ts`, `lib/new-session-context.ts`, `hooks/useAgentSession.ts`, `hooks/useSessionUiState.ts`, `hooks/useSidebarMotion.ts`, `hooks/useGroupDrag.ts`, `hooks/useFilesPlacement.ts`, `hooks/useResizablePanel.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/SessionSidebar.tsx`, `components/PiWebTitle.tsx`, `components/SessionTree.tsx`, `components/SidebarMenu.tsx`, `components/SidebarToast.tsx`, `components/SidebarIcons.tsx`, `components/ProjectWorktreePicker.tsx`, `components/NewSessionContextBar.tsx`, `components/WorktreeCreateForm.tsx`, `handleNewSession`, `handleSelectSession` and the bar's handlers in `components/AppShell.tsx`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `lib/message-display.ts`, `lib/patch.ts`, `components/FileViewer.tsx`, `components/MarkdownBody.tsx`, `lib/markdown.ts`, `lib/markdown-blocks.ts`, `lib/streaming-message.ts`, `hooks/useStreamingSelector.ts`, `lib/turn-duration.ts`, `components/MermaidBlock.tsx`, `lib/highlight-queue.ts`, `lib/prism-languages.ts`, `hooks/usePrismLanguages.ts`, `lib/session-view-cache.ts`, `components/CodemodeToolView.tsx`, `components/ExtensionStatusBar.tsx`, `components/ExtensionWidgets.tsx`, `lib/transcript-notices*.ts`, `components/TranscriptNotices.tsx`, `app/api/cache-miss-notices/**`, `lib/tool-fields.ts`.
- [tools.md](docs/agents/tools.md): tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md): the per-session MCP host (when servers register and connect, reported states, trust read on every sync, idle release); `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md): Settings › MCP reads without running anything, masking, the trust dialog's server list, row states, notices, Code mode choice, trust from Settings, Escape stacking, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-override.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md): Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md): Settings › MCP add (paste re-parsed on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust, the add pane) and the paste importer's escaping and grammars. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md): default model and reasoning level, providers registered at session_start, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, managed models' context-window overrides, provider auth listing and credentials, the extension-loaded runtime those routes share. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/model-runtime.ts`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-context.ts`, `lib/model-catalog-refresh.ts`, `lib/deferred-provider-models.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelContextWindow.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md): worktrees and project grouping, the file access allow-list (the `/api/files` security boundary), file tree visibility and its open directories per folder, uploads and chat file drops, the source view's languages by extension, the CSV/TSV table view, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/file-tree-expansion.ts`, `lib/file-upload-client.ts`, `lib/file-version.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/ProjectWorktreePicker.tsx`, `components/NewSessionContextBar.tsx`, `components/FileExplorer.tsx`, `lib/delimited-table.ts`, `components/DelimitedTable.tsx`, the table branch of `components/FileViewer.tsx`, `hooks/useDragDrop.ts`.
- [settings-ui.md](docs/agents/settings-ui.md): General's sidebar file-browser choice, Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks every settings panel and add pane uses. Files: `app/api/plugins/**`, `app/api/skills/**`, `lib/skills-service.ts`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`, `hooks/useFilesPlacement.ts`; also before adding a settings section or add pane.
- [subagents.md](docs/agents/subagents.md): the built-in subagent setting, profiles and their files, run status, completion notifications, the subagent viewer tab. Files: `lib/subagent*.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`, `components/SubagentViewer.tsx`, `components/subagent-viewer-state.ts`.
- [client-platform.md](docs/agents/client-platform.md): the global shortcuts (Ctrl+Alt+N on macOS's dead-key Option+N and Windows AltGr, Esc stacking), mobile software keyboard and viewport height, the terminal's extra keys, its own dark/light theme and its font size following the chat's, completion sound. Files: `hooks/useKeyboardShortcuts.ts`, `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, `components/TerminalExtraKeys.tsx`, `lib/terminal-extra-keys.ts`, `lib/terminal-theme.ts`, `hooks/useTerminalTheme.ts`, `terminalFontSize()` in `hooks/useChatAppearance.ts`, the keyboard-open CSS.

---

## Old Safari (iOS 16.2)

- `/` renders entirely on the client, so one script chunk the browser cannot parse is a blank page. Next 16 targets Safari 16.4+; the `browserslist` in `package.json` lowers Safari and iOS to 16.2 so SWC turns class `static {}` blocks into private static fields. That covers Next's client runtime; other node_modules keep their syntax unless listed in `transpilePackages` (mermaid and `@mermaid-js/parser` are, for their lazy diagram chunks). Keep the other browserslist entries at Next's defaults.
- Never write a RegExp lookbehind (`(?<=`, `(?<!`) in client code: SWC cannot downlevel it and Safari parses it only from 16.4. `lib/markdown.ts` emulates its leading lookbehinds with `replaceNotPrecededBy()`. A lookbehind built at runtime (`new RegExp("(?<=…)")` in `try`) fails only when run; that is how `lib/gfm-autolink-email-loader.cjs` fixes `mdast-util-gfm-autolink-literal`'s email regex. The loader is registered for webpack and Turbopack in `next.config.ts` and fails the build if that regex changes upstream.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext.entryIds[]` parallels `messages[]`: each displayed message's `.jsonl` entry id, used for fork and navigate_tree.

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
