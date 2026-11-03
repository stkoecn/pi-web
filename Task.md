# Team Mesh 跨会话协同与远程网关重构任务清单 (Task.md)

本文档全面梳理并记录了 `@agegr/pi-web` 在分布式多设备网关、Team Mesh 跨会话协同通信、Realtime 实时交互打断机制以及 UI 设计系统规范方面的全部改造需求、技术规范、已完成工作与待排查解决的核心要点，供后续开发人员直接无缝接手。

---

## 一、系统架构与核心概念

### 1. 拓扑与角色定位
- **网关宿主机（Gateway Host，如 `wsnas`）**：
  运行 `pi-web` 服务（Web 前端 + Next.js 后端 API + SSH Client Pool + 网关单例），负责渲染界面、管理多机 SSH 连接、维护全局会话路由与等待挂起注册表。
- **远程被控机（Remote Devices，如 `wshome` Windows 机器、`wsmac` 等）**：
  轻量化节点，只运行 `@earendil-works/pi-coding-agent` CLI（RPC 模式 `pi --mode rpc`），不运行完整的 Web 服务。通过 SSH 与宿主机双向互联。

### 2. 双向通信与返回路径
- **宿主机 -> 远程机**：通过 SSH2 Client 直接向远程 `pi --mode rpc` 标准输入发送 JSON-RPC 命令（`{ type: "prompt", ... }` / `{ type: "steer", ... }`）。
- **远程机 -> 宿主机**：
  1. **反向网桥（Mesh Reverse Bridge）**：SSH 连接建立时，宿主机在远程端口挂载反向转发：`client.forwardIn("127.0.0.1", 29564)`。远程任意进程通过 HTTP POST `http://127.0.0.1:29564` 即可穿透 NAT 和防火墙，通过已有 SSH 隧道直接调回宿主机网关路由。
  2. **RPC Outbound 帧（Fallback）**：若反向网桥未命中，远程扩展 `mesh-agent-extension.mjs` 会向 stdout/stderr 输出 `{"type": "mesh_outbound", "target": "...", "message": "...", "mode": "..."}`，宿主机的 `remote-agent-manager.ts` 捕获该帧后交由网关路由处理。

---

## 二、消息协议与 Team Mesh 规范

### 1. 严格目标与来源地址格式
- **铁律**：除了显式创建全新会话（Target 为 `@project.host`）之外，从已有会话发出的消息，发件地址与收件地址**必须永远是 `会话ID.主机名`（`sessionId.host`，例如 `01a182ed-30d4-72f7-af73-6c5deb7c4107.wsnas`）**，绝对不能退化为纯主机名（如 `wsnas`）。
- **解决丢失会话 ID 的手段**：
  - 启动远程 `pi --mode rpc` 时必须通过命令前置注入环境变量：`PI_WEB_DEVICE_ID="${deviceId}" PI_SESSION_ID="${sessionId}"`。
  - 远程扩展 `mesh-agent-extension.mjs` 必须监听 `pi.on("session_start")` 动态抓取运行时的真实 `sessionId`。
  - 网关在 `mesh-reverse-bridge.ts` 与 `mesh-router.ts` 中若检测到发件方为已知单会话设备且漏传 `sessionId`，必须自动根据当前 RPC 会话回填，不得直接截断为主机名。

### 2. 四大消息交付模式与自动 Prompt
调用 `send_session_message` 工具时支持 4 种交付模式，**默认必须为 `realtime` 模式**。网关在向目标会话投递消息时，必须在协议头部自动附加对应的语义指令：
1. **`realtime`（默认模式）**：
   - 语义：同步实时协作对话，发件方阻塞等待对端响应（上限 300s）。
   - 自动注入 Prompt：`[Waiting for a reply, please process it as soon as possible]`
   - 完整头部：`[From <sessionId>.<host>][mode: realtime][Waiting for a reply, please process it as soon as possible][reply by using send_session_message]:\n<正文>`
2. **`steer`**：
   - 语义：打断并立即介入执行，发件方不挂起等待。
   - 自动注入 Prompt：`[Please process and reply first]`
   - 完整头部：`[From <sessionId>.<host>][mode: steer][Please process and reply first][reply by using send_session_message]:\n<正文>`
3. **`followup`**：
   - 语义：排队追加任务，在当前任务完成后执行。
   - 自动注入 Prompt：`[Please process and reply after processing the previous tasks]`
   - 完整头部：`[From <sessionId>.<host>][mode: followup][Please process and reply after processing the previous tasks][reply by using send_session_message]:\n<正文>`
4. **`silent`**：
   - 语义：后台静默通知，无需打断，无需回复。
   - 自动注入 Prompt：`[Notify only, no reply required]`
   - 完整头部：`[From <sessionId>.<host>][mode: silent][Notify only, no reply required][reply by using send_session_message]:\n<正文>`

---

## 三、Realtime 模式核心交互与打断机制（关键问题与待解决要点）

### 1. 真实故障场景与排查结论
- **用户指出的致命 Bug**：
  从宿主机 `wsnas` 上的会话向远程 `wshome` 发起 realtime 会话，`wshome` 上的会话收到并返回了 `steer` 回复消息，但是 `wsnas` 机器上的发件方仍然在傻傻等待 300 秒！
- **底层导致等待无法打断的已知诱因**：
  1. **自死锁问题（Self-Match & Mutual Wait）**：
     发件方 A 在发送时在 `pendingReplies` 注册了 A 的等待。当对端 B 回复 A 时，B 也调用了 `send_session_message`（默认也是 realtime）。如果网关在检查匹配时把自己刚注册的 key 当成目标解开，或者 B 在发信后自己也陷入挂起等待 A，导致双方互锁。
     *处理原则*：如果一条消息命中了某个挂起项（`isReplyToPending = true`），发件方（B）绝不能再去挂起等 A，必须立即退出并返回已送达！
  2. **`mesh_outbound` 数据包字段解构错误**：
     在 `mesh-agent-extension.mjs` 中，`emitOutboundFrame` 封装的是 `{ type: "mesh_outbound", data: payload }`；而 `remote-agent-manager.ts` 中写的是 `if (msg?.type === "mesh_outbound" && msg.target && msg.message)`。
     因为 `msg.target` 在 `msg.data.target` 里，导致远程 SSH 返回的全部回信帧被 `remote-agent-manager.ts` 静默抛弃，网关根本没收到来自远程的回信！必须确保顶层与 `data` 都能解包。
  3. **RPC 协议 `steer` 与空闲会话冲突**：
     在 `@earendil-works/pi-coding-agent` 的规范中，`type: "steer"` 只能用于正在输出（streaming）的会话。如果会话处于空闲状态，必须发送 `{ type: "prompt", streamingBehavior: "steer" }` 才能正常唤醒并立即执行。
  4. **全方位打断监听器（Instant Interrupt Channels）**：
     Realtime 模式下，发件方的等待挂起必须具备多重毫秒级打断：
     - **通道 1（工具回信）**：对端调用 `send_session_message` 回信，命中发件方 ID 或发件方主机，立即解开；
     - **通道 2（文本输出打断）**：对端没有调工具发信，但在会话中输出了实质性文本（`message_end` 且含有 text），立即解开发件方并把文本带回；
     - **通道 3（轮次结束打断）**：对端一轮推理结束（`agent_end`），发件方立即解开，绝不傻等；
     - **通道 4（自身收信打断）**：发件方自己的会话收到了任何新的入站消息（对端送来的回复已经入库），发件方必须立即解开继续执行；
     - **通道 5（手动取消）**：前端调用 `/api/mesh/cancel`，立即解开。

### 2. 回复内容的展示方式（去内部回执化，独立消息化）
- **核心原则**：
  **Realtime 模式收到的回复（对端回答的实质性正文，非系统级错误回执），绝对不要内嵌在发送方的发信气泡肚子里！**
- **展现形态**：
  - 发送方的发信气泡只显示发件方发送的内容，不显示回复回执；
  - 收到的对端回复，必须作为一条**独立的跨会话来信消息（即下方的紫色收信卡片）**直接渲染在时间线上，自上而下形成自然对话流。

---

## 四、前端 UI 设计与时间线折叠规范

### 1. 结构完全对齐 bash 工具卡片样式
发信卡片与收信卡片在 DOM 骨架与交互上必须**100% 对齐系统原生的 `bash` 工具卡片结构**（圆角 `borderRadius: 7`，首行单行 Header，右侧 Chevron 旋转小箭头，可自由折叠/展开，展开时带有 `borderTop` 分割线）：

| 元素 | 主动发信卡片 (`MeshOutboundBubble`) | 收到来信卡片 (`MeshInboundCard`) |
| :--- | :--- | :--- |
| **外观风格** | 标准 bash 工具卡片结构 | 标准 bash 工具卡片结构 |
| **圆角边框** | `borderRadius: 7`, `border: 1px solid rgba(34,197,94,0.28)` | `borderRadius: 7`, `border: 1px solid rgba(139,92,246,0.28)` |
| **主题背景** | **生机绿（Green）** `rgba(34, 197, 94, 0.04)` | **典雅紫（Purple）** `rgba(139, 92, 246, 0.04)` |
| **图标 Avatar** | 绿色发射天线 🤖 图标 (`SendRobotIcon`) | 紫色雷达耳机 🤖 图标 (`ReceiveRobotIcon`) |
| **方向徽章** | 绿色 `[OUT ↗]` 药丸徽章 (`OutboundBadge`) | 紫色 `[IN ↙]` 药丸徽章 (`InboundBadge`) |
| **首行元数据** | `发往: <target> · <MODE>` | `来自: <sender> · <MODE>` |
| **首行操作** | 等待状态呼吸灯 / `[✕ 停止等待]` 按钮 + Chevron 折叠箭头 | 一键复制按钮 + Chevron 折叠箭头 |
| **展开内容** | 发送的消息 Markdown 正文（**无内嵌回执！**） | 接收到的消息 Markdown 正文 |

### 2. 避免发信卡片被收纳进折叠抽屉（Turn Anchor 规范）
- **问题**：在原生 `@agegr/pi-web` 中，一个 Turn 内部除了 User 消息外的所有中间过程（Thinking、Bash 工具、文件读写）都会被 `ChatWindow.tsx` 收拢折叠进抽屉（`<ProcessDetailsGroup>`）。
- **规则**：
  主动发送的跨会话消息（`send_session_message`）是一个沟通里程碑，必须被 `lib/message-display.ts` 中的 `isMessageGroupAnchor` 识别为顶级锚点（Anchor）：
  - 它前面的思考与排查过程，自动收拢折叠进上一个折叠框；
  - 发信卡片自身作为 Anchor，**100% 独立外露展现在主时间线上，外层绝不能套折叠抽屉**；
  - 它后面的计算与工具，收拢进新的折叠框。
- **底层兼容性陷阱**：
  在 `.jsonl` 历史会话持久化文件中，工具调用节点的属性可能是 `b.name`（而非 `b.toolName`），参数可能是 `b.arguments`（而非 `b.input`），ID 可能是 `tc.id`（而非 `tc.toolCallId`）。所有判断逻辑必须做双向兼容：
  `b.toolName === "send_session_message" || b.name === "send_session_message"`。

---

## 五、跨设备设置与数据持久化

### 1. 团队联络白名单（`team-mesh.json`）
- **路径**：位于具体工程目录下 `<projectCwd>/.pi/team-mesh.json`。
- **格式**：
  ```json
  {
    "version": 1,
    "enabledProjects": [
      "wsnas:/home/windsing/pi-web",
      "wshome:d:/proj/tmp"
    ]
  }
  ```
- **跨平台读写**：
  - 宿主机本地：直接使用 `fs.readFileSync` / `fs.writeFileSync`；
  - 远程主机（如 SSH 连接的 Windows/Linux）：必须通过 SSH Host Driver 执行单行 Base64 编码的 Node.js 脚本（双引号严格转义）进行异步读写，严禁使用依赖 POSIX 命令的 `cat` 或带有未转义单引号的代码，否则 Windows 会直接报错或静默失败。

### 2. 远程会话 UI 状态（置顶、归档、项目重命名）
- **文件**：位于设备用户主目录下 `~/.pi/agent/pi-web-session-state.json`。
- **关键防坑点**：
  `SessionSidebar.tsx` 中在构建远程设备的项目列表时，**绝不能把扫描出来的全部远程项目塞入 `uiState.projects` 字典**！在官方设计中，只要项目在 `projects` 字典里，就会被判定为 `pinned: true`。必须过滤只保留 `pinnedAt > 0` 的真实置顶项，否则会导致远程看到的所有项目被永久强制置顶。
- **归档与删除**：
  - 归档/置顶状态调用 `updateRemoteSessionUiState` 写回远程 JSON；
  - 会话物理删除（`lib/remote-session-delete.ts`）必须使用单行 Node.js 脚本执行 `fs.unlinkSync`，绝不能依赖 POSIX 的 `find | while read` 或 `rm -f`，否则在 Windows 远程机上会导致进程爆炸、卡死或找不到命令。

---

## 六、关键代码文件索引

| 文件路径 | 职责与关键逻辑 |
| :--- | :--- |
| `lib/gateway/mesh-router.ts` | Team Mesh 核心路由、目标解析（UUID/别名）、挂起回复注册表（`pendingReplies`）、四大模式 Prompt 注入、多通道打断。 |
| `lib/gateway/mesh-reverse-bridge.ts` | SSH 反向网桥（`forwardIn:29564`），处理远程主机发往网关的 HTTP 跨会话调用。 |
| `lib/gateway/mesh-extension.ts` | 宿主机本地内建的 `send_session_message` 与 `list_session_contact` 工具声明与执行。 |
| `lib/gateway/mesh-agent-extension.mjs` | 远程被控机通过 `-e` 载入的独立扩展脚本，提供网桥 HTTP 调用及 `mesh_outbound` 备用帧。 |
| `lib/gateway/team-mesh-config.ts` | `.pi/team-mesh.json` 项目白名单配置读写（本地同步，远程跨平台 Node 异步）。 |
| `lib/remote-agent-manager.ts` | 远程 RPC 会话管理，消费远程 stdout/stderr 中的 `mesh_outbound` 帧并分发。 |
| `lib/gateway/drivers/ssh-host-driver.ts` | SSH 驱动，执行命令与 `spawnPiRpc`，环境变量注入（`PI_WEB_DEVICE_ID`, `PI_SESSION_ID`）。 |
| `components/MessageView.tsx` | 消息气泡渲染系统，包含 `MeshOutboundBubble`（绿色发信）、`MeshInboundCard`（紫色收信）、机器人图标及 IN/OUT 徽章。 |
| `lib/message-display.ts` | 消息展示判断逻辑，`isMeshOutboundMessage` 与 `isMessageGroupAnchor`。 |
| `components/ChatWindow.tsx` | 聊天窗口时间线循环，Turn Anchor 切分与中间过程折叠。 |
| `components/TeamConfig.tsx` | 设置中的联络与团队配置面板，管理已开启/未开启项目的白名单。 |
| `app/api/mesh/send/route.ts` | 前端向后端发送 Mesh 消息的 API 入口。 |
| `app/api/mesh/cancel/route.ts` | 前端主动取消/停止 Realtime 挂起等待的 API 入口。 |

---

## 七、交接后续任务与待突破清单 (Checklist for Next Dev)

- [ ] **复现与闭环真实场景（wsnas -> wshome）**：
  在 `wsnas` 宿主机上发起指向 `wshome` 的 realtime 消息，当 `wshome` 上的会话使用 `steer` 或文字回复时，确保 `wsnas` 能够在 1 秒内立即被打断解开，绝不傻等 300 秒。
- [ ] **验证远程 `mesh_outbound` 解包链路**：
  确保在反向网桥连接不通或回退到 RPC 帧时，`remote-agent-manager.ts` 能 100% 解析 `msg.data` 或顶层 payload，不发生静默丢包。
- [ ] **验证双向回信免等逻辑**：
  对端在回信时若默认带了 realtime 模式，确保触发 `isReplyToPending` 机制，回信方立即返回成功，绝不反向陷入等待。
- [ ] **确认气泡无回执与独立收信卡片**：
  验证发送方界面上只有纯净的绿色发信卡片，对端的实质性回答在下方以单独的紫色 `[IN ↙]` 收信卡片呈现。
- [ ] **多机与本地单元测试验证**：
  确保 `node --test lib/gateway/*.test.mjs` 全部 57 项测试通过，`./node_modules/.bin/tsc --noEmit` 0 错误。
