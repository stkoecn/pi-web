# Pi Web Gateway & Standalone Client

轻量、高性能、解耦的 **Pi Web 设备连接网关与独立前端**。

网关作为中心节点，内部维护统一的设备路由表，同时支持：
1. **被动反向隧道 (Passive Reverse SSH Tunnel)**：无公网 IP 的边缘设备或内网服务器通过 `ssh -NR 0:localhost:22` 注册至网关；
2. **主动 SSH (Active SSH Client Pool)**：网关主动连接具有公网 IP 的远程服务器，维护多路复用长连接；
3. **本地开发模式 (Local Host Driver)**：无缝直连本地开发机环境。

网关剥离了重型 `@earendil-works/pi-coding-agent` 和 `node-pty` 原生依赖，所有计算与 Agent 运行均在目标机器就地完成（通过 SSH 管道或 `pi --mode rpc` 通信），前端可独立部署于任何 CDN 或静态服务器。

---

## 总体架构设计

```
┌─────────────────┐           ┌──────────────────────────────────────────────────┐           ┌─────────────────┐
│   Web 浏览器     │   HTTP    │                   pi-web 网关                    │   SSH     │   边缘设备 A    │
│  (前端独立部署)  │◄─────────►│  ┌───────────────┐      ┌─────────────────────┐  │ 反向隧道  │   (无公网 IP)   │
│                 │   /WS     │  │ Web / API 服务│      │     统一设备路由表    │  │◄──────────│  ssh -NR 0:...  │
│  xterm.js       │           │  │ (HTTP / WS)   │      │   (DeviceRegistry)  │  │ (Port:    │                 │
│  Agent 控制台   │           │  └───────┬───────┘      └──────────┬──────────┘  │  22222)   └─────────────────┘
│  SFTP 文件管理  │           │          │                         │             │
│  Git 状态查看   │           │          ▼                         ▼             │           ┌─────────────────┐
└─────────────────┘           │     IHostDriver 抽象        底层 SSH 连接管理     │  主动 SSH │   云服务器 B    │
                              │  (Terminal/SFTP/Git/RPC) ├─ SSHServer (Reverse)  │──────────►│   (有公网 IP)   │
                              │                          └─ SSHClientPool(Active)│           │   sshd :22      │
                              └──────────────────────────────────────────────────┘           └─────────────────┘
```

---

## 核心特性

- **纯 JS / TS 跨平台驱动**：基于 `ssh2` 实现完整的 SSH Client & SSH Server，无需编译 C++ 原生模块，全平台即开即用（支持 Bun 1.3+ 及 Node.js 22+）。
- **统一 IHostDriver 抽象**：
  - **终端 (Terminal)**：SSH PTY 会话双向管道与尺寸自动伸缩（FitAddon）。
  - **远程文件 (SFTP)**：远程目录遍历、文件在线读取与写入。
  - **版本控制 (Git)**：远程 `git status`、`git diff` 一键查询。
  - **Pi Agent 会话 (RPC)**：通过 SSH 管道对接远端 `pi --mode rpc`，全双工流式传输工具调用和响应。
- **动态端口分配与保活**：反向隧道使用 `-R 0` 动态分配内部转发端口，配合 SSH KeepAlive 与断线自动重连。
- **完全解耦与独立部署**：前端与网关支持跨域独立部署（支持标准 CORS 与 WebSocket 跨源）。

---

## 目录结构

```
D:/proj/pi-web/
├── src/
│   ├── types/
│   │   ├── device.ts             # 设备状态、连接模式与配置接口
│   │   └── host-driver.ts        # IHostDriver、TerminalSession、RPCChannel 抽象
│   ├── gateway/
│   │   ├── device-registry.ts    # 统一设备路由表与事件中心
│   │   ├── ssh-server.ts         # 被动反向隧道 Hub (ssh2.Server)
│   │   ├── ssh-client-pool.ts    # 主动 SSH 连接池与多路复用管理器
│   │   └── drivers/
│   │       ├── ssh-host-driver.ts   # 基于 SSH2/SFTP/PTY 的远程驱动实现
│   │       └── local-host-driver.ts # 本地系统直连驱动（开发与基准对比）
│   ├── server/
│   │   ├── http-api.ts           # REST API 与前端静态资源分发
│   │   ├── ws-terminal.ts        # WebSocket <-> 终端 PTY 桥接
│   │   ├── ws-agent-rpc.ts       # WebSocket <-> pi --mode rpc 桥接
│   │   └── app.ts                # 整合启动服务
│   ├── client/
│   │   ├── index.html            # 独立前端单页 (SPA)
│   │   ├── app.js                # 前端主逻辑 (xterm.js + Agent 流式输出 + SFTP)
│   │   └── style.css             # UI 样式
│   └── index.ts                  # 网关主入口
├── test/
│   └── e2e-verification.ts       # 全链路自动化端到端测试套件
├── package.json
└── tsconfig.json
```

---

## 快速上手

### 1. 运行网关服务

默认端口：
- **Web 控制台 / API**：`http://localhost:9564`
- **SSH 反向隧道接入端口**：`0.0.0.0:22222`

使用 Bun：
```bash
bun start
# 或者开发热重载
bun dev
```

使用 Node.js：
```bash
npm run start:node
```

### 2. 预设设备配置文件 (`devices.json`)

系统启动时会自动读取根目录的 `devices.json` 并发起连接与注册，支持私钥路径（自动展开 `~`）与自动断线指数退避重连：
```json
[
  {
    "id": "wsmac",
    "name": "wsmac (Mac Mini / Local)",
    "host": "192.168.1.114",
    "port": 22,
    "username": "windsing",
    "privateKeyPath": "~/.ssh/wshome"
  },
  {
    "id": "fuckip-us",
    "name": "fuckip-us (US VPS)",
    "host": "155.103.66.113",
    "port": 35683,
    "username": "root",
    "privateKeyPath": "~/.ssh/wshome"
  }
]
```

### 3. 连接设备

#### 模式 A：被动反向隧道（无公网 IP 设备）

在内网设备或边缘开发板上执行：
```bash
ssh -NR 0:localhost:22 node-device-01@<gateway-ip> -p 22222
```
网关将自动分配本地转发端口并将 `node-device-01` 注册进统一路由表。

#### 模式 B：主动 SSH 连接（公网 IP 设备）

在 Web 界面点击 **“+ 添加主动 SSH 设备”**，或通过 HTTP API 调用：
```bash
curl -X POST http://localhost:9564/api/devices/connect \
  -H "Content-Type: application/json" \
  -d '{
    "id": "vps-01",
    "name": "云服务器测试机",
    "host": "1.2.3.4",
    "port": 22,
    "username": "root",
    "password": "your-password"
  }'
```

---

## 自动化端到端验证

运行完整的 6 项全链路端到端自动化测试：

```bash
bun test
# 或
npm run test:node
```

测试覆盖内容：
1. ✅ **Device Registry & REST API**：设备注册中心与 `/api/devices` 查询。
2. ✅ **Localhost File & Exec Drivers**：文件写入、读取及命令执行一致性。
3. ✅ **Passive Reverse SSH Tunnel**：模拟 `ssh -NR` 请求建立、动态端口分配与路由表注册。
4. ✅ **Active SSH Target Connection Pool**：模拟远端 VPS 目标主机握手并执行远程命令 (`uname -a`)。
5. ✅ **WebSocket Terminal PTY**：双向交互式终端输入与回显验证。

---

## 开发与上游维护规范

为了保证本项目的独立网关架构与官方原版 `@agegr/pi-web` 的可维护性与低冲突升级，请严格遵循以下工程规范：

- 📖 **[REMOTE-DEVICE-CONTRACT.md](./REMOTE-DEVICE-CONTRACT.md)**：跨设备 API 与前端 Context 交互规范（必读）。
- 🛠️ **[UPSTREAM-SYNC-GUIDE.md](./UPSTREAM-SYNC-GUIDE.md)**：上游同步升级工作流、Facade Guard 编码规范与测试验收指南。

