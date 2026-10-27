# 上游同步与架构维护指南 (Upstream Sync & Architecture Guide)

本项目是在官方 `@agegr/pi-web`（基于 Next.js 的 Coding Agent Web UI）基础上构建的**分布式多设备网关控制台 (Multi-Device Gateway & Distributed Pi Agent UI)**。

为了保障在上游版本发布新功能或 Bugfix 时能够**低冲突、可预测、高效率地完成合并升级**，特制定本架构抽象规范与同步指引。

---

## 一、 核心架构拓扑与防腐设计

系统采用 **“本地零污染、远端强隔离、路由轻分流”** 的防腐层（Anti-Corruption Layer）设计模式：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      前端展示与交互层 (Client UI Layer)                      │
│   DeviceSelector (设备切换器) │ DevicesConfig (设备管理面板) │ 移动端工具栏适配    │
│   通过 DeviceIdContext / prop (deviceId) 贯穿整棵 React 组件树               │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP / SSE / WS (带 ?deviceId=xxx 或 x-device-id)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                    Next.js API 路由分流层 (Facade Routes)                    │
│   app/api/agent/*, sessions/*, files/*, models/*, skills/*, mcp/*, devices/* │
│                                                                             │
│         ┌─────────────────── isRemoteDevice(deviceId)? ──────────────────┐  │
│         ▼ (No: localhost)                                                ▼ (Yes)
│   【原生上游代码】                                               【远程适配器层】
│   保持 100% 原生逻辑不变                                         lib/remote-*
└─────────┬────────────────────────────────────────────────────────────────┬──┘
          │ (本地文件与进程)                                               │ (统一 HostDriver 接口)
┌─────────▼────────────────────────────────────────────────────────────────▼──┐
│                     底层网关与 SSH 驱动层 (lib/gateway/)                     │
│  ├─ DeviceRegistry (统一设备表)  ├─ SSHClientPool (主动 SSH 连接池管理)     │
│  ├─ SSHServer (被动反向打洞 Hub) ├─ PersistentShell / ChannelRetry (通道复用)│
│  └─ SSHHostDriver (终端 PTY / SFTP / 远程 Git / pi --mode rpc 进程生命周期) │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、 改造模块的分类与归档清单

所有改动严格收敛在以下五类文件中，便于升级时区分“新文件”与“修改文件”：

### 1. 100% 独立新增模块（上游升级时 0 冲突）
* **底层网关驱动 (`lib/gateway/`)**：
  * `device-registry.ts`：设备路由表与设备生命周期事件。
  * `ssh-server.ts`：反向打洞服务端（`ssh2.Server`，默认监听 `:22222`）。
  * `ssh-client-pool.ts`：主动 SSH 客户端连接池与 KeepAlive 保活。
  * `device-config-file.ts`：`devices.json` 磁盘配置读写。
  * `drivers/ssh-host-driver.ts`：SSH PTY/SFTP/Command 执行器。
  * `drivers/persistent-shell.ts` & `channel-retry.ts`：通道重试与长连接维护。
* **远端业务适配器 (`lib/remote-*`)**：
  * `remote-agent-manager.ts`：远程 `pi --mode rpc` 进程生命周期。
  * `remote-session-store.ts`：远程 JSONL 会话读取并还原为 SessionManager。
  * `remote-files.ts`：SFTP 目录遍历、文件读写与缓存。
  * `remote-models.ts` / `remote-models-config.ts` / `remote-enabled-models.ts`：远程模型配置。
  * `remote-mcp-actions.ts` / `remote-mcp-write.ts`：远程 MCP 动态增删改。
  * `remote-skill-writes.ts`：远程 Skills 管理。
  * `remote-worktree.ts` / `remote-trust.ts`：远程 Git 与项目信任。
  * `device-context.ts`：核心契约函数（`isRemoteDevice` 等）。
* **新增独立 API 路由**：
  * `app/api/devices/route.ts` & `app/api/devices/reload/route.ts`
* **新增独立 UI 组件**：
  * `components/DevicesConfig.tsx` & `components/devices-config-helpers.ts`
  * `components/DeviceSelector.tsx`
  * `components/DeviceIdContext.tsx`

### 2. 侵入式修改文件（上游升级时需要关注合并）
* **API 路由分流入口 (`app/api/**/route.ts`)**：
  * 在各路由入口处注入 `isRemoteDevice(deviceId)` 判断，分流到 `lib/remote-*`。
* **前端骨架与状态下发**：
  * `components/AppShell.tsx`：持有 `selectedDeviceId`，并向各面板注入。
  * `hooks/useAgentSession.ts`：请求携带 `deviceId` 参数。

---

## 三、 Facade Guard（分流守卫）编码规范

为了在比对上游代码时一目了然，所有在原生路由中增加的代码必须遵循以下统一模板：

```ts
// ==================== [GATEWAY FACADE GUARD START] ====================
import { getRequestDeviceId, isRemoteDevice } from "@/lib/device-context";

const deviceId = getRequestDeviceId(req);
if (isRemoteDevice(deviceId)) {
  // 必须直接委托给 lib/remote-*，严禁在路由文件中写复杂的远程分支
  return handleRemoteSomething(deviceId, ...);
}
// ===================== [GATEWAY FACADE GUARD END] =====================

// 下方 100% 保持官方原生的本地逻辑，缩进与格式严禁变动
```

---

## 四、 上游同步标准工作流 (Upstream Sync Workflow)

### 步骤 1：配置 Upstream 远端仓库
```bash
git remote add upstream https://github.com/agegr/pi-web.git
git fetch upstream --tags
```

### 步骤 2：查看上游最新版本与差异
```bash
# 查看上游所有标签
git tag -l "v*"

# 对比当前仓库分支与上游新版本的差异文件
git diff --stat master upstream/main
```

### 步骤 3：创建同步分支并合并
```bash
git checkout -b sync/upstream-upgrade
git merge upstream/main
```

### 步骤 4：处理合并冲突（解决原则）
1. **对于 `lib/gateway/` 和 `lib/remote-*`**：直接保留本地代码（上游不存在这些文件）。
2. **对于 `app/api/*` 路由文件**：
   - 采纳上游对本地业务逻辑的更新；
   - 检查并保留顶部的 `[GATEWAY FACADE GUARD]` 分流块；
   - 确认上游如果修改了数据返回结构，相应同步适配到 `lib/remote-*` 中。
3. **对于 `components/AppShell.tsx`**：
   - 检查 `DeviceSelector` 与 `selectedDeviceId` 是否正常挂载。

---

## 五、 升级后自动化回归验收套件

合并完成后，必须依次执行以下自动化测试套件：

```bash
# 1. 静态类型检查（确保无打破类型契约）
npx tsc --noEmit

# 2. 网关配置与设备读写单元测试
node --test "test/devices-config-helpers.test.mjs"
node --test "lib/gateway/device-config-file.test.mjs"

# 3. 远程适配器单元与集成测试
node --test "lib/remote-*.test.mjs"

# 4. 上游原有单元测试全量回归
npm test

# 5. 全链路 SSH 真实联调测试 (E2E)
bun test/full-stack-remote-e2e.ts
```

---

## 六、 当前版本状态基线 (Version Baseline)

* **当前仓库基线版本**：`0.12.2`
* **上游 npm (@agegr/pi-web) 最新版本**：`0.12.2` (发布时间：2026-10-15)
* **上游 GitHub 状态**：已是最新，无未同步的稳定版本。
