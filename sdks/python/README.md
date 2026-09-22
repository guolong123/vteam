# vteam Worker Python SDK

第三方服务用 Python 调用 vteam worker 执行任务的轻量 SDK。**零第三方依赖**（仅标准库），Python ≥ 3.10。

> worker 全部 HTTP 接口速查（执行端点 / `/config/*` 本地配置下推 / 控制面契约）：见
> [`WORKER_API.md`](WORKER_API.md)。

## 架构

```
┌──────────────────┐   POST /execute (202)    ┌─────────────────┐
│  你的第三方服务    │ ───────────────────────▶ │  Worker :4198   │
│                  │                          │  (opencode)     │
│  WorkerClient    │   ← 无鉴权、fire-forget   └────────┬────────┘
│  EventsServer ◀──┼──── events 回流（你的控制面） ◀─────┘
└──────────────────┘
```

- **WorkerClient**：调用 worker 执行端点（10 个端点）。
- **EventsServer**：内嵌一个最小控制面（register / heartbeat / events）。把 worker 的
  `SERVER_URL` 指到它，worker 就能独立注册并把执行结果推回来；SDK 内 `wait_for_task`
  阻塞等待 `task.completed`。
- **WorkerService**：服务形态——`start()` 后打印 `server_url`，worker 用它注册；
  `wait_for_worker` / 自动发现执行端点 / `execute_and_wait` 一站式。也可独立进程：
  `python -m worker_sdk --port 13999 --token dev-token`。
- **WorkerDirect**：客户端直连模式（**非服务模式**）——不启动内嵌控制面、不监听端口，
  直接连 worker 执行端点（适配 `WORKER_STANDALONE=true` 独立 worker）。可用 `/execute`
  提交 + 全部读端点；**无控制面故无法等待结果**（`execute_and_wait` 抛
  `ServiceRequiredError`，需要结果请用 `WorkerService`）。
- **execute_and_wait**：提交 + 等结果的一站式封装。

**启动顺序（硬约束）**：WorkerService/EventsServer → worker（`SERVER_URL` 指向它）→ 再 `execute`。
SDK 本身模拟 server，**不依赖**真实 vteam server。

## 安装

无需安装，把 `worker_sdk/` 拷进项目或加 `sys.path`：

```python
import sys
sys.path.insert(0, "/path/to/vteam/sdks/python")
from worker_sdk import WorkerClient, EventsServer, execute_and_wait
```

## 快速开始

### 方式 A：WorkerService（推荐，SDK 即控制面）

```python
from worker_sdk import WorkerService

TOKEN = "dev-token"
with WorkerService(port=13999, token=TOKEN) as svc:
    print("worker 应设 SERVER_URL=", svc.server_url)
    # worker 侧: SERVER_URL=<svc.server_url> X_WORKER_TOKEN=dev-token 后再启动
    svc.wait_for_worker(timeout=60)
    result = svc.execute_and_wait(
        "写一个 hello world",
        task_id="my-task-1",
        timeout=120,
        directory="/data/my-task",
    )
    print(result.output)
```

独立进程形态（模拟 server 长期在线）：

```bash
python -m worker_sdk --port 13999 --token dev-token
# 输出: worker SERVER_URL=http://0.0.0.0:13999
```

### 方式 B：直接用 EventsServer

#### 1. 让 worker 指向你的 EventsServer

worker 侧环境（与你启动 EventsServer 时的 token 一致）：

```bash
export SERVER_URL=http://<你的机器>:13999
export X_WORKER_TOKEN=dev-token
# 然后正常启动 worker
```

### 2. 提交任务并等待结果（EventsServer 底层用法）

```python
from worker_sdk import EventsServer, WorkerClient, execute_and_wait

TOKEN = "dev-token"

with EventsServer(port=13999, token=TOKEN) as events:
    client = WorkerClient("http://worker-host:4198", token=TOKEN)

    result = execute_and_wait(
        client,
        events,
        prompt="写一个 hello world",
        task_id="my-task-1",          # 结果按 payload.taskId 匹配
        timeout=120,
        directory="/data/my-task",    # 可选：工作目录
    )
    print(result.output, result.session_id, result.payload)
```

### 3. 只提交、稍后取结果（解耦）

```python
client.execute("总结这份文档", task_id="t-2", directory="/data/doc")

# ... 干别的事 ...

result = events.wait_for_task("t-2", timeout=60)
# 或按 session / 任意谓词
# events.wait_for_session_completed("ses_xxx")
# events.wait_for_event(lambda e: e.type == "session.question")
```

## API 速览

### WorkerDirect(worker_url, *, token=None, timeout=30)

客户端直连模式（非服务模式）：不启动内嵌控制面、不监听端口，直接连 worker 执行端点。

```python
from worker_sdk import WorkerDirect, ServiceRequiredError

with WorkerDirect("http://127.0.0.1:4198", token="dev-token") as worker:
    print(worker.health())                       # True/False
    worker.execute("写一个 hello world", task_id="t-1", directory="/data/t-1")  # 202
    print(worker.list_agents(), worker.get_omo_config())
    # 结果需控制面：worker.execute_and_wait(...) → ServiceRequiredError
```

| 成员 | 说明 |
|------|------|
| `client` | 底层 `WorkerClient`（全部 10 个端点均经它访问） |
| `base_url` | worker 执行端点基址 |
| `execute(prompt, **kwargs)` | POST /execute（202 fire-and-forget） |
| `health()` | 探测 worker 执行端点可达性 |
| `execute_and_wait(...)` | 直连模式不可用，抛 `ServiceRequiredError` |

适用场景：worker 以 `WORKER_STANDALONE=true` 独立启动（不注册/心跳），第三方服务只需
提交/查询，不需要 SDK 监听端口。需要同步拿结果时改用 `WorkerService`。

### WorkerClient(base_url, token=None, timeout=30)

| 方法 | 端点 | 鉴权 | 说明 |
|------|------|------|------|
| `execute(prompt, ...)` | POST /execute | ❌ | 202 即返；结果走 events |
| `question_reply(...)` | POST /question-reply | ✅ | 回复模型 question |
| `permission_reply(...)` | POST /question-reply | ✅ | 权限 once/always/reject |
| `get_file(path)` | GET /file | ✅ | 拉文件（≤10MB，bytes） |
| `list_agents(directory)` | GET /agents | ✅ | agent 列表（失败 `[]`） |
| `list_todos(session_id)` | GET /todos | ✅ | todo 步骤（失败 `[]`） |
| `list_plan_files(directory)` | GET /plan-files | ✅ | 计划文件（失败 `[]`） |
| `write_plan_file(name, content)` | POST /plan-file | ✅ | 写计划文件 |
| `get_omo_config()` / `set_omo_config(...)` | GET/POST /omo-config | ✅ | OmO 配置 |
| `get_omo_agent_prompt(name)` | GET /omo-agent-prompt | ✅ | agent 提示词全文 |

`execute` 关键参数：`prompt`、`model=ModelRef(...)`、`agent`、`directory`、`system`、
`task_id`、`session_id`（复用会话）、`execution_config`、`attachments`。

### EventsServer(host, port, *, token)

| 成员 | 说明 |
|------|------|
| `start()` / `stop()` / 上下文管理器 | 启停内嵌 HTTP |
| `base_url` / `port` | 实际监听地址 |
| `wait_for_task(task_id, timeout)` | 阻塞等 `task.completed` → `TaskResult` |
| `wait_for_session_completed(session_id, timeout)` | 按 session 等完成 |
| `wait_for_event(predicate, timeout)` | 通用谓词等待 |
| `events_for(task_id=None, type=None)` | 查询已收事件 |
| `registered_workers()` | 已注册 worker 列表 |
| `push_command(worker_id, cmd, *, resource_version=None)` | 塞下行命令（reload-config / model-credentials / git-credentials / restart / shutdown） |
| `set_resources(skills=, tools=, mcp_servers=, agent_policies=, replace_all=False)` | 动态更新资源 fixture（None = 该类别不变） |

EventsServer 同时实现了资源拉取空端点（skills/tools/mcp-servers/agent-policies），
worker 启动期 `injectAll` 不会报错；构造时传 `resources={...}` 可下发 fixture 落盘。

### WorkerService(host, port, *, token, ...)

| 成员 | 说明 |
|------|------|
| `start()` / `stop()` / 上下文管理器 | 启停内嵌 EventsServer |
| `server_url` / `base_url` / `port` | 给 worker 的 `SERVER_URL` |
| `wait_for_worker(timeout)` | 阻塞直到注册成功 |
| `resolve_exec_url()` | 按 capabilities.baseUrl+execPort 发现执行端点 |
| `client(base_url=None)` | 获取/缓存 WorkerClient |
| `execute_and_wait(prompt, *, task_id, ...)` | 等注册 → 提交 → 等结果 |
| `events` | 底层 EventsServer（wait_for_task 等） |

独立进程：`python -m worker_sdk --port 13999 --token <tok> [--worker-exec-url URL]`

### 资源与命令下发（WorkerService）

| 方法 | 说明 |
|------|------|
| `set_resources(skills=, tools=, mcp_servers=, agent_policies=, replace_all=False)` | 更新资源 fixture（拉取式）；随后 `reload_config()` 让 worker 重拉落盘 |
| `reload_config(worker_id=None)` | 触发 worker 重拉资源 + 重注入（无活跃会话时重启 serve 生效） |
| `push_model_credentials(provider_keys, provider_configs=None, worker_id=None)` | 模型凭据/配置下发 → worker 写 `auth.json` + `opencode.json` provider 段 |
| `push_git_credentials(credentials, worker_id=None)` | git 凭据下发 → worker 写 `$HOME/.keta-git-creds.json` |
| `restart(worker_id=None)` / `shutdown(worker_id=None)` | 远程重启 / 优雅下线 |
| `push_command(cmd, worker_id=None, resource_version=None)` | 通用下行命令（上述方法的底层，返回目标 workerId 列表） |

`worker_id` 缺省 = 广播到全部已注册 worker（无注册则抛 `WorkerNotRegisteredError`）。
元素可传 dataclass（`SkillRecord`/`ToolRecord`/`McpServerRecord`/`AgentPolicyRecord`/
`ModelCredentialEntry`/`ModelProviderConfigEntry`/`GitCredentialEntry`）或等价 dict。
`AgentPolicyRecord` 需 `description`，`mode ∈ {'primary','all'}`，`permission` 禁 `write` 键（SDK 构造时即校验）。

```python
with WorkerService(port=13999, token=TOKEN) as svc:
    svc.wait_for_worker()
    svc.set_resources(
        skills=[SkillRecord(id="sk1", name="s1", content="# hi")],
        mcp_servers=[McpServerRecord(id="ms1", name="m", type="remote", url="http://x/mcp")],
    )
    svc.reload_config()
    svc.push_model_credentials(
        [ModelCredentialEntry("p1", "sk-...")],
        {"p1": ModelProviderConfigEntry("http://base/v1", ["m1"])},
    )
    svc.push_git_credentials([GitCredentialEntry("git@host:o/r.git", "KEY", "ssh_key", "fp")])
```

下发 API 仅 `WorkerService`（持有控制面）；`WorkerDirect` 直连模式无控制面，不适用。

### TaskResult

```python
result.task_id      # 你传入的 taskId
result.session_id   # opencode 会话 id (ses_...)
result.status       # 事件里的 status
result.output       # 便捷字段：尝试 output/result/text/content/message
result.payload      # 完整 task.completed payload
```

## 鉴权说明

| 场景 | 是否需要 token |
|------|----------------|
| `POST /execute` | ❌ 不需要（协议 fire-and-forget） |
| `/file` `/question-reply` `/agents` `/todos` `/plan-*` `/omo-*` | ✅ 需要 `X-Worker-Token` |
| EventsServer 的 register/heartbeat/events | ✅ 与 `--token` / 构造参数比对 |

**三方 token 必须一致**：worker 的 `X_WORKER_TOKEN` = 你构造 `WorkerClient(..., token=...)` 的 token =
`EventsServer(..., token=...)` 的 token。生产环境用 `openssl rand -hex 32` 生成随机串。

## 完整示例

见 [`examples/basic_usage.py`](examples/basic_usage.py)（服务模式）：

```bash
cd sdks/python
python3 examples/basic_usage.py
```

直连模式（非服务模式，适配 `WORKER_STANDALONE=true` worker）：

```bash
cd sdks/python
python3 examples/direct_client.py http://127.0.0.1:4198
```

## 与 stub server 的关系

仓库根还有个独立的控制面 demo：`scripts/worker-stub-server.py`（命令行进程形态）。

本 SDK 的 `EventsServer` 是**同协议的库形态**，嵌进你的第三方服务进程即可，不必再起
单独 stub。两者协议一致，可互换。

## 已知边界

- 执行结果是**异步**的：`/execute` 只回 202，结果必经 events 通道；不要指望同步返回体。
- **直连模式（WorkerDirect）无控制面**，因此无法等待结果；需要 `task.completed` 必须用
  `WorkerService`/`EventsServer`（worker 的 `SERVER_URL` 指向它）。
- `EventsServer` 结果存内存，进程退出即丢；生产请替换为落库/消息队列（可继承或
  在 `wait_for_*` 外自行消费 `events` 列表）。
- 模型凭据 / git 凭据原本由真实 server 经心跳命令下发；独立部署需在 worker 本地预置
  `auth.json` 等，EventsServer 不下发凭据。
- 空闲判死在真实 server 侧；独立部署需自行 watchdog。
