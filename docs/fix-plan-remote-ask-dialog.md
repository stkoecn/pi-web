# 修复计划：远程会话的扩展对话框（ask 弹窗）丢失

> 事故报告 + 修复指南。交给执行修复的会话使用；修复完成并验证后本文件可删除。
> 事故会话：wsk40 上的 `01a1d7f5-0b4d-7784-b5c4-58101344dd6f`（通过 wsnas 网关访问，
> `http://192.168.1.200:9564/?session=…&deviceId=wsk40`），2026-11-14 16:57 CST。

## 一、事故经过与确认的事实

用户在 wsk40 的角色扮演会话中使用 `@wwyxin/pi-ask` 的 `ask` 工具（多轮问答推进剧情）。
16:48 / 16:52 / 16:54 三次 ask 都正常弹出并拿到回答；**16:57:20 的第四次 ask 之后没有
任何 toolResult**，浏览器上弹窗从未出现，回合永久卡住。

逐项取证确认：

1. **转录证据**：会话 `.jsonl` 最后一条是 16:57:20 的 `ask` toolCall，其后无 toolResult。
   此前三次 ask 均成功 — 渲染路径本身是好的。
2. **pi-ask 用的是标准 UI 方法**：`~/.pi/agent/npm/node_modules/@wwyxin/pi-ask/index.ts`
   调 `ctx.ui.select()` / `ctx.ui.input()`（pi-web 原生渲染为可点选列表）。不是第三方私有协议。
3. **设备上 pi 进程已死**：事后 `ps` 在 wsk40 上找不到任何 pi 进程；但 wsnas 网关仍在用
   **缓存的僵尸状态**报告该会话 `running / isStreaming: true`（`getRemoteRpcSessionState()`
   在设备不应答时回落缓存）。触发一次状态查询能让网关重新 resume（返回转录里最后一次的
   模型），但**几分钟后进程再次消失** — 进程在设备上反复死亡。
4. **无 OOM 记录**（dmesg 干净）；wsk40 是无持久 journal 的容器、wsnas 的用户 journal 需要
   adm 组 — 进程死因无法从日志确证。SSH 通道中断（wsk40 走 wlan0）是主要嫌疑。
5. **机制缺口（根因，见下）**：`extension_ui_request` 只在实时 SSE 上发一次，远程会话
   没有任何重放/恢复路径。浏览器事件流在该时刻恰好断了（页面息屏超过隐藏宽限期会主动
   挂起流 #1283、页面刷新、或 SSH 通道抖动 — 三者都满足当时的情形），这条帧就永久丢失。

## 二、根因：三个结构性缺口

| # | 缺口 | 证据位置 |
|---|------|----------|
| G1 | **远程会话的重连不重放挂起的扩展 UI 请求**。pi 的 `get_state` 不报告它们；远程 `connected` 帧不携带快照。帧只发一次，错过即永久丢失。 | `lib/remote-agent-manager.ts` 的 `pendingUiRequestIds` 注释（"pi's `get_state` does not report them"）；`lib/remote-event-stream.ts` 的 "Remote sessions publish no partial snapshot… a reconnecting client rebuilds from the `connected` frame" |
| G2 | **lease/awaitingInput 对远程会话无效**。`app/api/agent/[id]/lease/route.ts` 只读本地注册表（`getRpcSession`），远程会话 `alive:false` → 侧栏永远不显示"等你回答"，只有无限"运行中"转圈。 | lease 路由全文；`lib/remote-agent-manager.ts` 的 `isRemoteSessionRunning()` / `pendingUiRequestIds` 已经有现成的判断依据 |
| G3 | **僵尸状态无调和**。远端 pi 进程死亡后，网关缓存继续说 `streaming: true`，没有任何活性探测把"设备无进程"与"缓存说在跑"对齐。 | `getRemoteRpcSessionState()` 的回落缓存逻辑（"Falls back to the cached snapshot when pi does not answer in time"）；`SshRemoteDeviceRuntime.getSessionStatus()` |

## 三、修复项

### Fix 1（核心）：重放挂起的 `extension_ui_request`

**现状**：`lib/remote-agent-manager.ts` 的 `trackRemoteRunState()` 在收到
`extension_ui_request` 时只把 **id** 记进 `session.pendingUiRequestIds`（Set<string>），
**载荷被丢弃**。

**方案**：

1. `RemoteRpcSession` 增加字段：
   ```ts
   /** 挂起的扩展 UI 请求，按请求 id 存原始帧（重连重放用）。 */
   pendingUiRequests: Map<string, Record<string, unknown>>;
   ```
2. `trackRemoteRunState()` 里 `extension_ui_request` 分支：除记 id 外，把整帧
   （`{ type: "extension_ui_request", id, ...载荷 }`）存进 `pendingUiRequests`。
3. 清理时机（三处都要）：
   - `clearRemotePendingUiRequest()`（应答 `extension_ui_response` 时调用）— 同步删除载荷；
   - `agent_end` / `agent_settled` / `session_shutdown`（`trackRemoteRunState` 已有分支）— 清空整个 Map；
   - 通道 `onClose` → `removeRemoteSession()` — 随会话对象一起消失（Map 在对象上，天然满足）。
4. **重放**：`lib/remote-event-stream.ts` 的 `toRemoteEventSession()` 在 `onEvent()` 订阅建立时
   （即客户端 SSE 连上/重连的时机），把 `pendingUiRequests` 里的每一帧按原样重放给该客户端
   （放在现有首帧语义之后、普通流之前）。**去重由客户端按请求 id 完成**：
   `lib/extension-ui-queue.ts` 的队列本来就按请求 id 组织（`hooks/useAgentSession.ts` 收到
   `extension_ui_request` 后入队），已入队的 id 直接忽略即可 — 实现时确认客户端入队处有
   `if (queue.has(id)) return` 语义，没有就补上。
5. **Why not 状态读取**：也可以走 `GET /api/agent/[id]` 的 state 携带
   `pendingExtensionUiRequests`，但 SSE 重放对"页面开着、只是流断了"的场景更直接；
   两者可并存（重放为主，状态读取兜底），但先只做重放，避免 state 契约变更牵连 reconcile。

**验收**：远程会话弹出 ask → 断开浏览器流（息屏 / 杀 SSE 连接）→ 重连 → 弹窗重新出现，
可作答，`extension_ui_response` 仍按原 id 应答成功。

### Fix 2：lease/awaitingInput 对远程会话生效

**方案**：`app/api/agent/[id]/lease/route.ts` 增加 remote 分支（`isRemoteDevice(deviceId)`）：

```ts
const { getRemoteRpcSession, isRemoteSessionRunning } = await import("@/lib/remote-agent-manager");
const session = getRemoteRpcSession(id);
const alive = Boolean(session && !(session.channel as any).isClosed?.());
return NextResponse.json({
  success: true,
  running: alive && isRemoteSessionRunning(session),
  awaitingInput: alive && session.pendingUiRequestIds.size > 0,
  subagentsActive: false, // 远程子代理暂无本地快照
});
```

影响面（自查）：侧栏的"等你回答"图标、`useUserAttention` 的放开流逻辑、
`#1283` 的 hidden-page 行为 — 都消费 lease 的 `awaitingInput`。本地路径不动。

### Fix 3：僵尸状态调和

**方案（最小改动）**：`getRemoteRpcSessionState()`（`lib/remote-agent-manager.ts`）回落缓存前
做一次**短超时活性探测**：

- `requestOnChannel(channel, { type: "get_state" }, 3_000)`；
- 返回 `null`（超时）或通道已 `isClosed()` → 视为死：`closeRemoteRpcSession(sessionId)`
  （其 `onClose` 会移除会话、向客户端发 `session_shutdown`）→ 返回 `undefined`，
  让调用方（`getSessionStatus` 等）走既有的"重新 resume"路径；
- **防抖**：连续判死要计数（会话对象上记 `deadProbes`，≥2 次才真关），避免一次网络抖动
  杀掉一个健康的慢会话；恢复正常时清零。
- `requestOnChannel` 超时是静默的（resolve null），不会破坏现有调用点。

**验收**：手动在设备上 `kill` 掉 pi 进程 → 30 s 内网关侧状态查询不再返回僵尸
`streaming:true`，客户端流收到 `session_shutdown`，页面刷新后干净 resume。

### Fix 4（可选，暂缓）：ask 工具本身的持久化

pi-ask 的多选是 `ctx.ui.select()` 循环模拟，对话框丢失即回合卡死。把"挂起问题"持久化进
转录属于 pi/上游能力，**超出 pi-web 范围，本计划不做**；若上游后续支持再接。

## 四、验证清单（给修复会话）

1. **单测**（现有 vm stub 测试基建可跑）：`pendingUiRequests` 的记录、三处清理、
   重放帧与原帧逐字段一致、客户端按 id 去重。
2. **lease**：远程会话挂起对话框时 `awaitingInput: true`，应答后变 `false`；本地路径回归不变。
3. **僵尸调和**：设备 `kill` pi 进程后 ≤30 s，状态查询不再返回 `streaming:true`；单次网络抖动不误杀。
4. **手工 E2E**（wsk40 + wsnas，角色扮演会话）：发 ask → 弹窗出现 → 手机息屏 40 s+ →
   亮屏 → 弹窗仍在、可作答；重启网关（`systemctl --user restart pi-web`）→ 刷新页面 →
   若 pi 进程内仍有挂起请求（未死）则重放；进程已死则干净 resume（本计划允许丢失，
   Fix 4 才能覆盖）。
5. **回归**：本地（非设备）会话的对话框与 lease 行为不变；`npm test` 全绿
   （已知豁免：Windows junction 平台项、偶发并行干扰）。

## 五、事故现场的处理记录（已完成，供复核）

- 2026-11-14：重启了 wsnas 的 pi-web（清掉僵尸缓存）；
  会话经 API 重新 resume 成功（`isStreaming: false`，模型恢复 amd/GLM-5.3-Flash），
  用户发"继续"即可接着剧情走。丢失的那次 ask 不可恢复（pi 不重放）。
- 未修改任何代码；本文件是唯一的产物。
