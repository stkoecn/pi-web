# Pi Web 分布式网关与多机 Mesh 架构设计审计

本文档全面梳理 **当前改造版本** 与 **官方上游原版（agegr/pi-web）** 的核心差异、底层架构设计合理性评估、4 大跨机通信场景链路解析，以及双线分支管理与持续跟进上游的维护规范。

---

## 目录
1. [改造版 vs 上游原版核心差异对比](#一-改造版-vs-上游原版核心差异对比)
2. [改造版架构设计合理性评估](#二-改造版架构设计合理性评估)
3. [跨机/跨会话通信（Mesh Communication）机制深度剖析](#三-跨机跨会话通信mesh-communication机制深度剖析)
4. [双线并行（Dual-Track）分支模型与上游同步工作流](#四-双线并行dual-track分支模型与上游同步工作流)

---

## 一、 改造版 vs 上游原版核心差异对比

### 1. 定位差异
- **官方上游原版 (`@agegr/pi-web`)**：
  - 定位为本地机器上 `@earendil-works/pi-coding-agent` 的轻量级 Web 包装器（Light web wrapper）。
  - 完全假设运行在单台物理机/开发机上，直接操作本地文件系统（`~/.pi/agent/sessions/`）、本地进程与本地子代 Shell。
- **当前改造版 (`pi-web Distributed Gateway`)**：
  - 定位为 **面向多设备、跨局域网/公网的分布式 AI Agent 编排协同中枢**。
  - 保留上游 100% 的原生 Web 界面与单机体验，同时通过统一运行时（Device Runtime）与网关驱动层，将纳管设备扩展至局域网 NAS、公网 VPS、云端沙箱等异构节点，并赋予不同机器上的 AI Agent 之间相互呼叫、协作委派与结果回传的 **Mesh 通信能力**。

### 2. 核心功能对比矩阵

| 维度 | 官方上游原版 | 当前改造版 | 改造带来的价值 |
| :--- | :--- | :--- | :--- |
| **设备支持拓扑** | 仅单机 Localhost | 宿主机 + 任意多台 SSH 远端设备（如 wsnas、vps） | 统一单面板掌控多端算力与代码资产 |
| **底层调用抽象** | 散落的本地 Node.js `fs` / `child_process` / `rpc` 调用 | **`IDeviceRuntime` 统一运行时多态抽象**（Local / SSH Remote） | 解耦业务逻辑与底层物理机器，杜绝环境胶水代码蔓延 |
| **终端 Terminal** | 仅支持宿主机本地 Shell（PowerShell / bash） | 本地 Shell + 远程无缝 SSH PTY 终端（带断线重连与流控） | 随时在浏览器中直连控制远端机器 |
| **文件与 Git** | 仅支持浏览本地文件与 Git 状态 | 本地 + 远端 SFTP 文件系统与跨机器 Git Diff/Status | 在 Web 侧直接对远程机器代码做变更审查与编辑 |
| **多 Agent 协作** | 仅支持单会话内交互，或基于内置 subagent 在本机开子进程 | **全局跨会话 Mesh 路由网关**：支持任意主机、任意工程间的 Agent 相互呼叫与通信 | 形成异构分布式 Agent 协同网络（如调度中心在开发机，执行器在 NAS） |
| **模型与环境配置** | 仅读取宿主机本地 `~/.pi/agent/models.json` | 自动感知设备上下文，支持查询与配置不同机器独立的 `models.json` 与目录 | 支持为不同算力节点配置最合适的本地/云端模型 |
| **离线与弱网韧性** | 依赖外部 CDN（Google Fonts 等），弱网首屏渲染易阻塞 | 去除外部 CDN 强依赖，优化静态字体本地化；SFTP 采用并发分块与连接复用 | 适应私网、NAS、离线开发环境的高可靠运行 |

---

## 二、 改造版架构设计合理性评估

经过全链路源码审计，当前改造版的整体架构具有极高的 **内聚性** 与 **扩展性**，主要体现在以下关键设计决策上：

### 1. `IDeviceRuntime`：收敛所有设备差异的统一契约
- **设计决策**：
  没有在各个 Next.js API 路由（如 `app/api/sessions/*`、`app/api/files/*`、`app/api/cwd/*`）中编写 `if (isRemote) { ... } else { ... }` 这种容易腐化、漏改的分支代码，而是提炼出了纯净的多态接口 `IDeviceRuntime`：
  - `LocalDeviceRuntime`：包装本地 SDK 与文件系统。
  - `SshRemoteDeviceRuntime`：包装 SSH 连接池、SFTP 客户端与远端 RPC 进程。
- **架构优势**：
  上层 API 路由只需调用 `getDeviceRuntime(deviceId)`，即可一致地调用 `readSession()`、`deleteSessions()`、`createDir()`、`getModelsConfig()` 等方法。当未来新增其他协议（如 Docker、Kubernetes Pod、WebSocket Agent）时，只需实现一个新的 `IDeviceRuntime` 实现类，上层业务代码零改动。

### 2. 隔离与渐进增强原则
- 改造代码严格遵循 **“上游代码最小侵入”** 的外挂模式：
  - 核心分布式扩展统一置于 `lib/gateway/` 与 `lib/device-runtime/` 目录下。
  - 上游原生组件（如 `SessionSidebar.tsx`、`AppShell.tsx`）仅引入 `deviceId` 状态注入与透传参数，不篡改原有布局状态机。
  - 会话数据格式严格与上游保持 100% 兼容（依然使用标准 `.jsonl` 规范），保证导出的会话与本地会话在任何标准工具中均可无缝读取。

### 3. 连接池与资源防御机制
- **高并发信道隔离**：SSH 驱动内嵌 `maxSessionsPerConnection` 阈值与并发队列，防止多终端、多 Agent 并发启动时击穿远端 SSH 服务的 MaxSessions 限制。
- **本地编译铁律**：确立了“本地编译、打包部署，严禁在受限 NAS 上执行 `next build`”的工程守则，防止 NAS 内存/CPU 耗尽引发服务雪崩。

---

## 三、 跨机/跨会话通信（Mesh Communication）机制深度剖析

系统的跨会话通信能力允许用户或 Agent 通过统一地址格式进行定向交互：
- 地址格式：`[sessionId]@[project].[hostId]` 或 `@[project].[hostId]`（新建会话）

通信链路覆盖了以下四大典型场景：

### 场景 1：宿主机 $\leftrightarrow$ 宿主机（本地同机协作）
- **通信路径**：`Local Agent A` $\xrightarrow{\text{send_session_message}}$ `Mesh Router` $\rightarrow$ `Local Agent B`。
- **调度机制**：
  - 发送方调用 `send_session_message` 工具。
  - 网关 `mesh-router.ts` 检查目标地址，解析到 `localhost`。
  - 通过 `LocalDeviceRuntime` 获取目标会话。
  - 若为 `realtime` / `steer` 模式，直接注入 Agent 消息队列；若为 `followup`，排队在当前 Turn 完成后投递。
  - 接收方执行完成后的输出通过挂起的 Promise / Reply 回传给发送方的工具返回结果。

### 场景 2：宿主机 $\leftrightarrow$ 远程机器（中央调度与远程执行）
- **通信路径**：`Local Coordinator` $\rightarrow$ `Mesh Router` $\xrightarrow{\text{SSH RPC Channel}}$ `Remote Worker (wsnas)`。
- **调度机制**：
  - 网关通过 `SshRemoteDeviceRuntime` 建立与远程 `pi` 进程的双向 RPC 管道。
  - 消息帧通过标准 JSON-RPC 格式通过 SSH 管道推送至远端。
  - 远端 Agent 执行指令，并将产生的新事件通过 SSH 流实时回传。

### 场景 3：远程机器主动请求宿主机（反向通道与汇报）
- **核心难题**：远程机器（如公网 VPS 或私网 NAS）无法直接向位于 NAT 内的本地开发机发起入站 HTTP 请求。
- **解决方案：SSH Reverse Bridge + Dynamic Port Negotiation**
  1. **反向桥接**：宿主机在建立 SSH 连接时，通过 `SSHHostDriver` 执行 `client.forwardIn("127.0.0.1", port)`，将远端的 `127.0.0.1:29564`（或动态协商端口）反向绑定至宿主机的网关 HTTP 服务。
  2. **端口透传**：宿主机启动远程 `pi` 进程时，自动注入环境变量 `PI_MESH_BRIDGE_PORT`，通知远程扩展当前实际激活的反向端口。
  3. **双通道容错**：远端注入的 `mesh-agent-extension.mjs` 优先使用 HTTP 桥接快速回传；若网络震荡或端口阻断，自动降级为标准输出 `mesh_outbound` 帧，由宿主机流解析器捕获并交由 `mesh-router` 处理。
  4. **防死锁保护**：解包时强制保留 `isToolCall: true` 标记，防止返回结果被错误作为新 Prompt 投递给正在等待工具执行的会话，彻底消除 `Cannot prompt while tool execution is in progress` 死锁。

### 场景 4：远程机器 $\leftrightarrow$ 远程机器（对等协同）
- **通信路径**：`Remote Worker A (wsnas)` $\xrightarrow{\text{Reverse Bridge}}$ `宿主机 Mesh Router (Hub)` $\xrightarrow{\text{SSH RPC}}$ `Remote Worker B (vps)`。
- **调度机制**：
  - 宿主机充当星型拓扑的中央调度中心（Hub）。
  - Worker A 发送目标为 `sess@proj.vps` 的消息，通过反向桥接到达宿主机网关。
  - 网关 `mesh-router` 判定目标设备为 `vps`，路由至 `vps` 的 `SshRemoteDeviceRuntime` 进行投递。
  - 两个对等远端节点无需在物理网络上互相连通，即可实现无缝互联。

---

## 四、 双线并行（Dual-Track）分支模型与上游同步工作流

为了实现 **“100% 保持官方上游能力更新”** 与 **“安全维护自身独有增强功能”** 的长期共存，仓库确立了严格的双线并行研发模式：

### 1. 核心分支职责定义
仓库仅常驻维护两个核心主干分支：

```
 upstream/main (官方上游镜像分支)
      │
      ├── (upstream 每次发布新版本) ──> git fetch upstream
      │                                     │
      ▼                                     ▼
 [ upstream-main ] ─────────────────> [ dev ] (我们独有的增强功能/外挂主干分支)
 (纯净上游代码，不掺杂任何定制修改)          (包含 IDeviceRuntime, Mesh, 多设备网关等)
```

1. **`upstream-main` (或跟踪 `upstream/main`)**：
   - **定位**：纯净的上游官方镜像分支。
   - **准则**：严禁在此分支上提交任何自定义修改。此分支唯一的作用是拉取官方发布的代码变更。
2. **`dev`**：
   - **定位**：咱们的日常开发与生产部署工作分支（增强版 / 外挂版）。
   - **准则**：所有关于多机网关、SSH 运行时、Mesh 通信、UI 增强的独有功能均落在此分支上。

---

### 2. 标准上游同步合流流程（4 步法）

当上游官方发布了新的 Release 或重要更新时，按以下标准步骤进行同步：

#### Step 1: 获取最新上游提交
```bash
git fetch upstream --tags
```

#### Step 2: 推进本地纯净上游分支
```bash
git checkout upstream-main
git merge --ff-only upstream/main
```

#### Step 3: 将上游新特性合流至 `dev`
```bash
git checkout dev
git merge upstream-main
```

#### Step 4: 冲突处理与回归验证
- **冲突最小化准则**：
  - 由于核心逻辑集中在独立的 `lib/device-runtime/` 与 `lib/gateway/`，冲突绝大多数仅会发生在少数共享入口（如 `components/SessionSidebar.tsx`、`hooks/useAgentSession.ts`）。
  - 合并时优先保留上游的主线逻辑，仅将 `deviceId` 上下文与 `IDeviceRuntime` 调度包装在最外层。
- **强制回归验收**：
  ```bash
  # 1. 确保 TypeScript 类型系统无任何报错
  node_modules/.bin/tsc --noEmit

  # 2. 运行网关与设备运行时测试套件
  node --test lib/device-runtime/*.test.mjs
  node --test lib/gateway/*.test.mjs
  ```
- 验证通过后提交 Merge Commit，并推送到咱们的 GitHub 仓库：
  ```bash
  git push origin dev
  git push origin upstream-main
  ```
