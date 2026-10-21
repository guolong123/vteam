# OpenCode v2 契约基线快照（T1 交付物）

本目录是 **opencode serve 的契约基线快照**，用于**检测未来的契约漂移**：任何实现改动都应先与本快照
比对，端点/响应形状/SSE 帧形态发生偏离时必须显式登记，而不是默默适配。

⚠️ **快照由哪个版本产出**（务必分清，见下节）：本快照**由本机的 `opencode v2.0.28` 二进制生成**，
**不是** worker 镜像锁定版本 `@opencode/cli@2.0.32` 的快照。

> ⚠️ **口径（别把两类产物混为一谈）**：本目录是**契约形态快照**（OpenAPI shape 捕获），
> 它**仍然是 2.0.28 的产物**，**没有**用 2.0.32 重跑 ⇒ "锁版即锁基线"的告诫**只对本目录成立**。
> 而**行为**证据（热重载）**已由锁版 `2.0.32` 产出**（`docs/agent-platform/opencode-v2-hot-reload-evidence/`，
> 2026-10-21 复检完成）——复检覆盖的路径上**未发现行为差异** ⇒ **行为**口径上它**已经是锁版版本的证据**。
> ⇒ **形态快照与行为证据是两种不同性质的产物**：前者待重跑，后者已锁版。

## 产出版本与生成方式

- **实测二进制 / 快照来源**：`opencode v2.0.28`（`/Users/mac/.opencode/bin/opencode`，`opencode --version`
  输出 `opencode v2.0.28`）——**本目录的 `openapi.json` / `sse-sample.txt` / `config-sample.json`
  全部由这个 2.0.28 二进制产出**（118 paths / 142 ops / 285 schemas）。
- **锁版目标**：`@opencode/cli@2.0.32`（`worker/Dockerfile` 的 `ARG OPENCODE_CLI_SPEC`）——
  **快照尚未用 2.0.32 重跑**，所以它**不是**锁定版本的契约基线。
  （⚠️ 这条只说**本目录的快照**；**行为**证据已由锁版 `2.0.32` 产出，见开头的口径块。）
- ⚠️ **版本不一致（快照 2.0.28 vs 锁版目标 2.0.32）**（计划 §1.1 / §8.2 已登记）：
  - **`GET /api/model` 的响应包装：两版一致，都是 `{location, data}`**——
    2.0.28 实测见本目录 `openapi.json`（`location` 与 `data` 均 `required`）；2.0.32 见**发布的
    `@opencode/client@2.0.32`** 类型定义 `ModelListOutput = { location, data }`
    （`dist/promise/generated/types.d.ts`）。**这里不存在版本差异**（此前文档里"2.0.32 改成裸数组"
    的说法**不成立**，已订正）。
  - live root spec（144 ops）与 `/v2/openapi.json`（143 ops）差一个端点。
  - **锁版即锁契约基线**——用 2.0.32 重跑下方「重新生成的命令」即可把基线推进到锁定版本，
    差异项须同步登记到计划 §10。**（这条只针对本目录这份契约快照；行为证据已锁版，见开头口径块。）**
- **生成环境**：隔离的 `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME`（临时目录），
  因此快照里**不含任何本机全局配置或凭据**；`location.directory` 指向当时的临时工作目录。
- **生成日期**：2026-10-20。

## 重新生成的命令

```bash
# 1) 隔离 HOME 起 serve（未设 OPENCODE_SERVER_PASSWORD → v2 自动生成密码并打到 stdout）
export SCRATCH=/tmp/vteam-v2-baseline
mkdir -p "$SCRATCH"/{home/.config,home/.local/share,project}
export HOME="$SCRATCH/home" XDG_CONFIG_HOME="$SCRATCH/home/.config" XDG_DATA_HOME="$SCRATCH/home/.local/share"
cd "$SCRATCH/project" && opencode serve --port 49333 --hostname 127.0.0.1 > "$SCRATCH/serve.log" 2>&1 &

# 2) 从 stdout 取自动生成的密码（banner 第二行）
PW="$(sed -n 's/^server password //p' "$SCRATCH/serve.log")"

# 3) OpenAPI spec（Basic 鉴权；v2 的 spec 只在 /openapi.json，/api/openapi.json → 404）
curl -s -u "opencode:$PW" http://127.0.0.1:49333/openapi.json -o openapi.json

# 4) SSE 原始帧（先起流，再建会话 + 下发 prompt 触发 session.created / session.inbox.enqueued）
curl -sN -u "opencode:$PW" http://127.0.0.1:49333/api/event > sse-raw.txt &
SID=$(curl -s -u "opencode:$PW" -X POST http://127.0.0.1:49333/api/session \
      -H 'content-type: application/json' -d "{\"location\":{\"directory\":\"$SCRATCH/project\"}}" \
      | sed -n 's/.*"id":"\(ses_[^"]*\)".*/\1/p')
curl -s -u "opencode:$PW" -X POST "http://127.0.0.1:49333/api/session/$SID/prompt" \
     -H 'content-type: application/json' -d '{"text":"contract baseline probe"}' > /dev/null

# 5) 配置归一化回显（工作目录里放一份 v1 形 opencode.json）
curl -s -u "opencode:$PW" -G http://127.0.0.1:49333/api/config \
     --data-urlencode "location[directory]=$SCRATCH/project" -o config-sample.json

# 6) 收尾
pkill -f "opencode serve --port 49333"
```

## 目录内容

| 文件 | 内容 | 关键观察点 |
|------|------|-----------|
| `openapi.json` | v2 serve 的完整 OpenAPI 3.1 spec（276KB / **118 paths** / **142 ops** / 285 schemas） | 业务端点全部带 `/api` 前缀（117 条），另有 1 条 `/auth/connect/{code}`；legacy 根路径面（v1 的 `/session`、`/event`、`/config`…）**已移除**——它们现在只命中 web SPA 的 200 HTML，不再是 API；`GET /openapi.json` 需 Basic 鉴权（未鉴权 401），`GET /api/openapi.json` → 404 |
| `sse-sample.txt` | `GET /api/event` 的**原始字节**（未加工） | **帧内没有 `event:` 行**（`grep -c "^event:"` = **0**，`grep -c "^data:"` = 33）——事件类型只在 payload 的 `data.type`；心跳以 SSE 注释行 `: heartbeat` 到达；`session.created` / `session.inbox.enqueued` 两帧均带 `durable:{aggregateID,seq,version}` |
| `config-sample.json` | 对一份**v1 形** `opencode.json`（扁平 `mcp` / `plugin` / `agent`+`permission` 对象 / provider 带 `npm`+`options`+`reasoning`）的 `GET /api/config` 归一化回显 | 见下方「归一化证据」 |

## SSE 帧形态结论（`sse-sample.txt` 为未加工的原始字节）

- **帧内没有 `event:` 行**：`grep -c "^event:" sse-sample.txt` → **0**；`grep -c "^data:"` → **33**。
  事件类型只在 payload 的 `data.type` 里（v2 的 OpenAPI schema 却声明 `event` 必填 ——
  **以实机字节为准，不要以 schema 为准**）。
- 心跳以 SSE 注释行 `: heartbeat` 到达。
- `session.created`（`durable.seq = 0`）与 `session.inbox.enqueued`（`durable.seq = 1`）两帧均在样本内：

```
data: {"id":"evt_…","created":…,"type":"session.created","location":{"directory":"…"},
       "data":{"sessionID":"ses_…","slug":"…","version":"2.0.28","projectID":"…"},
       "durable":{"aggregateID":"ses_…","seq":0,"version":1}}

data: {"id":"evt_…","created":…,"type":"session.inbox.enqueued","location":{"directory":"…"},
       "data":{"inboxID":"msg_…","sessionID":"ses_…",
               "item":{"type":"user","payload":{"text":"contract baseline probe"},"delivery":"steer"}},
       "durable":{"aggregateID":"ses_…","seq":1,"version":1}}
```

- 后续帧（可作事件映射表的实机样本）：`session.execution.started` → `session.instructions.updated`
  → `session.inbox.delivered` → `session.step.started` → `session.step.failed` →
  `session.execution.failed`。

## 归一化证据（config-sample.json 实测结论）

v2 **接受并归一化 v1 形配置**（静默、无报错）：

| v1 形 | v2 归一化结果 |
|-------|--------------|
| `mcp: {name: {...}}` | `mcp.servers.{name}` |
| `mcp.<n>.enabled: true` | `mcp.servers.<n>.disabled: false`（**键名语义反转，但 v2 归一化器处理正确**：`enabled:true` → `disabled:false` = 仍启用，**不是**"全被禁用"） |
| `mcp.<n>.timeout: 30000` | `timeout: {catalog: 30000, execution: 30000}`（**startup 段丢失**——不是被默认值补齐；v1 的单值 timeout 无处安放） |
| `plugin: [...]` | `plugins: [...]` |
| `agent: {name: {...}}` | `agents: {name: {...}}` |
| `agent.<n>.permission: {edit:"allow", bash:"ask"}` | `permissions: [{action:"edit",resource:"*",effect:"allow"},{action:"shell",resource:"*",effect:"ask"}]`（**bash → shell**） |
| `agent.<n>.prompt`（v1 键） | **处置取决于它所在的节**（实测：一份配置里 `agent:` 与 `agents:` 两节并存时）——① 在 v1 形 **`agent:` 节**内 → **被迁移到 `system`**（`{"prompt":"PROMPT-ONLY-VALUE"}` → `{"system":"PROMPT-ONLY-VALUE"}`；同节 `prompt` 与 `system` 并存时 `prompt` 的值胜出、原 `system` 被挪到 `request.body.system`）；② 在 v2 原生 **`agents:` 节**内 → **是未知键，被静默丢弃、无任何告警**（`{"prompt":"..."}` → `{}`） |
| `agents.<n>.system`（v2 原生键） | 在 v2 原生 `agents:` 节内**原样保留**；⚠️ 放在 v1 形 `agent:` 节内则被挪到 `request.body.system`（**inert**：v2 目前不随模型请求下发 `request.body`） |
| `agent.<n>.temperature` | `request.body.temperature`（实测路径为 `agent.<n>.request.body.temperature`，v1 形态被保留；但 v2 目前不随模型请求下发 → **inert 不生效**） |
| `provider.<p>.npm` | `package`（值自动加 `aisdk:` 前缀：`"@ai-sdk/openai-compatible"` → `"aisdk:@ai-sdk/openai-compatible"`） |
| `provider.<p>.options` | `settings` |
| `provider.<p>.models.<m>.reasoning` / `tool_call` / `attachment` / `modalities` | **被丢弃**（能力声明改由 `capabilities:{tools,input[],output[]}` 承载）；⚠️ **v2.0.28 没有 per-model `reasoning` / `temperature` 的落点**——归一化后被剥除，`GET /api/model` 里也不存在 → 这两个键**在 v2 没有落点**，写进去只会被丢弃并刷 WARN |

> ⚠️ **`prompt` 键的两分规则（计划 §2.6 / §2.7 / D6 / T15 引用的就是这条）**：`prompt` **只在 v1 形 `agent:` 节内**会被迁移为 `system`；到了 v2 原生 `agents:` 节它就是**未知键，被静默丢弃、没有任何告警**。因此**节名 `agent`→`agents` 与键名 `prompt`→`system` 必须同时改**——只改节名会让所有角色提示静默丢失。**唯一被 v2 原生保留的角色提示载体是 `agents.<name>.system`。**

## 鉴权与探针（本次一并实测）

| 探针 | 未鉴权 | 鉴权（`opencode:<pw>`） |
|------|--------|------------------------|
| `GET /` | **200**（web SPA，**不校验鉴权**） | 200 |
| `GET /api/info` | **401** | 200 |
| `GET /openapi.json` | **401** | 200 |
| `GET /api/info`（密码错误） | **401** | — |
| `GET /api/openapi.json` | — | **404**（spec 只在 `/openapi.json`） |
| `GET /session`、`/event`、`/config` | 200（web SPA HTML，**非 API**） | 同左 |

⇒ worker 的健康检查已从 `GET /` 改为 `GET /api/info`（`GET /` 未鉴权也 200，探不到鉴权状态）。

⚠️ **两个必须记住的探针陷阱**：

1. **`GET /` 永远 200**（v2 的 web SPA，未鉴权也 200）→ 旧的 `GET /` 健康检查会**因错误的原因通过**。
2. **v1 legacy HTTP 面不是 404，而是 200 + SPA HTML**：`GET /session`、`GET /event`、`GET /config` 全部返回 200 且 body 是 HTML（既不是 JSON，也不是 404）→ **只查状态码的契约自检会误判"服务正常"**。契约自检必须断言 **body 形态**（JSON / `Content-Type`），不能只看 200。

## 其它本次实测结论

- **自动生成的密码长度 43 字符**（未设 `OPENCODE_SERVER_PASSWORD` 时 v2 自动生成并打到 stdout：`server password <pw>`）。
- **`opencode mcp list --pure` → exit 1**（打印帮助文本 + `Unrecognized flag: --pure`）——是**显式失败**而非静默失败；探针应以非零退出码为准。
- **`--print-logs` 仍被 v2 接受**，且 v2 的 logfmt 诊断落 **stderr**、banner 落 **stdout** → `serve-log.ts` 的错误源可用（但该 flag 未文档化，不可依赖）。
