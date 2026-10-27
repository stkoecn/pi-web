# Remote-device contract (read this before editing)

Goal: every API route and every client call must be **device-scoped**. Today the
chat path is device-blind, so switching to a remote device breaks new-session
creation and session history.

## The one rule

`deviceId` travels as `?deviceId=<id>` on the query string (EventSource cannot
set headers) **and** is accepted from the `x-device-id` header on the server.

Use the shared helpers — do not re-implement them:

```ts
import { LOCAL_DEVICE_ID, getRequestDeviceId, isRemoteDevice, withDeviceId } from "@/lib/device-context";
```

- `getRequestDeviceId(req, searchParams?)` → device id, defaults to `"localhost"`.
- `isRemoteDevice(id)` → true for any id that is not `"localhost"`.
- `withDeviceId(url, id)` → appends `deviceId` only when remote, so local URLs
  stay byte-identical.

## Remote session data

`lib/remote-session-store.ts` is the ONLY way to read remote sessions. It returns
objects shaped exactly like the local ones so the local builders are reused
verbatim:

```ts
listRemoteSessions(deviceId, { force?, deferDetails? }): Promise<SessionInfo[]>
findRemoteSessionFile(deviceId, sessionId): Promise<RemoteSessionFile | null>
openRemoteSessionManager(deviceId, sessionId): Promise<RemoteSessionManager | null>
readRemoteSessionContent(deviceId, file, { force? }): Promise<string>
invalidateRemoteSessionCache(deviceId?): void
```

`RemoteSessionManager` = `{ sm: SessionManager, filePath, sessionId, cwd, size, mtimeMs }`.
`sm` is a `SessionManager.inMemory` built from the remote JSONL, so
`sm.getEntries() / getLeafId() / getHeader() / getTree() / getSessionName()`
behave identically to a locally opened file.

**Never** build a response by hand from remote JSONL. Feed it through
`buildSessionContext`, `computeSessionStats`, `computeSessionRevision`,
`computeSessionTotalActiveMs`, `readSessionTranscriptNotices`,
`attachSessionProjectInfo`, `readSubagentSessionResources`,
`readSessionToolSelection`, `projectTreeForResponse`, `toSummaryTree` — the same
calls the local branch of `app/api/sessions/[id]/route.ts` already makes.

## Response shapes that must not change

`GET /api/sessions` →
`{ sessions: SessionInfo[], sessionListVersion, runningSessionIds, awaitingInputSessionIds, completionNotificationSuppressedSessionIds }`

`GET /api/sessions/[id]` → the `SessionData` shape consumed by
`hooks/useAgentSession.ts` `loadSession`:
`{ sessionId, filePath, info, leafId, tree, treeFormat?, snapshotRevision, context, stats, totalActiveMs, toolNames?, wrapperRebuilt? }`
where `context` has `{ messages, entryIds, oldestEntryId, hasMore, turnsBefore, model?, thinkingLevel? }`.

`GET /api/sessions/[id]/context` → `{ context, tail, before }`.

`GET /api/agent/[id]/events` (SSE) → must emit a `{type:'connected', sessionId, isStreaming, pendingExtensionUiIds}`
event first, then client-shaped events produced by `toClientAgentEvent`, with the
30 s heartbeat. Raw RPC passthrough is wrong.

## Client threading (single prop name)

The device id must reach the chat tree as a prop named **`deviceId: string`**.

- `components/AppShell.tsx` already holds `selectedDeviceId`; pass it down.
- `components/ChatWindow.tsx` accepts `deviceId` and forwards it into
  `useAgentSession({ ..., deviceId })`.
- `hooks/useAgentSession.ts` accepts `deviceId` in its options and appends it to
  every fetch/EventSource URL with `withDeviceId(...)`.
- `lib/agent-client.ts` functions take an optional trailing `deviceId` argument.

## Non-negotiables

- Do not add dependencies.
- Do not touch files outside your assignment (other agents own them).
- Keep `localhost` behaviour byte-identical: no `deviceId` on local URLs.
- Run `npx tsc --noEmit` and confirm you introduced no new errors in your files.
