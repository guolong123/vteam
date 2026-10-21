# OpenCode v2「会话切到一个**不存在**的 agent」的落点**实测证据**

> 本目录是 `docs/deployment.md` §8.5（OmO 在 v2 的状态）里那条**未验证假设**的闭环交付物：
> 「v1→v2 迁移后，老团队成员仍绑在 OmO 的 agent 名上（`Sisyphus - ultraworker` /
> `Prometheus - Plan Builder` / `Atlas - Plan Executor`），而 v2 线**不加载 OmO** ⇒
> 这些 agent 在 v2 上**不存在**；平台在派发时把这个名字**无条件**下发给 opencode
> ⇒ opencode 到底是**拒绝**（4xx）还是**静默忽略**（回落到默认 agent）？」
>
> **本目录给出的答案**：**既不是 4xx，也不回落**——切 agent 这一步被**静默接受**（204），
> 会话里也**存下了这个不存在的名字**；**真正爆点在下一轮执行**：opencode 抛
> `Session.AgentNotFoundError` ⇒ 那一轮**直接失败**（durable 的 `session.execution.failed`），
> **没有任何回复**，也**不会**改用默认 agent。
>
> 被它支撑的文档：`docs/deployment.md` §8.5（降级后果改写为实测）+
> §8.2 阶段 0 的**升级前数据检查**（成员仍绑着不存在的外部 agent ⇒ 修复 SQL）。

---

## 0. 一句话结论

**opencode v2（锁版 2.0.32）不校验 agent 名 ⇒ 不存在 ⇒ 静默接受（204）⇒ 下一轮执行时
`Agent not found` ⇒ 该轮失败且无回复（不会回落到默认 agent）。**

| 观测点 | 实测结果（v2.0.32） | 证据文件 |
|---|---|---|
| `GET /api/agent`（"什么存在"） | `build` / `general` / `explore` / `compaction` / `title` / `summary` / `plan` + **7 个 `vteam-*`**；**三个 OmO 名一个都不在** | `03-agent-list.txt` |
| `POST /api/session/{id}/agent`（切**不存在**的名字） | **HTTP 204 No Content**（空 body，**无任何错误信号**） | `04-unknown-agent-switch.txt` |
| `GET /api/session/{id}`（读回会话） | `agent` 字段 = **那个不存在的名字**（`"Prometheus - Plan Builder"`） | `05-unknown-agent-session-readback.txt` |
| 真发一条消息 | `POST /prompt` → **200**（已入队）；随后 **run 失败**：消息流里出现 `{"type":"idle","outcome":"failed","error":{"type":"unknown","message":"Agent not found: \"Prometheus - Plan Builder\""}}`，**assistant 消息数 = 0** | `06-unknown-agent-execution.txt` |
| 事件总线 | 发 **durable** 帧 `{"type":"session.execution.failed","data":{"sessionID":"ses_ea28…","error":{"type":"unknown","message":"Agent not found: \"Prometheus - Plan Builder\""}},"durable":{"aggregateID":"ses_ea28…","seq":5,"version":1}}` ⇒ **平台的终态闸门立刻收到失败**（**不会挂到首字超时**） | `06b-unknown-agent-event-stream.txt` |
| serve 自身日志 | `level=ERROR message="Failed to drain Session" cause="Session.AgentNotFoundError: Agent not found: \"Prometheus - Plan Builder\""`（栈顶 `SessionContext.select` → `SessionRunner.prepareContext`） | `09-serve-log-agent-lines.txt` / `09b-serve-log-full.txt` |
| **对照组**（切**存在**的 `vteam-developer`） | 204 → 会话 `agent=vteam-developer` → **assistant 消息的 `agent` 字段 = `"vteam-developer"`** → `idle outcome=succeeded` → durable `session.execution.succeeded` | `07-control-valid-agent.txt` / `07b-control-event-stream.txt` |

⇒ **平台侧的后果**（链条见 §4）：绑着外部 agent 名的成员**每一轮都会失败**，
错误文案是 `Agent not found: "<OmO 名>"` ⇒ **不是"悄悄换成别的 agent 干活"，是"这一轮没人干活"**。

---

## 1. 实测环境与版本（**务必分清**）

| 项 | 值 |
|---|---|
| **实测二进制** | `opencode v2.0.32`——**容器内**的 `/usr/local/bin/opencode`；`opencode --version` → `opencode v2.0.32`；serve 自报 `GET /api/info` → `{"version":"2.0.32",...}` |
| **镜像** | `vteam-worker:latest`（image id `sha256:b4a46ba1cd23d87d12e018f2e5a79f8b6c2979b6be7a52c6cad13d7648c38113`）＝**本仓库 `worker/Dockerfile` 构建**（`ARG OPENCODE_CLI_SPEC=@opencode/cli@2.0.32`）⇒ **锁版即锁证据** |
| **镜像内的 OmO 能力标记** | `/opt/omo-bundled.json` = `{"bundled":true,"v2":false,"spec":"oh-my-openagent@latest","version":"5.1.38"}` ⇒ **镜像确实只带 v1 形态的 OmO**（本目录测的正是这个前提的后果） |
| **运行位置** | **容器内**（`docker compose run --rm --no-deps`，一次性容器；**不触碰**运行中的 worker/server/web/db） |
| 容器平台 | Linux aarch64（`node:22-bookworm-slim`）· Node **v22.23.3**（脚本用 node 内置 `fetch`，无第三方依赖） |
| 宿主平台 | macOS **Darwin 25.5.0 arm64**——**只**用来跑 `docker compose`；**宿主二进制 `/Users/mac/.opencode/bin/opencode` 是 2.0.28 的 darwin/arm64 原生程序**，2.0.32 是 **linux ELF**，二者不能互换 ⇒ **本测量必须在容器里做** |
| 采集日期 | 2026-10-21（UTC 07:49~07:50） |
| 隔离 | `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` **全部**指向容器内临时目录 `/scratch/home/**` |
| 鉴权 | `OPENCODE_SERVER_PASSWORD=probe-fallback-pw-2026`（**合成假串**；Basic Auth 的 username 恒为 `opencode`） |
| 凭据 | **不需要任何 provider 凭据、不连外网**（模型侧是容器内 `127.0.0.1` 上的**桩 provider**；本目录里所有 key/token/口令全是**抛掷用的假串**） |
| 收尾 | 脚本杀掉自己起的 serve（TERM → 退出码 130）；收尾打印 `pgrep -fl "[o]pencode serve"` ⇒ **空**（无残留 serve 进程）；容器 `docker compose run --rm` ⇒ **无残留容器** |

> ⚠️ **为什么用桩 provider**：容器里没有任何真实 provider 凭据，而"**哪个 agent 真正执行了这条消息**"
> 需要一次真实的模型往返才能观测。桩 provider 只**替代模型本身**（返回一个固定回复），
> **agent 的选择仍由 opencode 产出**——证据有二：
> ① assistant 消息的 `agent` 字段（opencode 自己写的）；
> ② **桩收到的模型请求原文**里 `system` 段带的 `PROBE_SYSTEM_MARKER <agent 名>` 标记
> （由我们写进 `opencode.json` 的 `agents.<name>.system`）——**哪个标记进了模型请求，就是哪个 agent 在跑**。

---

## 2. 怎么复现

### 2.1 主路径（**已验证可用**）：在容器里跑 `repro-agent-fallback.mjs`

> ⚠️ 2.0.32 是 **linux ELF**，宿主上的 2.0.28 是 darwin/arm64 原生程序 ⇒
> **在宿主直接 `node repro-agent-fallback.mjs` 跑不出本目录这套证据**。
> 必须在**本仓库 `worker/Dockerfile` 构建出的镜像**里跑（那个镜像才带着 `@opencode/cli@2.0.32`）。

```bash
cd /Volumes/SSD-Data/01work/git-project/vteam-v2
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/opencode/agent-fallback.XXXXXX")   # ⚠️ 用**全新**目录（见下方坑）
mkdir -p "$SCRATCH/home" "$SCRATCH/data"
docker compose run --rm --no-deps \
  -v "$SCRATCH:/scratch" \
  -v "$SCRATCH/home:/root" \
  -v "$SCRATCH/data:/data/vteam-worker" \
  -v "$PWD/docs/agent-platform/opencode-v2-agent-fallback-evidence:/evidence" \
  -e HOME=/scratch/home \
  -e XDG_CONFIG_HOME=/scratch/home/.config \
  -e XDG_DATA_HOME=/scratch/home/.local/share \
  -e XDG_STATE_HOME=/scratch/home/.local/state \
  -e XDG_CACHE_HOME=/scratch/home/.cache \
  -e OPENCODE_SERVER_PASSWORD=probe-fallback-pw-2026 \
  -e SCRATCH=/scratch -e OUT_DIR=/evidence \
  -e SERVE_PORT=45991 -e MOCK_PORT=45992 \
  -e OPENCODE_BIN=/usr/local/bin/opencode \
  -e IMAGE_ID="$(docker image inspect vteam-worker:latest --format '{{.Id}}')" \
  -e HOST_PLATFORM="$(uname -srm)" \
  worker node /evidence/repro-agent-fallback.mjs
```

- 脚本**每次都用全新的临时目录**（不复用上一次的状态），跑完把 serve 进程杀掉并打印残留检查。
- 脚本**只写 `OUT_DIR`（= `/evidence`）下的证据文件**，**不写仓库其它地方**、**不碰宿主机 HOME**。
- 产物与本目录**同名同格式**（`01`~`10` + `99-summary.txt` + `mock-model-request-NN.json`）。
- ⚠️ **坑（实测踩到）**：Docker Desktop 的 virtiofs 对"**先 rm -rf 再复用同一个宿主目录路径**"
  的 bind mount 会留下**陈旧句柄** ⇒ 容器里在**挂载根目录**新建文件会报 `ENOENT`
  （子目录里正常）⇒ **每次用全新的临时目录**（`mktemp -d`），不要 `rm -rf` 后复用同一路径。
- ⚠️ 脚本把 serve 日志写在 `/scratch/serve.log`（宿主 `$SCRATCH/serve.log`）——
  收尾后它随临时目录一起留着，可自行核对；入库的是它的**摘录**（`09`）与**全文**（`09b`）。

### 2.2 等价的最小手工命令（逐条对应证据文件）

> 下面是**手工等价**命令（在**容器内**执行；二进制用 `opencode`＝容器内 2.0.32）。

```bash
# 起 serve（隔离 env；cwd = 项目目录，opencode.json 里写好 agents 节）
export SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/opencode/agent-fallback.XXXXXX")
mkdir -p "$SCRATCH"/{home/.config,home/.local/share,proj}
( cd "$SCRATCH/proj" && HOME="$SCRATCH/home" XDG_CONFIG_HOME="$SCRATCH/home/.config" \
  XDG_DATA_HOME="$SCRATCH/home/.local/share" OPENCODE_SERVER_PASSWORD=probe-fallback-pw-2026 \
  opencode serve --port 45991 --hostname 127.0.0.1 --print-logs --log-level debug \
  > "$SCRATCH/serve.log" 2>&1 & )
PW=probe-fallback-pw-2026; A=http://127.0.0.1:45991

# ① "什么存在"：agent 清单
curl -s -u "opencode:$PW" -G "$A/api/agent" --data-urlencode "location[directory]=$SCRATCH/proj" | jq '.data[].id'

# ② 建会话 → 切到一个**不存在**的 agent → 读回
SID=$(curl -s -u "opencode:$PW" -X POST "$A/api/session" -H 'content-type: application/json' \
      -d "{\"location\":{\"directory\":\"$SCRATCH/proj\"}}" | jq -r .data.id)
curl -s -i -u "opencode:$PW" -X POST "$A/api/session/$SID/agent" -H 'content-type: application/json' \
     -d '{"agent":"Prometheus - Plan Builder"}'          # ⇒ 204 No Content（静默接受）
curl -s -u "opencode:$PW" "$A/api/session/$SID" | jq .data.agent      # ⇒ "Prometheus - Plan Builder"

# ③ 发一条消息 → 读回复（**没有 assistant 消息**，只有一条 idle/failed）
curl -s -u "opencode:$PW" -X POST "$A/api/session/$SID/prompt" -H 'content-type: application/json' \
     -d '{"text":"PROBE"}'
curl -s -u "opencode:$PW" "$A/api/session/$SID/message?order=asc" | jq '.data[] | {type,agent,outcome,error}'

# 收尾
pkill -f "opencode serve --port 45991"
```

---

## 3. 目录内容（artifact → 它支撑的结论）

| 文件 | 测了什么 | 它支撑的结论 |
|---|---|---|
| `01-version-and-environment.txt` | 版本串（`opencode --version`）、serve 命令、隔离 env、镜像 ID、容器 ID、宿主平台、**项目 `opencode.json` 全文** | **锁版 2.0.32** 的证据（不是 2.0.28）；配置形态＝控制面注入的同形态（`agents` 节 + `system` 角色提示） |
| `02-route-discovery.txt` | `GET /api/info` / `/api/doc` / `/doc` / `/openapi.json` / `/api/openapi.json` / `/api` | **消息端点是"发现"出来的、不是假设的**：`/openapi.json` 存在（119 条路径）；`/doc` 只是 web SPA 的 HTML（**别当契约用**） |
| `02b-openapi-contract.txt` | OpenAPI 里 `/api/agent`、`/api/session`、`/api/session/{sessionID}/agent` 等路径定义 | **书面契约里 `session.switchAgent` 只有 204/400/401/404**（404 只会是"会话/目录不存在"）⇒ **契约层面就没有"agent 不存在"这个错误** ⇒ 平台传一个不存在的名字**在契约上是合法请求** |
| `03-agent-list.txt` | `GET /api/agent`（默认 location）+ `GET /api/agent?location[directory]=<项目目录>` | "什么存在"的基准：7 个 `vteam-*` **全部在**；**三个 OmO 名一个都不在** |
| `04-unknown-agent-switch.txt` | 对**三个** OmO 名各建一个会话并 `POST /api/session/{id}/agent` | ⭐ **切不存在的 agent ⇒ `204 No Content`**（三个名字都一样，**零错误信号**） |
| `05-unknown-agent-session-readback.txt` | 切完之后 `GET /api/session/{id}` | 会话里**存下了那个不存在的名字**（`agent` 字段＝原样字符串）⇒ "切成功"是真的成功 |
| `06-unknown-agent-execution.txt` | 真发一条消息 + 读消息流 | ⭐ **run 失败**：`idle` 消息 `outcome=failed` / `error.message = Agent not found: "<名字>"`；**assistant 消息数 = 0** ⇒ **这一轮没有回复**；**没有**回落到默认 agent |
| `06b-unknown-agent-event-stream.txt` | `GET /api/event`（SSE）原始帧 | ⭐ opencode 发 **durable 的 `session.execution.failed`** ⇒ 平台的终态闸门**立刻**判失败（**不会挂到首字超时**） |
| `07-control-valid-agent.txt` | **对照组**：新会话切 `vteam-developer`（存在）→ 同一条消息 | ⭐ assistant 消息的 `agent` 字段 = **`"vteam-developer"`**、`idle outcome=succeeded` ⇒ **机制确实被测到了**（不是恒失败） |
| `07b-control-event-stream.txt` | 对照组的事件帧 | 对照组是 `session.execution.succeeded` ⇒ 两条路（成功/失败）**由同一个机制**区分 |
| `08-mock-model-requests.txt` | 桩 provider 收到的模型请求**摘要** | 未知 agent 那一轮**没有**任何带 vteam 标记的模型请求（只有 opencode 内部的标题生成器）；对照组那一轮的 `system` 段带 `PROBE_SYSTEM_MARKER vteam-developer` ⇒ **直接证据**：请求哪个 agent 的提示，就是哪个 agent 在跑 |
| `mock-model-request-01.json` / `-02.json` | 桩 provider 收到的模型请求**完整原文** | 同上的逐字原文（01 = 标题生成器；02 = 对照组，含 12 个工具的完整 tools[]） |
| `09-serve-log-agent-lines.txt` | serve 日志中与 agent 有关的行 | ⭐ `Session.AgentNotFoundError: Agent not found: "Prometheus - Plan Builder"`（栈：`SessionContext.select` → `SessionRunner.prepareContext` ⇒ **失败发生在"为这一轮挑选 agent"的瞬间**，不是模型侧） |
| `09b-serve-log-full.txt` | serve 日志全文（`--print-logs --log-level debug`） | 完整现场（含 watcher / `agent.updated` 等噪音行） |
| `10-cleanup.txt` | 收尾核对（容器内） | serve 已退出（code=130）；`pgrep -fl "[o]pencode serve"` ⇒ **空**；桩 provider 已关闭 |
| `99-summary.txt` | 脚本自动汇总 | 一屏看完关键数字 |
| `repro-agent-fallback.mjs` | —— | **复现入口**（node 内置 fetch/http/fs，无第三方依赖） |

---

## 4. 结论对**平台**的影响（链条）

1. **切换那一步没有任何信号**：`POST /api/session/{id}/agent` 对不存在的名字返回 **204**
   ⇒ 平台侧（`worker/src/driver/v2-driver.ts` 的 `switchAgent`）**不会报错、不会重试、不会降级**。
2. **会话把不存在的名字存下来了**：`GET /api/session/{id}` 的 `agent` 字段＝原样字符串
   ⇒ 任何"看一眼会话状态就以为切好了"的检查都会**误判为正常**。
3. **失败发生在"这一轮真正开始跑"的时候**（`SessionRunner.prepareContext` → `SessionContext.select`）
   ⇒ **不是**"切 agent 时失败"，而是**每一条消息都失败**。
4. **失败是"快失败 + 有据"**：
   - 消息流：一条 `idle` 消息，`outcome="failed"`，`error.message = Agent not found: "<名字>"`；
   - 事件流：**durable** 的 `session.execution.failed`（平台终态闸门**只认**它，见
     `worker/src/driver/v2-event-map.ts`）⇒ 平台**立刻**拿到失败终态，
     **不会**挂到首字超时（`WORKER_FIRST_TOKEN_TIMEOUT_MS`）；
   - serve 日志：`Session.AgentNotFoundError`（可 grep）。
   ⇒ **代价**：该成员这一轮**没有回复、没有产出物**；任务的这一轮**判失败**。
5. ⇒ **不是"悄悄换成别的 agent 干活"**（那才是最难查的形态），而是"**这一轮没人干活**"——
   **好消息**：故障是**可见、可 grep、可归因**的（错误文案里直接点名那个不存在的 agent 名）。
6. ⇒ **谁会踩到**：v1→v2 迁移后，**成员仍绑着 OmO 外部 agent 名**的老团队
   （`TeamMember.opencodeAgentName` 里存着 `Sisyphus - ultraworker` / `Prometheus - Plan Builder` /
   `Atlas - Plan Executor`）——见 `server/src/common/constants/agent-role.constants.ts`
   的 `EXTERNAL_AGENT_ROLES`（三个外部岗位的 `defaultOpencodeAgentName`）。
   派发时该名字**无条件胜出**（`server/src/chat/worker-dispatcher.ts`：
   `opencodeAgentName ?? policyCandidate ?? omit`）⇒ **平台自己**不会发现它不存在。
7. ⇒ **修法**：切换**前**把这类成员的外部名清掉（并把岗位的外部槽位指向平台 agent）——
   完整 SQL 见 `docs/deployment.md` §8.2 阶段 0 的"升级前数据检查"。

---

## 5. ⚠️ **没有**测到的部分（明写，别越界引用）

- **没有用真实模型**：容器内无任何 provider 凭据 ⇒ 模型侧是**本地桩 provider**
  （openai-compatible 假端点）。桩只替代"模型生成"这一步；
  **agent 的选择、失败判定、事件帧都是 opencode 自己产出的**，
  且**对照组证明机制被测到**（同一个桩、同一段代码，有效 agent 就成功）。
  ⇒ **不能**由本目录推出"真实模型下的回答质量/耗时"这类结论。
- **没有测 v1（1.19.3）**：本目录只回答 **v2.0.32** 的行为。v1 上 OmO 是加载的
  ⇒ 那三个 agent **存在** ⇒ v1 上不会触发这个问题（**不需要**回 v1 复测）。
- **没有测"平台自己那 7 个 `vteam-*` agent 被删掉"的情形**：本目录只测了
  "**外部** agent 名（OmO 风格）不存在"。控制组是"存在" ⇒ 覆盖了"存在/不存在"两极，
  但**中间态**（同名但被 `disabled`、同名但配置被改）**未测**。
- **没有测平台侧的上报链路**：本目录测的是 **opencode 的行为**；
  "平台 worker 收到 `session.execution.failed` 之后如何落库/如何提示用户"
  属于平台代码路径（`worker/src/driver/v2-event-map.ts` → `prompt-await.ts` → exec 层），
  **本目录没有端到端跑平台的 worker**（那需要真实凭据 + 真实 DB）。
- **没有测 opencode v2 的其它版本**：结论只对 **2.0.32** 成立（其它 2.0.x 未复检）。
- **没有测"多 location / 子目录"的差异**：本次只在一个项目目录里做。
- **桩 provider 的请求体里带 opencode 的完整工具目录**（12 个工具）⇒
  `mock-model-request-02.json` 体积较大（28 KB）；这是**原文**，未裁剪。

---

## 6. 关联文档

| 文档 | 关系 |
|---|---|
| `docs/deployment.md` §8.5 | **本目录的落点**：OmO 降级后果改写为**实测**（不再写成假设） |
| `docs/deployment.md` §8.2 阶段 0 | **升级前数据检查**（SQL + 修复 SQL）——本目录的实测就是它存在的理由 |
| `docs/agent-platform/opencode-v2-hot-reload-evidence/` | 同为 **2.0.32** 锁版证据（配置热重载），可交叉核对"本目录的 serve 启动方式与隔离口径" |
| `server/src/common/constants/agent-role.constants.ts` | `EXTERNAL_AGENT_ROLES`：三个外部岗位与它们的 `defaultOpencodeAgentName` |
| `server/src/chat/worker-dispatcher.ts` | `VTEAM_AGENT_NAMES`（平台自己的 agent 名）+ 派发时的**无条件优先**（`opencodeAgentName ?? …`） |
| `server/src/teams/teams.service.ts` | `resolveMemberBinding` 的**规则 5 预填**（显式值 > 岗位的 `defaultOpencodeAgentName`） |
| `worker/src/driver/v2-driver.ts` | `switchAgent`：平台**不校验**名字、直接 POST |
| `worker/src/driver/v2-event-map.ts` | 终态**只认** durable 的 `session.execution.*`（⇒ 失败是快失败） |
