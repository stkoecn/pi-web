# Device Runtime 抽象架构设计与上游 pi-web 异同全景对比

本文档详细记录了 `@agegr/pi-web` 在多设备分布式协同、异构宿主机与远程机治理中的全新架构设计方案——**统一设备运行时抽象层 (Unified Device Runtime Abstraction Layer)**，并深度对比与官方上游原始代码的异同点、架构动机与演进路线。

---

## 一、架构改造背景与核心痛点

### 1. 原始架构与上一代改造的困境
在官方上游的原始 `pi-web` 设计中，系统默认是一个**单机本地运行**的 Web 应用：
- 所有会话生命周期由 `lib/rpc-manager.ts` 直接通过本地进程子进程（`child_process.spawn`）拉起 `pi --mode rpc`；
- 所有文件与目录读写直接依赖 Node.js 的本地 `fs/promises`；
- 所有模型与配置直接读写本地的 `~/.pi/agent/` 与工程根目录。

在上一代支持多设备（SSH 远程机器）时，由于缺乏全局抽象，代码中大量出现了：
```ts
if (isRemoteDevice(deviceId)) {
  // 走 remote-agent-manager, 走 SSH, 走远程专用逻辑
} else {
  // 走 rpc-manager, 走本地 fs, 走本地专有逻辑
}
```
**这种模式带来了严重的架构恶果**：
1. **API 层严重臃肿分叉**：包括 `/api/agent/new`, `/api/agent/[id]`, `/api/sessions`, `/api/models`, `/api/files`, `/api/cwd/browse` 在内的数十个路由中，充斥着超过 50 处的 `isRemoteDevice` 强行分叉逻辑。
2. **生命周期与协议行为不一致**：本地 RPC 会话与远程 RPC 会话由两个独立的管理类维护，事件格式、`set_tools`/`get_tools` 响应、中断（steer）时机、会话恢复（resume）逻辑存在微小但致命的差异。
3. **网关死锁与回复丢失**：网关在处理跨设备协作（Team Mesh）时，既要管理本地的 `pendingReplies`，又要猜测远程 SSH 传回来的数据包格式（例如 `msg.data` 与顶层字段脱节、双方互锁 300 秒无法打断）。
4. **扩展性极差**：如果未来需要支持 Docker 容器设备、WSL 子系统直接连接、或者在非 SSH 协议（如 WebSocket / gRPC）下的节点，系统将彻底陷入 `if-else` 的深渊。

### 2. 重构核心思想（哲学）
- **前端与网关完全无感知执行会话的物理位置**：前端只认统一的 `sessionId` 与 `deviceId`，网关只负责基于标准地址协议的消息分发中转；
- **底层统一模型，对内差异化驱动**：在底层抽象出统一的 `IDeviceRuntime` 接口，不管是本地 Windows/Linux 宿主机，还是 SSH 连接的 Windows/Linux 远程机，对外暴露完全一致的能力契约；
- **最小化侵入，最大化继承**：保留上游现有的核心模块实现，将其作为本地驱动的内部构件，确保未来上游版本升级时可无缝合并。

---

## 二、系统架构总览 (Architecture Overview)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Frontend UI (Browser)                           │
│     (ChatWindow, SessionSidebar, ModelSelector, FileExplorer, etc.)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / SSE / WebSocket
┌───────────────────────────────────▼────────────────────────────────────┐
│                    API Gateway & Mesh Router Layer                     │
│        (Pure Forwarding, Address Resolution, Pending Match)            │
│       - app/api/agent/new, app/api/agent/[id], app/api/sessions...     │
│       - lib/gateway/mesh-router.ts (Realtime Wait & Interrupt)        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ getDeviceRuntime(deviceId)
┌───────────────────────────────────▼────────────────────────────────────┐
│                Device Runtime Registry & Manager Layer                 │
│              (Factory, Host Identity, Capability Detection)            │
└───────────────┬────────────────────────────────────────┬───────────────┘
                │                                        │
┌───────────────▼────────────────┐      ┌────────────────▼───────────────┐
│       LocalDeviceRuntime       │      │     SshRemoteDeviceRuntime     │
│  (Host: Linux / Windows 本机)  │      │  (Host: SSH 远程 Windows/Linux) │
├────────────────────────────────┤      ├────────────────────────────────┤
│ - 封装本地 Node.js 进程管理    │      │ - 封装 SSH2 Client & PTY       │
│ - 复用上游 lib/rpc-manager     │      │ - 封装 RemoteAgentManager      │
│ - 复用上游 lib/session-reader  │      │ - 封装 SFTP / 单行 Node 命令    │
│ - 本地 fs/promises 文件访问    │      │ - 封装 反向网桥 (ReverseBridge)│
│ - 本地模型与配置无缝直读       │      │ - 远程 stdout/stderr 帧解包    │
└────────────────────────────────┘      └────────────────────────────────┘
```

---

## 三、统一接口契约设计 (`IDeviceRuntime`)

统一接口在 `lib/device-runtime/types.ts` 中定义，对外暴露 5 大领域核心接口：

### 1. 会话生命周期与交互 (Session Lifecycle)
- `createSession(opts: CreateSessionOptions): Promise<SessionInitResult>`
- `resumeSession(sessionId: string, opts?: ResumeSessionOptions): Promise<IActiveSession>`
- `getActiveSession(sessionId: string): IActiveSession | undefined`
- `listSessions(opts?: ListSessionsOptions): Promise<SessionSummary[]>`
- `readSessionTranscript(sessionId: string): Promise<SessionTranscript>`
- `readSessionContext(sessionId: string): Promise<SessionContext>`
- `deleteSession(sessionId: string): Promise<void>`
- `forkSession(sessionId: string, entryId: string): Promise<SessionForkResult>`
- `setSessionTools(sessionId: string, toolNames?: string[]): Promise<SetToolsResult>`
- `getTools(sessionId?: string, cwd?: string): Promise<ToolDefinition[]>`
- `subscribeSessionEvents(sessionId: string): AsyncIterable<SessionEvent> | ReadableStream`

### 2. 消息交互与实时打断 (Messaging & Realtime Interruption)
- `sendPrompt(sessionId: string, prompt: string | object): Promise<SendResult>`
- `steerSession(sessionId: string, message: string | object): Promise<SendResult>`
- `abortSession(sessionId: string): Promise<void>`
- `deliverMeshMessage(targetSessionId: string, message: MeshMessage): Promise<DeliverResult>`

### 3. 模型与配置 (Models & Settings)
- `getAvailableModels(): Promise<AvailableModelsResult>`
- `getDefaultModel(): Promise<DefaultModelConfig>`
- `setDefaultModel(config: DefaultModelConfig): Promise<void>`
- `getEnabledModels(): Promise<string[]>`
- `setEnabledModels(models: string[]): Promise<void>`

### 4. 文件系统与终端 (Files & Terminal)
- `getHomeDir(): Promise<string>`
- `browseDir(dirPath: string): Promise<DirectoryBrowseResult>`
- `readFile(filePath: string): Promise<Buffer>`
- `writeFile(filePath: string, content: Buffer | string): Promise<void>`
- `exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult>`
- `createTerminal(opts?: TerminalOptions): Promise<TerminalSession>`

### 5. UI 状态持久化 (UI State)
- `getSessionUiState(): Promise<SessionUiState>`
- `updateSessionUiState(patch: Partial<SessionUiState>): Promise<void>`

---

## 四、与官方上游原始 pi-web 的全景异同点对比

| 维度 / 模块 | 官方上游原始 pi-web (`@agegr/pi-web`) | 本次重构后的架构实现 (Device Runtime) | 改造动机与设计收益 |
| :--- | :--- | :--- | :--- |
| **设备拓扑感知** | **纯单机视角**：所有逻辑默认运行在当前宿主机，无法感知其他设备。 | **统一抽象视角**：宿主机与多台远程机皆为 `IDeviceRuntime` 节点，平权对待。 | 打破本地单机限制，无缝融入分布式多设备协同网络。 |
| **API 路由层** | 每个路由直接调用具体的本地模块（如 `startRpcSession` / `fs.readdir`）。 | 路由层只做参数解析与委托：`const runtime = await getDeviceRuntime(deviceId); return runtime.xxx()`。 | 消灭多分支 `if (isRemote)`，API 路由代码量减少 60%，职责极度单一。 |
| **会话 RPC 管理** | 仅有 `lib/rpc-manager.ts` 管理本地子进程。 | `LocalDeviceRuntime` 代理包装 `rpc-manager`；`SshRemoteDeviceRuntime` 代理远程 RPC，接口完全同构。 | 保持对上游 `rpc-manager.ts` 零侵入，上游更新时底层核心代码可直接同步。 |
| **跨设备协同 (Mesh)** | 无此功能（仅支持单会话单任务）。 | 网关 `mesh-router.ts` 基于统一地址（`sessionId.host`）做端到端路由与打断，不关心底层传输协议。 | 彻底消灭本地与远程的死锁隐患，毫秒级多通道打断。 |
| **文件系统操作** | 直接调用 Node.js 原生 `fs`。 | 本地走 `fs`；远程走持久化 SFTP / 高性能单行跨平台 Node 管道。 | 彻底解决 Windows 与 Linux 路径斜杠、特殊字符转义及 POSIX 命令不兼容问题。 |
| **模型探测与配置** | 直接调用 `@earendil-works/pi-coding-agent` 的环境配置。 | 统一暴露 `getAvailableModels` / `getEnabledModels`，远程端通过轻量探针缓存同步。 | 远程设备只需安装 CLI，无需安装复杂 Web 依赖即可获得完整模型列表。 |

---

## 五、测试与安全性守则

1. **端口铁律**：
   - 生产/主服务进程（PID 监听 `0.0.0.0:9566`）**绝对不可动、不可杀、不可重启**；
   - 所有调试、开发与端到端验证，**统一在 `0.0.0.0:9564` 端口**运行；
2. **测试策略**：
   - 单元测试：`node --test lib/device-runtime/*.test.mjs`，确保驱动层 100% 覆盖；
   - 门面测试：验证 `getDeviceRuntime(LOCAL_DEVICE_ID)` 与 `getDeviceRuntime(remoteId)` 输出契约完全对齐；
   - 对抗测试：验证跨设备高频并发 `realtime` 消息打断、互斥锁释放与丢包自愈能力。


---

## 六、前端与浏览器端真实交互 E2E 验证与上游隐患修复

在针对 9564 端口的前端全量点击测试中（由后台 Browser QA Subagents 采用 Playwright 驱动真实 Chrome 进行自动化点击），发现了若干官方上游在多设备切换设计上的竞态缺陷，并在重构架构下进行了系统性修复：

### 1. 设备切换跨系统路径污染 (HTTP 403 Forbidden 竞态)
- **缺陷现象**：从远程 Linux 设备（`wsnas`）切换回 Windows 宿主机（`localhost`）时，浏览器控制台频繁抛出 `GET /api/git/status?cwd=/home/windsing` 和 `GET /api/files/home/windsing?type=list` 状态码 403 报错。
- **根因分析**：
  `components/SessionSidebar.tsx` 中的 `selectedCwd` 内部状态在设备 ID 变更为 `localhost` 时未主动清空，导致组件将 Linux 风格的远程路径通过属性传递给 `FileExplorer.tsx`；而 Windows 本地服务端的路径安全校验（`path-security.ts`）判定其不合法，拦截返回 403。
- **修复方案**：
  1. 在 `SessionSidebar.tsx` 的 `prevDeviceIdRef` 变化监听中，当切换为 localhost 时重置 `setSelectedCwd(null)`；
  2. 在 `FileExplorer.tsx` 发起请求前增加 `isPathCompatibleWithDevice` 防护逻辑，拦截非法路径的外溢请求。

### 2. FileViewer 远程文件 Git Diff 缺少 DeviceId
- **缺陷现象**：在远程设备（`wsnas`）下打开非本地文件时，`FileViewer` 请求 `/api/git/diff` 未携带 `deviceId` 参数，导致本地服务器使用 Windows 本地 Git 探针解析远程 Linux 路径，引发权限拒绝与报错。
- **修复方案**：在 `FileViewer.tsx` 的 `fetchGitDiff` 逻辑中透传组件已有的 `deviceId` prop。

### 3. 设置面板 (TeamConfig) DOM 嵌套规范违例
- **缺陷现象**：设置面板打开会话/Team 页签时控制台警告 `validateDOMNesting(...): <button> cannot appear as a descendant of <button>`。
- **根因分析**：`ConfigSidebarItem` 底层为 `<button>`，内部内嵌的快捷开启/关闭控件原先也使用了 `<button>`。
- **修复方案**：内层控制调整为具备无障碍与键盘支持的 `<span role="button" tabIndex={0}>`，消除 DOM 警告。

---

## 七、跨机器通信 send_session_message 双重投递（Duplicate Delivery）与自相矛盾修复

对应 `BUG_REPORT_DUPLICATE_DELIVERY.md` 中暴露的问题，在 `lib/gateway/mesh-router.ts` 和扩展引导层完成以下关键重构：

### 1. 根因剖析
- 跨主机通信中，`mode: "realtime"` 的本质是发起方挂起等待对端的同步回复；
- 此前在对端回复时，路由不仅直接用 `entry.resolve` 唤醒了等待，还在代码中未经判断地将该消息作为独立 Prompt 强行灌入对端会话，同时又在解除等待后在发起端追加了相同的 Prompt；
- 另外在 Prompt Header 模板中，`silent` 模式生成了自相矛盾的 `[Notify only, no reply required][reply by using send_session_message]:`，而 `realtime` 的同步等待设计与对端文本输出捕获存在冲突。

### 2. 修复方案
1. **被动回复短路与单次投递（Deduplication & Single Delivery）**：
   - 当 `isReplyToPending === true`（即此消息是对挂起等待的应答）时，直接 `entry.resolve(message)` 履行等待，**立即短路返回**，严禁向会话反向注入多余 Prompt；
   - 区分工具调用场景与 Fallback 场景：当通过 LLM 工具调用（`isToolCall === true`）触发时，对端答复直接包裹在 `toolResult` 内容中交付给模型，不再执行会话层二次 Prompt 灌入；
2. **彻底纠正 Prompt 模板与自相矛盾指令**：
   - 彻底移除对模型非结构化文本输出（`message_end` / `agent_end`）的脆弱劫持；
   - `silent` 模式剥离 `[reply by using send_session_message]`，固定为 `[From ${replyTarget}][mode: silent][Notification only, do NOT reply]:`；
   - `realtime` / `steer` / `followup` 清晰引导通过 `send_session_message` 工具回复，跨设备交互模型认知统一。

---

## 八、上游 v0.14.2 版本合并纪实与演进对比 (Upstream v0.14.2 Merge Record)

### 1. 合并背景与上游核心演进
本次升级将代码库从官方上游 `v0.13.0` (`fa9e1af`) 平滑同步至最新 `v0.14.2` (`5644bcf`)，包含 36 次核心提交，涉及 162 个文件（新增 6,008 行，精简 1,477 行）。上游核心演化特征包括：
1. **Side Sessions (侧聊 / 衍生会话)**：基于 ADR 0007 架构，支持通过 `/side` 命令或选中文本弹窗创建只读分支会话，在独立标签页中并行探索，不污染主会话历史；
2. **Favicon Attention Badge**：支持页面非活动/后台标签页时的动态未读与完成提醒（favicon.svg canvas 动态合成红点）；
3. **Git Changes Tree/List View**：在文件面板的文件变动区新增平铺列表与目录树双重视图切换；
4. **Scope All Models Switch**：模型选择器支持在已配置作用域模型（`enabledModels`）与全量可用模型之间平滑切换与搜索；
5. **Mobile Navigation 3-Level Stack**：设置面板与侧边栏针对移动端提供清晰的 `home` / `section` / `detail` 三级滑动导航栈；
6. **Subagent 架构收敛**：废弃了独立的 `SubagentViewer` 模态窗口，子代理统一收敛到主标签页与侧聊体系中管理。

### 2. 异同点与冲突解决设计

| 维度 / 模块 | 官方上游 v0.14.2 实现 | 本地多设备网关 (Device Runtime) 融合实现 | 决策与架构理由 |
| :--- | :--- | :--- | :--- |
| **会话与标签管理** (`AppShell.tsx`, `TabBar.tsx`) | 引入 `sideTabs` 状态数组与 `activeSideTabId`，管理主会话与衍生侧聊的分屏切换。 | 完整保留 `selectedDeviceId` 状态与双向 URL 绑定，确保在任何 Side Tab 切换、新建侧聊或关闭标签时，`deviceId` 上下文绝不丢失。 | 防止多设备并发操作时上下文混乱，侧聊继承父会话所在设备。 |
| **RPC 调度器** (`lib/rpc-manager.ts`) | 新增 `isSideChat` 识别，工具列表收敛为只读工具，`extensionUiTheme` 替换假类，`resolveActiveToolNames` 保持 CLI carry 顺序提升 prompt cache。 | 在合入上游 Side Chat 与 Theme 优化的同时，完整保留底层 `IDeviceRuntime` 派发、`resolveRemoteSession` 与 `:::mesh-reply:::` 解析。 | 既拥有上游全部最新特性与缓存加速，又保留跨设备通信能力。 |
| **文件浏览器** (`FileExplorer.tsx`, `FileViewer.tsx`) | 新增 Git 变更目录树与折行包裹设置。 | 合入 Git 变动视图的同时，严格保持所有 API 请求带上 `withDeviceId`，并在前端保留 `isPathCompatibleWithDevice` 路径安全守卫。 | 避免在跨 Windows/Linux 设备切换时因异构路径分隔符导致的 403 越权或乱码。 |
| **聊天输入与窗口** (`ChatInput.tsx`, `ChatWindow.tsx`, `MessageView.tsx`) | 新增选中文本 quote-to-side-chat 操作、SVG usage 标签对齐、粘贴恢复。 | 严格保留 Team Mesh OUT / IN 徽标、机器人对端头像及跨设备快捷选人组件。 | 保障多智能体协同交互体验与上游新交互体验双向兼容。 |
| **设置与配置面板** (`SettingsPanel.tsx`, `SettingsUi.tsx`) | 采用三级导航栈优化移动端体验。 | 保留三级导航栈的同时，保留“设备管理 (Devices)”与“Team Mesh”专属面板入口。 | 保持系统管理功能的完备性。 |

### 3. 测试验收与端口铁律验证
1. **端口守则**：全程严禁触碰或重启 9566 端口（PID 8564 持续稳定运行）；
2. **9564 验证端口**：dev server 成功在 0.0.0.0:9564 编译并运行；
3. **单元测试与集成测试**：
   - Gateway 套件：`node --test lib/gateway/*.test.mjs` **58/58 通过**；
   - Device Runtime 套件：`node --test lib/device-runtime/*.test.mjs` **26/26 通过**；
   - Side Session 套件：`node --test lib/side-session.test.mjs` **12/12 通过**；
   - AppShell 组件套件：`node --test components/AppShell.*.test.mjs` **23/23 通过**；
   - Chat/Terminal/Subagents 套件：**309/309 全部通过**；
   - TypeScript 全局检查：`tsc --noEmit` **0 错误**；
4. **远程机（wsnas）端到端测试**：
   - `test-remote-wsnas-e2e.mjs` 覆盖远程终端 SSE 通信、远程会话创建与 18 个工具解析、高并发压力测试（3 终端 + 1 会话并行），**4/4 全部通过**；
5. **Playwright 真实浏览器端到端**：
   - `verify-upstream-v0.14.2-browser.mjs` 在无头 Chrome 下完整执行 localhost 与 wsnas 设备双向切换、页面渲染与交互，控制台错误数为 0，网络 4xx/5xx 请求数为 0。

---

## 九、异构环境与跨平台部署避坑指南 (Cross-Platform Pitfalls & Resilient Patterns)

在多设备网关演进和跨系统（Windows 宿主开发机 ↔ Linux 远程 NAS/服务器）长期迭代过程中，多次暴露了以下底层陷阱。特此固化记录为标准设计模式与避坑铁律：

### 1. 打包器跨平台编译时的“常量折叠”（Constant Folding）陷阱与远程编译铁律
- **现象**：在 Windows 开发机执行 `next build` 打包后，部署到 Linux (`wsnas`) 生产环境，终端启动报错 `execvp(3) failed: No such file or directory`。
- **根因**：Next.js / Turbopack / Webpack 在构建打包时，会对静态的 `process.platform !== "win32"` 进行条件分支折叠（Constant Folding），将 Windows 机器的构建期环境当作永久运行时常量，直接移除了 Linux 的 POSIX 分支代码，导致编译出来的 JavaScript 在 Linux 上依然执行 `cmd.exe`。
- **治理规则**：
  - 严禁在跨平台运行的核心库中使用可被打包器静态折叠的字面量判断；
  - 必须采用**运行时环境探测**与动态探测：
    ```ts
    // 采用 node:os 的 platform() 并在运行时结合根路径特征，规避静态编译折叠
    import { platform } from "node:os";
    import { existsSync } from "node:fs";

    const isNonWindowsRuntime = !existsSync("C:\\") && (Boolean(process.env.SHELL) || platform() !== "win32");
    ```
- **禁止在远程生产节点（如 wsnas）进行编译（铁律）**：
  - **严禁在 wsnas 等弱算力远程生产节点上直接执行 `next build` 或 `next dev` 在线编译**！
  - 远程 NAS/边缘节点的 CPU、内存与网络（如连不上 Google Fonts）受限，不仅编译极度缓慢（动辄几分钟超时）、占用数 GB 内存引发系统卡死，还极其容易因缺少构建依赖导致产物损坏；
  - 远程节点只准部署预先在开发机/CI流水线编译好的完整生产产物，直接通过生产入口（`node bin/pi-web.js -p 9564 ...`）启动运行。

### 2. OpenSSH 跨系统（Windows ↔ Linux）命令行与环境变量语法异构
- **现象**：从 Linux 发起 SSH 连接至 Windows 机器时，后台报错 `'PI_WEB_DEVICE_ID' 不是内部或外部命令，也不是可运行的程序或批处理文件`。
- **根因**：OpenSSH 在 Windows 上的默认 Shell 通常为 `cmd.exe` 或 PowerShell，不支持 POSIX 风格的单行行内环境变量前缀语法（如 `VAR=val command`）。
- **治理规则**：
  - 在 `SSHHostDriver` 中抽象 `isWindows()` 异步探测机制（通过 `uname -s || echo %OS%` 检测）；
  - 针对 Windows 目标端，环境变量必须采用链式命令：`set "VAR=val" & set "VAR2=val2" & cd /d "<dir>" & <cmd>`；
  - 针对 Linux/POSIX 目标端，保持 `VAR=val ... <cmd>` 原生语法。

### 3. 多设备工作区隔离与路径跨端泄漏防线（Path Leak Prevention）
- **现象**：切换设备后，文件面板或终端报 `403 Access denied`。
- **根因**：用户在设备 A（Linux）打开了 `/home/user/file`，切换到设备 B（Windows 本地）时，若前端未清空或隔离工作区，旧标签页会向设备 B 的 `/api/files` 请求该 Linux 路径，触发 Windows 下的安全边界检查导致拒绝；同理，未持久化 `deviceId` 的终端也会混用本地路径。
- **治理规则**：
  - **设备切换时的工作区隔离**：`handleSelectDevice` 必须触发 `changeFileWorkspace(prevProject, nextProject)`，并在切换时重置选中的路径与会话；
  - **标签与存储的设备绑定**：终端标签（`terminalTabs`）在持久化到 `sessionStorage` 时，必须序列化 `deviceId`；
  - **路径合法性守卫**：前端在请求前通过 `isPathCompatibleWithDevice(path, deviceId)` 进行防御性阻断，API 端对跨平台非法路径提供安全回退。

### 4. 远程/后端服务重启后的会话过期自愈（Session Self-Healing）
- **现象**：服务部署升级或 NAS 重启后，浏览器刷新时终端报 `404 Terminal session not found`，页面卡死。
- **根因**：终端 PTY 属于内存驻留进程，服务重启后原有 ID 自然失效。若前端仅做简单的 `GET /api/terminal/:id` 校验，在 404 时抛出异常，会导致用户无法使用。
- **治理规则**：
  - 在 `TerminalPanel.tsx` 中实施**容错自愈策略**：当检查到旧终端 404（已过期或被后端重启回收）时，立即自动以相同的 `cwd`、`cols`、`rows` 和 `deviceId` 发起 `POST /api/terminal` 重新唤起有效 Shell，实现用户端无感刷新与自动恢复。



