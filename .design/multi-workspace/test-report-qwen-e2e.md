# 真实 Worker + Provider 端到端验证报告（qwen3.8-27b）

> 目标：用真实 worker 容器 + 真实 OpenAI 兼容端点，验证「安装 worker → 配置 provider →
> 凭据/配置下发 → 模型真实可用」全链路，并确认空间隔离。
> 环境：本地 compose 测试栈（server 13200 / web 13201），模型端点
> `http://192.168.10.10:18020/v1`，模型 `qwen3.8-27b`。
> 时间：2026-11-13。

## 1. 端点连通性

```bash
curl -s http://192.168.10.10:18020/v1/models
# {"object":"list","data":[{"id":"qwen3.8-27b","object":"model",...,"max_model_len":150000}]}
```

worker 容器内同样可达（HTTP 200）。

## 2. 安装 worker（单令牌）

1. 管理员创建空间 `Qwen验证空间-<ts>`（`ws_0000000183`），签发空间注册令牌 `wst_a57ffd02...`。
2. 用单令牌启动 worker 容器：

```bash
docker run -d --name vteam-qwen-worker --network vteam-ws_vteam-net --init -p 14198:4198 \
  -e SERVER_URL=http://server:3000 \
  -e WORKER_ID=qwen-worker-<ts> \
  -e X_WORKER_TOKEN=wst_a57ffd02... \
  -e OPENCODE_SERVER_PASSWORD=qwen-serve-pass \
  -e OPENCODE_SERVE_PORT=4000 -e OPENCODE_MAX_INSTANCES=2 \
  -e WORKER_ADVERTISE_HOST=http://vteam-qwen-worker \
  -e WORK_DIR=/data/vteam-worker vteam-ws-worker
```

注册成功（空间由令牌反查，无需 WORKSPACE_ID/JOIN_TOKEN）：

```
[opencode-server] serve 就绪: http://127.0.0.1:4000
[worker] 注册成功: workerId=qwen-worker-1794541168, heartbeatInterval=10000ms
```

## 3. 配置 provider（API）

```bash
# 1) 模型目录
POST /models {"providerID":"local-qwen","modelID":"qwen3.8-27b","name":"Qwen3.8 27B"}   → 201
# 2) provider 级配置（OpenAI 兼容端点）
PATCH /models/providers/local-qwen
  {"providerType":"local","baseUrl":"http://192.168.10.10:18020/v1"}                    → 200
# 3) 凭据（本地 vLLM 不校验 key，填占位值）
POST /models/providers/local-qwen/credentials {"token":"local-noauth"}                 → 201
```

## 4. 下发到 worker（证据）

worker 日志：

```
[worker] 收到命令 model-credentials（providerKeys=[local-qwen]，providerConfigs=[local-qwen]），分派凭据登记
[worker] model-credentials：auth.json 已注入 /root/.opencode-iso/data/opencode/auth.json（providerKeys=1）
[worker] model-credentials：opencode.json provider 段已更新（providers=[local-qwen]）
[config-reload] model-credentials（凭据注入）：热重载完成（serve 侧可见 provider: local-qwen）
```

容器内 `auth.json`：

```json
{ "local-qwen": { "type": "api", "key": "local-noauth" } }
```

容器内 `opencode.json`（隔离配置域）：

```json
{
  "providers": {
    "local-qwen": {
      "name": "local-qwen",
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://192.168.10.10:18020/v1", "apiKey": "local-noauth" },
      "models": { "qwen3.8-27b": { "modelID": "qwen3.8-27b", "name": "Qwen3.8 27B" } }
    }
  }
}
```

## 5. 模型真实可用（端到端调用）

通过 worker 会话端点（控制面同款 API）创建会话并提问：

```
POST /sessions {"model":{"providerID":"local-qwen","modelID":"qwen3.8-27b"}}
  → {"sessionId":"ses_e2d01a711ffeEau2prZbHJFoFb"}
POST /sessions/:id/prompt {"prompt":"请只回复：pong","model":{"providerID":"local-qwen","modelID":"qwen3.8-27b"}}
  → {"admitted":true,"delivery":"steer"}
GET /sessions/:id/messages
```

assistant 消息（真实模型返回）：

```json
{
  "info": { "role": "assistant", "providerID": "local-qwen", "modelID": "qwen3.8-27b", "agent": "build" },
  "parts": [
    { "type": "reasoning", "text": "The user is requesting that I reply with only \"pong\"..." },
    { "type": "text", "text": "\n\npong" },
    { "type": "step-finish", "reason": "stop",
      "tokens": { "input": 6432, "output": 4, "reasoning": 27, "cache": {"read":0,"write":0} } }
  ]
}
```

✅ 回复内容 = `pong`；providerID/modelID 与配置一致；`step-finish.reason=stop`；有真实 token 用量。

## 6. 空间隔离复核

| 检查 | 结果 |
|---|---|
| 该空间 `GET /workers` | 仅 `qwen-worker-<ts>`（online） |
| 默认空间 worker 的 `auth.json` | 无 `local-qwen`（未被串入） |
| 空间外节点 | 未收到 local-qwen 的 provider/凭据 |

## 6.5 正常产品流程（建团队/成员 → 群聊 → 真实回复）

按用户正常操作路径重新验证（此前只直接调 worker 会话接口，没走产品流程）：

1. 安装向导的单令牌 worker 注册到该空间（online）。
2. Web「团队与成员 → 新建团队」→ 切到「按岗位新建」→ 勾选项目经理/开发者 → 指定主 Agent → 创建团队：
   `tm_0000000212`（2 个成员，管理员/开发者各 1）。
3. 成员库给两名成员设置默认模型 `local-qwen/qwen3.8-27b`。
4. Web「会话」打开团队群，发送「请只回复：收到」。
5. 群聊中 **项目经理-1** 回复 **「收到」**（截图 28）；消息经 vteam MCP `group_post` 发布，状态 sent。

### 本次产品流程暴露并修复的 3 个真实缺陷

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 新空间「按岗位新建」建团队 500 | `TeamsService.autoCreateMemberForSeat` 仍用 `member.findUnique({ where: { name } })`，多空间后唯一键是 `(workspaceId,name)` | 改为空间内 `findFirst` 查重（无 ctx 时回落 findUnique），并补 API 回归 `TEAM-MEMBER-01` |
| 2 | 群聊消息无回复，服务端 401 `WorkerUnavailable: createSession 401` | 控制面派发统一用**全局 WORKER_TOKEN**，而 worker 用**空间注册令牌**鉴权 | Worker 记录 `dispatch_token_ref`（AES 密文，注册时写入）；WorkerClient 每次调用按 workerId 解密令牌覆盖 `X-Worker-Token`（旧数据回退全局） |
| 3 | worker 注入 `/skills`、`/agent-policies` 401，MCP 配置为空 → agent 不会用 `group_post` | 资源拉取走 `WorkerOrJwtGuard`/全局双通道守卫，只接受全局 token；skills 路由仍是 `@Public()` 无租户上下文 | `WorkerOrJwtGuard` 与 `JwtAuthGuard` 均接受空间注册令牌；skills 读取路由改 `@WorkerOrJwtAllowed()`（带租户上下文） |

修复后 worker 注入日志：`8 skills, 13 mcp servers`，群聊真实回复成功。

## 7. 结论

- ✅ 单令牌安装 worker 可用（无需 WORKSPACE_ID/JOIN_TOKEN）。
- ✅ provider 配置 + 凭据按空间下发到节点，写入隔离配置域并由 serve 热加载生效。
- ✅ 模型 `qwen3.8-27b` 经 `192.168.10.10:18020/v1` **真实调用成功**（返回 pong、有 token 用量）。
- 测试 worker 容器已清理；测试空间/模型/provider/凭据保留在测试库中便于复查。
- 截图：`shots/functional/25-qwen端到端-模型页已配置.png`、`26-qwen端到端-worker在线.png`。
