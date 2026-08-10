# worker（opencode 独立进程）

Phase 4 的 worker 端：独立于 `server/`（NestJS）的 Node 进程，负责拉起真实的
`opencode serve` 子进程并代理其会话（架构决策 1B/2B）。

> 状态：**T3 V1Runtime + T4 V1Driver + T5 git 工具族/凭证注入 + T6 注册/心跳/事件上送 已完成**。
> 当前含配置加载、opencode serve 子进程管理（spawn detached/健康检查/端口探测/进程组清理）、
> V1Driver（封装 serve REST API：createSession/sendMessage/getMessages/abort/listModels，
> + step-finish 轮询完成判定 prompt-await）、git 工具族注入（`.opencode/tools/git.ts`）
> 与 GIT_SSH_COMMAND 凭证能力、启动注册（X-Worker-Token，失败指数退避重试）、定时心跳
> （顺带上报 serve 健康）、事件上送通道（seq 单调递增 + 失败重试不阻塞）、优雅退出。

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
| `X_WORKER_TOKEN` | 是 | 无 | 注册鉴权 token（对齐协议 `X-Worker-Token` header，与 server 约定一致） |
| `SERVER_URL` | 否 | `http://localhost:3000` | server 基址（nest 默认端口 3000） |
| `WORKER_ID` | 否 | `w_<hostname>` | worker 唯一 id（对齐 `RegisterWorkerPayload.workerId`） |
| `WORKER_NAME` | 否 | `<hostname>` | worker 可读名称 |
| `OPENCODE_SERVE_PORT` | 否 | `0` | opencode serve 端口；`0` = OS 随机空闲端口（T3；占用则 +1 重试） |
| `OPENCODE_SERVE_PASSWORD` | 否 | 空 | opencode serve 认证密码（Basic Auth username=opencode）；空 = 不设鉴权 |
| `HEARTBEAT_INTERVAL_MS` | 否 | `10000` | 心跳间隔 ms（server 30s=3 周期判 offline） |
| `LOG_LEVEL` | 否 | `info` | 日志级别 |
| `WORK_DIR` | 否 | `/tmp/keta-worker` | opencode serve 工作目录（T5：`.opencode/tools/` 注入落点） |
| `OPENCODE_SERVE_HOSTNAME` | 否 | `127.0.0.1` | opencode serve 绑定地址（D2：默认本地回环铁律；容器内设 `0.0.0.0` 供 server 容器访问） |
| `WORKER_ADVERTISE_HOST` | 否 | `http://127.0.0.1` | worker 对 server 公布的 serve 基址主机（D2：随注册 capabilities.baseUrl 上报；容器 compose 设 `http://worker`） |
| `GIT_SSH_KEY_PATH` | 否 | 空 | SSH 私钥路径（T5 git 凭证注入：GIT_SSH_COMMAND）；空 = 不注入 |
| `WORKER_DEFAULT_MODEL` | 否 | 空 | worker 默认模型 id（C2：随注册上报，C7 分派兜底）；空 = 未配置不上报 |
| `WORKER_EXEC_PORT` | 否 | `4198` | T10 执行端点端口（node:http POST /execute，与 serve 端口解耦） |
| `WORKER_FIRST_TOKEN_TIMEOUT_MS` | 否 | `120000` | T10 执行端点首字超时 ms（模型时限内无首字输出即 abort；首字出现后无完成超时，长期任务持续等待） |

## 目录结构

```
worker/
├── scripts/start.sh          # 部署脚本（校验 opencode → 加载 .env → 构建 → 启动）
├── src/
│   ├── index.ts              # 独立入口（T2 骨架 + T3 serve 挂载 + T4 driver 暴露 + T6 注册/心跳/优雅退出）
│   ├── config.ts             # env 配置（带默认值 + 必填校验）
│   ├── client/               # T6 注册/心跳/事件上送 HTTP 客户端
│   │   ├── registry-client.ts# registerWorker / sendHeartbeat / registerWorkerWithRetry（指数退避）
│   │   └── event-client.ts   # EventSender（seq 单调递增 + 失败重试 + flush）
│   ├── driver/               # T4 V1Driver：serve REST API 封装 + 完成判定轮询
│   │   ├── v1-driver.ts      # createSession/sendMessage/getMessages/abort/listModels/isHealthy
│   │   ├── prompt-await.ts   # awaitCompletion（step-finish 判定/超时 abort/文本聚合）+ sendAndAwait
│   │   ├── v1-driver.spec.ts
│   │   └── prompt-await.spec.ts
│   ├── git/                  # T5 git 工具族注入 + GIT_SSH_COMMAND 凭证
│   │   ├── git-tools.ts      # GIT_TOOLS 清单 + installGitTools（写 .opencode/tools/git.ts）
│   │   └── git-credentials.ts# resolveGitEnv / createTempKey / cleanup
│   ├── runtime/              # T3 V1Runtime：opencode serve 子进程管理
│   │   ├── opencode-server.ts
│   │   ├── opencode-server.spec.ts
│   │   └── opencode-server.integration.spec.ts
│   └── protocol/             # T1 双写协议类型（不 import server 代码）
│       ├── worker-protocol.ts
│       └── contract.spec.ts
├── .env.example              # 配置示例
├── package.json
└── tsconfig.json
```

## 边界约束

- **零 server 依赖**：worker 为独立进程，仅可 import `src/protocol/*`（双写类型），
  不得 import `server/` 代码、不得引入 nestjs。
- 本目录只做 worker 侧逻辑；server 侧注册/心跳/事件入口由 `server/src/workers/`（T7）负责。
