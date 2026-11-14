import io

# 1. lib/side-chat-client.ts — thread deviceId through both calls.
p = 'lib/side-chat-client.ts'
s = io.open(p, encoding='utf-8', newline='').read()
edits = [
  ("""/** Fork a session into a side chat. `name` is what to call it instead of its first message's first line. */
export async function createSideChat(
  sourceSessionId: string,
  translate: (key: (typeof SIDE_REFUSAL_MESSAGES)[keyof SIDE_REFUSAL_MESSAGES]) => string,
  name?: string,
): Promise<{ session: SessionInfo } | { error: string }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sourceSessionId)}/fork`, {""",
   """/** Fork a session into a side chat. `name` is what to call it instead of its first message's first line. */
export async function createSideChat(
  sourceSessionId: string,
  translate: (key: (typeof SIDE_REFUSAL_MESSAGES)[keyof SIDE_REFUSAL_MESSAGES]) => string,
  name?: string,
  deviceId?: string,
): Promise<{ session: SessionInfo } | { error: string }> {
  const res = await fetch(withDeviceId(`/api/sessions/${encodeURIComponent(sourceSessionId)}/fork`, deviceId), {"""),
  ("""/** Delete one side chat. Answers the failure to show, or null. */
export async function deleteSideChat(sessionId: string): Promise<{ error: string } | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    cache: "no-store",
  });""",
   """/** Delete one side chat. Answers the failure to show, or null. */
export async function deleteSideChat(sessionId: string, deviceId?: string): Promise<{ error: string } | null> {
  const res = await fetch(withDeviceId(`/api/sessions/${encodeURIComponent(sessionId)}`, deviceId), {
    method: "DELETE",
    cache: "no-store",
  });"""),
]
for old, new in edits:
    assert old in s, 'MISSING: ' + old.strip().splitlines()[0][:60]
    s = s.replace(old, new, 1)
if 'withDeviceId' not in s.split('\n')[0:10].__str__():
    # add the import after the first import block
    anchor = 'import type'
    i = s.index(anchor)
    s = s[:i] + 'import { withDeviceId } from "@/lib/device-context";\n' + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('side-chat-client done')

# 2. AppShell callers pass the device.
p = 'components/AppShell.tsx'
s = io.open(p, encoding='utf-8', newline='').read()
edits2 = [
  ('const result = await createSideChat(rootSessionId, translate);',
   'const result = await createSideChat(rootSessionId, translate, undefined, selectedDeviceId);'),
  ('const result = await deleteSideChat(sessionId);',
   'const result = await deleteSideChat(sessionId, agentTabs.find((tab) => tab.sessionId === sessionId)?.deviceId ?? selectedDeviceId);'),
]
for old, new in edits2:
    assert old in s, 'MISSING: ' + old[:60]
    s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('AppShell done')

# 3. useAgentSession readIdleMessages carries the deviceId.
p = 'hooks/useAgentSession.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old3 = 'const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`);'
assert old3 in s
s = s.replace(old3, 'const res = await fetch(withDeviceId(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, deviceIdRef.current));', 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('readIdleMessages done')

# 4. AgentsConfig's model list load carries the deviceId.
p = 'components/AgentsConfig.tsx'
s = io.open(p, encoding='utf-8', newline='').read()
old4 = 'const response = await fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });'
assert old4 in s
s = s.replace(old4, 'const response = await fetch(withDeviceId(`/api/models?cwd=${encodeURIComponent(cwd)}`, deviceId), { signal: controller.signal });', 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('AgentsConfig done')
