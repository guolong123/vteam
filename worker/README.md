# worker — opencode 执行节点

vteam 的 worker 端：独立于 `server/`（NestJS）的 Node 进程，负责拉起真实的 `opencode serve` 子进程，代理并执行虚拟团队中 Agent 的会话。

## 职责

- **会话执行**：通过 `V1Driver` 封装 opencode serve REST API（createSession / sendMessage / getMessages / abort / listModels），`prompt-await` 以 step-finish 轮询判定完成
- **事件回流**：注册（`X-Worker-Token`）、定时心跳、事件上送（seq 单调递增 + 失败重试不阻塞），server 经 `worker-event.ingress` 消费
- **执行端点**：`node:http` 提供 `/execute`（默认 4198），首字超时 abort（`WORKER_FIRST_TOKEN_TIMEOUT_MS`），空闲判死（`instance-tracker`）
- **凭证注入**：模型凭据下发后写入 opencode auth.json；git 经 `GIT_SSH_COMMAND` 注入 SSH 私钥
- **MCP 客户端**：探测 server 的 `vteam` MCP 工具可用性（`mcp-status-probe`），注入自定义工具（`resources/custom-tool`）
- **产出物抽取**：`artifact-extract` 从会话结果中识别并上报 `submit_artifact` 产出物
- **优雅重启**：`restart-coordinator` 协调 opencode serve 重启与实例重建

## 前置条件

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | >= 18 | `node --version` 确认 |
| opencode CLI | 任意（建议 >= 1.18.15） | `command -v opencode` 确认，需在 PATH 中 |

## 安装

```bash
cd worker
npm install
```

## 构建

```bash
npm run build        # tsc 编译到 dist/
npm run typecheck    # 仅类型检查（不产出）
npm run test         # jest 契约测试
```

## 启动

方式一：部署脚本（推荐，含前置校验与 .env 加载）

```bash
cp .env.example .env   # 首次使用：填入 X_WORKER_TOKEN 等
./scripts/start.sh
```

方式二：手动

```bash
export X_WORKER_TOKEN=change-me-worker-token
npm run build
npm start              # node dist/index.js
```

开发模式（热重载）：

```bash
npm run dev            # tsx src/index.ts
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `X_WORKER_TOKEN` | 是 | 无 | 注册鉴权 token（对齐协议 `X-Worker-Token` header，与 server 的 `WORKER_TOKEN` 一致） |
| `SERVER_URL` | 否 | `http://localhost:3000` | server 基址（docker compose 内为 `http://server:3000`） |
| `WORKER_MCP_URL` | 否 | 空 | 内置 vteam MCP 地址覆盖（集群外 worker 用；覆盖 server 下发的内置地址。server 默认下发 seed 的 `PLATFORM_MCP_URL`——集群内服务名 `http://server:3000` / `http://vteam-server:3000`，集群外无法解析）；未设置 = 用 server 下发全局地址 |
| `WORKER_ID` | 否 | `w_<hostname>` | worker 唯一 id |
| `WORKER_NAME` | 否 | `<hostname>` | worker 可读名称 |
| `OPENCODE_SERVE_PORT` | 否 | `0` | opencode serve 端口；`0` = OS 随机空闲端口（占用则 +1 重试） |
| `OPENCODE_SERVE_PASSWORD` | 否 | 空 | opencode serve 认证密码（Basic Auth username=opencode）；空 = 不设鉴权 |
| `HEARTBEAT_INTERVAL_MS` | 否 | `10000` | 心跳间隔 ms（server 30s = 3 周期判 offline） |
| `LOG_LEVEL` | 否 | `info` | 日志级别 |
| `WORK_DIR` | 否 | `/tmp/keta-worker` | opencode serve 工作目录（工具注入落点） |
| `OPENCODE_SERVE_HOSTNAME` | 否 | `127.0.0.1` | opencode serve 绑定地址（容器内设 `0.0.0.0` 供 server 容器访问；**集群外/跨机 worker 必须设 `0.0.0.0`**，serve 监听非回环 server 才能连上） |
| `WORKER_ADVERTISE_HOST` | 否 | 自动探测本机非回环 IPv4（失败回退 `http://127.0.0.1`） | worker 对 server 公布的 serve 基址主机（随注册 capabilities.baseUrl 上报；compose 设 `http://worker`）。未设置时 worker 启动自动探测本机内网 IP 上报（跳过 docker/veth/br- 等虚拟网卡，探测失败才回退回环地址）。**集群外/跨机 worker 若 server 无法访问探测到的地址（多网卡/VPN 等），应显式设置为 server 可达的 worker 地址**（如 `http://<worker 局域网 IP>`），否则 server 连不上 → worker 显示不可用 |
| `GIT_SSH_KEY_PATH` | 否 | 空 | SSH 私钥路径（git 凭证注入 `GIT_SSH_COMMAND`）；空 = 不注入 |
| `WORKER_DEFAULT_MODEL` | 否 | 空 | worker 默认模型 id（随注册上报，分派兜底） |
| `WORKER_EXEC_PORT` | 否 | `4198` | 执行端点端口（node:http POST /execute，与 serve 端口解耦） |
| `WORKER_FIRST_TOKEN_TIMEOUT_MS` | 否 | `120000` | 首字超时 ms（模型时限内无首字输出即 abort；首字出现后无完成超时） |
| `WORKER_MAX_INSTANCES` | 否 | `5` | worker 最大并发会话数（随注册上报，server 按 capacity 分派）；≤0/非法值兜底 5 |

## 集群外 worker 配置（内置 MCP + 可达地址三件套）

worker 注册时上报 `capabilities.mcpUrl`（env `WORKER_MCP_URL`）与 `capabilities.baseUrl`（env
`WORKER_ADVERTISE_HOST`），server 在 worker 拉取 mcp-servers 时按 worker 覆盖内置 vteam 地址下发
（server/src/mcp-servers/mcp-servers.service.ts），并经 baseUrl 直连 worker 执行端点（exec 端点
node:http 已监听 `0.0.0.0`，无需改动）。

**集群内（compose/k8s）worker 无需配置**：server 下发的默认内置地址（seed `PLATFORM_MCP_URL`）
即集群内服务名（`http://server:3000/...` / `http://vteam-server:3000/...`），worker 可正常解析；
`WORKER_ADVERTISE_HOST` 由编排层注入（compose `http://worker` / k8s headless DNS）。

**集群外 worker 必须配置三件套**，否则内置 vteam MCP 探测 failed + server 连不上 worker
（显示不可用）：

```bash
# worker/.env
WORKER_MCP_URL=http://<控制面外部地址>/api/v1/platform-mcp   # 内置 vteam MCP 外部可达地址
WORKER_ADVERTISE_HOST=http://<worker 局域网 IP>              # server 可达的 worker 地址（baseUrl）
OPENCODE_SERVE_HOSTNAME=0.0.0.0                             # serve 监听非回环，server 才能连上
```

一键安装（install-worker.sh）可携带 `--mcp-url <url> --advertise-host <url> --serve-hostname
0.0.0.0` 写入上述值（`--advertise-host` 只填 IP 也可，脚本自动补 `http://` 前缀）；未提供时
worker 会自动探测本机非回环 IPv4 上报（探测失败才回退 `http://127.0.0.1`），脚本仅提示不强制
（本机/集群内 worker 忽略即可）。

探测到内置 MCP 失败且地址为集群内服务名时，`mcp-status-probe` 会在 worker 日志输出 WORKER_MCP_URL
引导提示；启动时未显式设置 `WORKER_ADVERTISE_HOST` 时，worker 启动日志输出上报地址提示
（自动探测成功 → 「已自动探测上报地址」引导；探测失败回退 `http://127.0.0.1` → 可达地址告警）。

## 目录结构

```
worker/
├── scripts/start.sh          # 部署脚本（校验 opencode → 加载 .env → 构建 → 启动）
├── src/
│   ├── index.ts              # 入口：serve 挂载 + 注册/心跳/事件上送 + 优雅退出
│   ├── config.ts             # env 配置（带默认值 + 必填校验）
│   ├── instance-tracker.ts   # 并发实例追踪与空闲判死
│   ├── client/               # server 侧 HTTP 客户端
│   │   ├── registry-client.ts# registerWorker / sendHeartbeat（指数退避重试）
│   │   └── event-client.ts   # EventSender（seq 单调递增 + 失败重试 + flush）
│   ├── credentials/          # model-credential-injector：模型凭据写入 auth.json
│   ├── driver/               # opencode serve REST API 封装 + 完成判定
│   │   ├── v1-driver.ts      # createSession/sendMessage/getMessages/abort/listModels/isHealthy
│   │   └── prompt-await.ts   # awaitCompletion（step-finish 判定/超时 abort/文本聚合）
│   ├── exec/                 # 执行端点 + 产出物抽取
│   │   ├── exec-server.ts    # node:http POST /execute（首字超时 abort）
│   │   └── artifact-extract.ts
│   ├── git/                  # git 工具族注入 + SSH 凭证 + 操作上报
│   │   ├── git-tools.ts / git-credentials.ts / git-credential-injector.ts / git-op-reporter.ts
│   ├── mcp-status/           # mcp-status-probe：探测 vteam MCP 可用性
│   ├── protocol/             # 双写协议类型（不 import server 代码）
│   │   └── worker-protocol.ts
│   ├── resources/            # custom-tool + injector：自定义工具注入
│   ├── restart/              # restart-coordinator：serve 重启与实例重建
│   └── runtime/              # opencode serve 子进程管理
│       └── opencode-server.ts
├── .env.example              # 配置示例（X_WORKER_TOKEN / SERVER_URL）
├── package.json
└── tsconfig.json
```

## 边界约束

- **零 server 依赖**：worker 为独立进程，仅可 import `src/protocol/*`（双写类型），不得 import `server/` 代码、不得引入 nestjs
- 本目录只做 worker 侧逻辑；server 侧注册 / 心跳 / 事件入口由 `server/src/workers/` 负责
