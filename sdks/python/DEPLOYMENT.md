# vteam Worker SDK 部署与启动

本文说明如何部署 vteam worker、以及用 Python SDK 以**服务模式**或**直连模式**启动并调用它。

## 1. 组件与拓扑

| 组件 | 位置 | 作用 |
|------|------|------|
| worker | 容器镜像 `xishuhq/vteam-worker` | 拉起 `opencode serve`，执行会话；暴露执行端点（默认 `4198`） |
| SDK | `worker_sdk/`（Python ≥ 3.10，零第三方依赖） | `WorkerClient` 调执行端点；`EventsServer` 内嵌控制面；`WorkerService`/`WorkerDirect` 两种形态 |
| 控制面（可选） | SDK 内嵌 `EventsServer`，或 `scripts/worker-stub-server.py` | 接收 worker 注册/心跳/事件，回传执行结果 |

两种运行形态：

```
服务模式（SDK 即控制面）
  SDK(EventsServer:13999) ◀── 注册/心跳/事件回流 ── worker ──▶ opencode serve
  SDK ── POST /execute(202) ─────────────────────▶ worker:4198

直连模式（无控制面，worker 独立启动）
  SDK(WorkerDirect) ── POST /execute(202) / 读端点 ──▶ worker:4198
  （worker 以 WORKER_STANDALONE=true 启动，不注册/不心跳）
```

## 2. 前置条件

- Docker（部署 worker）
- Python ≥ 3.10（SDK，仅用标准库，无需 pip 安装）
- 网络：worker 能访问控制面地址（服务模式），SDK 能访问 worker 执行端点

## 3. 部署 worker

### 3.1 获取镜像

```bash
# amd64（已发布）
docker pull docker-hosted.ketaops.cc/xishuhq/vteam-worker:amd64

# 或本地构建（在 worker/ 目录）
docker build -t vteam-worker:local ./worker
```

### 3.2 服务模式（注册到控制面）

```bash
docker run -d --name vteam-worker \
  -e X_WORKER_TOKEN=dev-token \
  -e SERVER_URL=http://<控制面地址>:13999 \
  -e WORKER_ID=w_demo_1 \
  -e OPENCODE_SERVE_HOSTNAME=0.0.0.0 \
  -e OPENCODE_SERVE_PORT=4000 \
  -e WORKER_ADVERTISE_HOST=http://<server 可达的 worker 地址> \
  -e WORKER_EXEC_PORT=4198 \
  -e WORK_DIR=/data/vteam-worker \
  -p 14198:4198 \
  -v vteam_worker_data:/data/vteam-worker \
  -v worker_home:/root \
  docker-hosted.ketaops.cc/xishuhq/vteam-worker:amd64
```

worker 启动后会向 `SERVER_URL` 注册（失败指数退避重试，重试耗尽退出）。

### 3.3 独立模式（无控制面）

```bash
docker run -d --name vteam-worker-standalone \
  -e X_WORKER_TOKEN=dev-token \
  -e WORKER_STANDALONE=true \
  -e WORKER_ID=w_demo_standalone \
  -e OPENCODE_SERVE_HOSTNAME=0.0.0.0 \
  -e OPENCODE_SERVE_PORT=4100 \
  -e WORKER_EXEC_PORT=4198 \
  -e WORK_DIR=/data/vteam-worker \
  -p 14198:4198 \
  docker-hosted.ketaops.cc/xishuhq/vteam-worker:amd64
```

`WORKER_STANDALONE=true` 跳过控制面资源拉取/注册/心跳；`opencode serve` 与执行端点照常启动，无需可达的 `SERVER_URL`。

### 3.4 关键环境变量

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `X_WORKER_TOKEN` | 是 | 无 | 与 SDK/控制面一致的共享 token |
| `SERVER_URL` | 服务模式必填 | `http://localhost:3000` | 控制面基址（注册/心跳/事件） |
| `WORKER_STANDALONE` | 否 | `false` | `true` = 独立模式（跳过注册/心跳/资源拉取） |
| `WORKER_ID` | 否 | `w_<hostname>` | worker 唯一 id |
| `OPENCODE_SERVE_HOSTNAME` | 否 | `127.0.0.1` | serve 绑定地址；容器/跨机必须 `0.0.0.0` |
| `OPENCODE_SERVE_PORT` | 否 | `0`（随机） | serve 端口 |
| `WORKER_ADVERTISE_HOST` | 否 | 自动探测本机内网 IP | 上报给控制面的 serve 基址（`capabilities.baseUrl`） |
| `WORKER_EXEC_PORT` | 否 | `4198` | 执行端点端口（SDK 直连目标） |
| `WORK_DIR` | 否 | `/data/vteam-worker` | serve 工作目录 + 资源注入落点 |
| `WORKER_MAX_INSTANCES` | 否 | `5` | 并发会话上限 |
| `WORKER_FIRST_TOKEN_TIMEOUT_MS` | 否 | `300000` | 首字超时 |

数据持久化建议挂载：`/data/vteam-worker`（工作区与注入）、`/root`（`opencode.db` 会话库、`auth.json` 模型凭据）。

## 4. 启动方式 A：SDK 服务模式（SDK 即控制面）

### 4.1 库内嵌

```python
import sys; sys.path.insert(0, "<解压目录>")
from worker_sdk import WorkerService

TOKEN = "dev-token"
with WorkerService(host="0.0.0.0", port=13999, token=TOKEN) as svc:
    print("worker 应设 SERVER_URL =", svc.server_url)
    svc.wait_for_worker(timeout=60)                 # 等 worker 注册
    result = svc.execute_and_wait(
        "写一个 hello world", task_id="t-1", timeout=120, directory="/data/t-1"
    )
    print(result.output)
```

启动顺序（硬约束）：**先起 SDK 控制面 → 再起 worker（`SERVER_URL` 指向它）→ 再 `execute`**。

### 4.2 独立进程形态

```bash
python -m worker_sdk --port 13999 --token dev-token
# 输出: worker SERVER_URL=http://0.0.0.0:13999
```

worker 侧设 `SERVER_URL=http://<本机>:13999`、`X_WORKER_TOKEN=dev-token` 后启动。

## 4.3 资源与凭据下发（服务模式）

`WorkerService` 提供下发 API（`worker_id` 缺省 = 广播到全部已注册 worker）：

```python
with WorkerService(port=13999, token=TOKEN) as svc:
    svc.wait_for_worker()
    # 拉取式资源：skills / tools / mcp-servers / agent-policies
    svc.set_resources(skills=[SkillRecord(id="sk1", name="s1", content="# hi")],
                      mcp_servers=[McpServerRecord(id="ms1", name="m", type="remote", url="http://x/mcp")])
    svc.reload_config()                                    # 触发 worker 重拉 + 重注入
    # 命令式下发（心跳 commands 通道）
    svc.push_model_credentials([ModelCredentialEntry("p1", "sk-...")],
                               {"p1": ModelProviderConfigEntry("http://base/v1", ["m1"])})
    svc.push_git_credentials([GitCredentialEntry("git@host:o/r.git", "KEY", "ssh_key", "fp")])
    svc.restart()      # 远程重启
    # svc.shutdown()   # 远程下线
```

worker 侧落点（便于排障/验收）：

| 下发项 | 通道 | worker 落点 |
|--------|------|-------------|
| skills | 拉取（`GET /skills`） | `<WORK_DIR>/.opencode/skills/<name>/SKILL.md` |
| tools | 拉取（`GET /tools`） | `<WORK_DIR>/.opencode/tools/<action>.ts` |
| mcp-servers | 拉取（`GET /mcp-servers`） | `<WORK_DIR>/opencode.json` 的 `mcp` 节 |
| agent-policies | 拉取（`GET /agent-policies`） | `<WORK_DIR>/opencode.json` 的 `agent` 节 |
| model-credentials（providerKeys） | 命令 | `$HOME/.local/share/opencode/auth.json` |
| model-credentials（providerConfigs） | 命令 | `$HOME/.config/opencode/opencode.json` 的 `provider` 段 |
| git-credentials | 命令 | `$HOME/.keta-git-creds.json`（600） |

注意：模型凭据/配置变更会触发 worker 重启 serve 生效；git 凭据写盘即生效（不重启）。
下发 API 仅在 `WorkerService`（有控制面）；`WorkerDirect` 直连模式不适用。

## 5. 启动方式 B：worker 独立模式 + SDK 直连

worker 侧按 §3.3 以 `WORKER_STANDALONE=true` 启动；SDK 侧不启动任何监听：

```python
from worker_sdk import WorkerDirect

with WorkerDirect("http://127.0.0.1:14198", token="dev-token") as w:
    print(w.health())                                  # 可达性
    w.execute("写一个 hello world", task_id="t-1", directory="/data/t-1")  # 202
    print(w.list_plan_files())                         # 读端点（经 client 全量透传）
```

**限制**：直连模式无控制面，执行结果经 events 回流控制面，故 `execute_and_wait` 不可用（抛 `ServiceRequiredError`）。需要结果请用服务模式（§4）。

### 5.1 离线配置下推（`POST /config/*`，仅独立模式）

独立模式无控制面，但可直接经执行端点下推配置（无需注册/心跳）：

```bash
W=http://127.0.0.1:14198; T='X-Worker-Token: dev-token'; J='Content-Type: application/json'

# 技能 / 工具 / MCP / agent 策略（落盘 opencode 配置目录）
curl -X POST -H "$T" -H "$J" -d '{"skills":[{"name":"my-skill","content":"# My Skill\n"}]}' $W/config/skills
curl -X POST -H "$T" -H "$J" -d '{"tools":[{"action":"my-echo","execution":"cli","schema":{"x-execution":{"command":["echo"]}}}]}' $W/config/tools
curl -X POST -H "$T" -H "$J" -d '{"mcpServers":[{"name":"my-mcp","type":"remote","url":"http://mcp:8080/mcp"}]}' $W/config/mcp-servers
curl -X POST -H "$T" -H "$J" -d '{"agents":[{"name":"my-agent","description":"d","mode":"primary","permission":{"edit":"allow"}}]}' $W/config/agent-policies

# 模型凭据 / git 凭据
curl -X POST -H "$T" -H "$J" -d '{"providerKeys":[{"providerID":"p1","key":"sk-..."}],"providerConfigs":{"p1":{"baseUrl":"http://llm/v1","models":["m1"]}}}' $W/config/model-credentials
curl -X POST -H "$T" -H "$J" -d '{"credentials":[{"repoUrl":"git@host:o/r.git","key":"KEY","authType":"ssh_key"}]}' $W/config/git-credentials

# 写后生效（技能/工具/mcp/agent/模型需重启 serve；git 凭据写盘即生效）
curl -X POST -H "$T" $W/config/restart
```

语义与约束：

| 项 | 说明 |
|----|------|
| 语义 | **声明式替换**：每类资源本次请求即完整集合（传空数组清空） |
| 响应 | `{"written":{...},"restart":"required"\|"not-required"}`（不自动重启） |
| 校验（非法 400） | 技能名仅字母数字开头（防路径穿越）；工具需 `execution` + `x-execution`；agent 需 `description`、`mode ∈ {primary,all}`、`permission` 禁 `write`；mcp `type ∈ {local,remote}` |
| 鉴权 | 必须 `X-Worker-Token`；注册模式下这些路径返回 **404 + 引导** |
| 安全 | 会写入明文凭据（auth.json / git-creds）；执行端点绑 `0.0.0.0`，须网络隔离或仅内网可达 |

落点：`<WORK_DIR>/.opencode/skills|tools`、`<WORK_DIR>/opencode.json`（mcp/agent 节）、
`$HOME/.local/share/opencode/auth.json`、`$HOME/.config/opencode/opencode.json`（provider 段）、`$HOME/.keta-git-creds.json`。

## 6. 可选：独立 stub 控制面进程

```bash
python3 scripts/worker-stub-server.py --port 3000 --token change-me-worker-token
# worker 侧: SERVER_URL=http://<本机>:3000  X_WORKER_TOKEN=change-me-worker-token
```

协议与 SDK 内嵌 `EventsServer` 一致，二者可互换。

## 7. 端口与鉴权

| 通道 | 端口 | 鉴权 |
|------|------|------|
| worker 执行端点 `POST /execute` | `WORKER_EXEC_PORT`（4198） | ❌ 无（fire-and-forget） |
| worker 读/写端点（`/file` `/agents` `/todos` `/plan-*` `/omo-*` `/question-reply`） | 同上 | ✅ `X-Worker-Token` |
| 控制面 register/heartbeat/events | 控制面端口（如 13999） | ✅ 共享 token |

**三方 token 必须一致**：worker `X_WORKER_TOKEN` = SDK `token` = 控制面 token。

## 8. 快速验证

```bash
# 1) 执行端点存活（202）
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"prompt":"ping","taskId":"t1","directory":"/data/t1"}' \
  http://127.0.0.1:14198/execute

# 2) SDK 直连模式示例
cd <解压目录> && python3 examples/direct_client.py http://127.0.0.1:14198

# 3) SDK 服务模式示例（需 worker 注册到 EventsServer）
cd <解压目录> && python3 examples/basic_usage.py
```

## 9. 常见问题

- **结果拿不到**：`/execute` 只回 202，结果必经 events 通道；直连模式无控制面，需改用服务模式。
- **worker 起不来（服务模式）**：确认 `SERVER_URL` 可达且 token 一致；注册失败重试耗尽会退出。
- **独立模式读端点较慢**：`/agents`、`/omo-config` 依赖 `opencode serve`，预热期可能较慢；磁盘型端点（`/plan-files`、`/plan-file`、`/execute`）即时返回。
- **amd64 交叉构建**：在 arm64 宿主上经 QEMU 构建 amd64 时，Bun（OmO 安装器）会 abort；镜像 Dockerfile 已内置兜底（直接落盘等价插件注册），无需额外处理。
- **端口占用**：`OPENCODE_SERVE_PORT=0` 让 OS 分配随机端口（容器内建议固定，便于排障）。
