# OpenCode v2 阻塞 spike 实测结论（T4 / T5 / T6）

> 计划：`.omo/plans/opencode-v2-adaptation.md`（P0 阶段的三个阻塞 spike）
> 实测二进制：`/Users/mac/.opencode/bin/opencode` → **`opencode v2.0.28`**
> 对照二进制：`/Users/mac/.opencode/bin/opencode.v1.18.32.bak` → `1.18.32`（用于双形态插件的 v1 侧验证）
> 发布版类型：`@opencode/plugin@2.0.32`、`@opencode/schema@2.0.32`（`npm pack` 解包读取）
> 实测日期：2026-10-20　执行环境：macOS arm64 / node v24.14.0
> 全部实验的 scratch 目录：`/private/var/folders/0y/1xtzqt_j3_g_1yff3gnkfsgc0000gn/T/opencode/spike/`（**未向仓库写入任何 scratch 文件**）
>
> **本文件只记录"实测到的事实"与"可复现步骤"。凡未实测的，一律标注"未验证"。**
> 每条结论都区分 `实验实测` 与 `读文档` 两类来源。

---

## 0. 结论速查

| Spike | 判定 | 一句话结论 | 证明它的那条命令 + 输出 |
|---|---|---|---|
| **T4** 角色提示落地 | ✅ **PASS** | `agents.<name>.system` **确实进入最终模型请求**；`POST /api/session/{id}/agent` 是被文档背书的激活机制；prompt body 的 `agents:[{name}]` attachment **是 no-op**；`delivery:"steer"` 在无 run 时**立即执行** | `bash docs/agent-platform/opencode-v2-spike-results/repro.sh` → `T4_RESULTS {"switch_agent_puts_system_in_request": true, "agents_attachment_pulls_system": false, "agents_attachment_is_noop": true}` |
| **T5** 工具注册 API | ✅ **PASS**（但**改变 T19 的产物形态**） | `.opencode/tools/*.ts` 的文件自动发现**在 v2 已移除** → 三个生成器的产物必须从"文件"改成"插件注册代码"；且插件工具**默认只能经 Code Mode 调用**，必须显式 `options:{codemode:false}` 才能被模型直接调用 | `bash docs/agent-platform/opencode-v2-spike-results/repro.sh` → `T5_RESULTS {"session.tool.called": true, "session.tool.success": true, "tool": "spike_probe"}` |
| **T6** `--pure` 等价物 | ⚠️ **无完全等价物**（有可落地替代方案） | `plugins: []` / 不写 `plugins` / `experimental` / `instructions: []` **全部无效**；`plugins:["-*"]` **会连内置 agent/provider 插件一起关掉**（`Agent not found: "build"`）**不可用**；唯一可靠手段是**隔离配置发现路径**（独立 `XDG_CONFIG_HOME`/`HOME`），必要时用 `plugins:["-<id>"]` 精确禁用 | 见 §4 矩阵表；`bash docs/agent-platform/opencode-v2-spike-results/repro.sh` 之外，复现脚本见 §4.5 |

**对计划的直接影响（必须回写计划）**

| 计划条目 | 原假设 | 实测结论 | 需要的动作 |
|---|---|---|---|
| **D6 / T15** 角色提示 | 主路径 = (a′)`agents.<name>.system` + (b) `POST /api/session/{id}/agent` | ✅ **成立**，且 (b) 是**唯一**能激活角色提示的 prompt 侧机制；候选 (c) `agents:[{name}]` **无效**，应从计划里剔除 | T15 按 (a′)+(b) 落地；**不要**依赖 prompt body 的 `agents[]` |
| **D6** 兜底 (d) 文本前缀 | 需要兜底 | ✅ **不需要**（角色提示真实到达模型），但建议保留为"角色提示写错时的静默保险" | 可选 |
| **D8 / T19** 三个生成器 | "只改 import 与签名"（若文件发现仍在）或"改成插件注册代码"（若已移除） | **已移除** → 必须改成**插件注册代码**（`Plugin.define` + `ctx.tool.transform`） | T19 工作量按"产物形态改变"估；模板重写 |
| **D8** 双形态插件模块 | 一份产物两版通用 | ✅ **可行**（v1 调 `server()`、v2 调 `setup()` 且忽略 `server()`），已在 1.18.32 与 2.0.28 双侧实测 | T19 按双形态产出；但 v2 分支必须**防呆**（v1 也会调 `setup`） |
| **T6** `--pure` 等价物 | 未知 | **无等价物**；替代方案 = 隔离 `XDG_CONFIG_HOME`/`HOME` + 项目配置里显式 `plugins` | T2 移除 `--pure` 后，改为在 spawn 时注入隔离 env；T15/T16 的凭据注入路径要跟着改到隔离目录 |
| **T6** OmO 集成 | 保留 OmO | ⚠️ **v1 插件实现不会在 v2 运行**（官方迁移指南明写）；且 vteam 现在把 OmO 注册在**全局** `~/.config/opencode/opencode.json` → 隔离 XDG 后会失效 | OmO 条目必须搬进**项目** `opencode.json` 的 `plugins`，或搬进隔离的全局目录；OmO 需 v2 入口（`{id, setup}`） |

---

## 1. 实测方法：无凭据 mock provider

三个 spike 全部**不需要任何 provider 凭据 / 额度 / 外网**：

1. 起一个本地 OpenAI 兼容 mock server（`docs/agent-platform/opencode-v2-spike-results/mock-provider.mjs`），
   实现 `POST /v1/chat/completions`（流式 + 非流式），并把**每一个收到的请求体落盘**成 JSONL。
2. 在项目 `opencode.json` 里注册一个自定义 provider 指向它：

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "model": "spike-mock/spike-model",
     "providers": {
       "spike-mock": {
         "name": "Spike Mock",
         "package": "@opencode/ai/providers/openai-compatible",
         "settings": { "baseURL": "http://127.0.0.1:45981/v1" },
         "models": {
           "spike-model": {
             "name": "spike-model",
             "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
             "limit": { "context": 8192, "output": 1024 }
           }
         }
       }
     }
   }
   ```

   > `package` 字段取 `"@opencode/ai/providers/openai-compatible"`（v2 内置 provider 包名）实测可用。
   > 任务书给的 `"aisdk:@ai-sdk/openai-compatible"` 形式**未单独验证**（二进制里存在 `aisdk:` 前缀字符串，但本 spike 未用该形式做过端到端验证）。

3. 真起 v2 serve（`opencode serve --port <p> --hostname 127.0.0.1`），用 `GET /api/session/{id}/message`、
   `GET /api/event`（SSE）、以及 **mock 落盘的最终请求体**三重取证。

**一键复现（T4 + T5 的全部断言）：**

```bash
cd docs/agent-platform/opencode-v2-spike-results
./repro.sh                       # OPENCODE_BIN=... ./repro.sh 可换二进制
```

实测输出（最后一次运行）：

```
opencode: opencode v2.0.28
scratch : /var/folders/.../T/opencode-v2-spike.LnERrs

=== T4: role prompt into the final model request ===
T4_RESULTS {"switch_agent_puts_system_in_request": true, "agents_attachment_pulls_system": false, "agents_attachment_is_noop": true}

=== T4: delivery=steer on an idle session ===
T4_STEER_EVENTS [[...,"session.inbox.enqueued"], [...,"session.execution.started"], [...,"session.inbox.delivered"], [...,"session.execution.succeeded"]]
  steer executed immediately: enqueued->started delta = 8 ms

=== T5: v2 plugin tool registered AND invoked ===
T5_RESULTS {"session.tool.called": true, "session.tool.success": true, "tool": "spike_probe"}
  tool advertised to the model: ['edit','glob','grep','question','read','shell','skill','spike_probe','subagent','webfetch','websearch','write','execute']
  tool result: {"marker":"SPIKE_PROBE_OK","input":{"note":"hi"},"ctxKeys":["agent","id","messageID","progress","sessionID","signal"],...,"hasDirectory":false}

=== plugin discovery (from the serve log) ===
  msg="loading plugin" id=.../proj/.opencode/plugins/v2-tool-plugin.ts
```

> **复现注意**：`repro.sh` 会先 `pkill -f mock-provider.mjs`。若 mock 端口被占，脚本会 FATAL 退出而不是静默产生空断言
> （实测踩过：旧 mock 进程占着 45981，导致"请求体文件为空、所有断言看起来都 false"的假阴性）。

---

## 2. T4 — 角色提示运行时落地验证　**判定：PASS**

计划 T4 的 PASS 判据是"**至少一条路径能在真实模型调用的请求里看到角色提示词**"。已满足，且不止一条。

### 2.1 结论表

| # | 问题 | 答案 | 怎么证的（实验） | 原始证据 |
|---|---|---|---|---|
| T4.1 | `agents.<name>.system` 的内容是否真进入**最终模型请求**？ | ✅ **是**。system 消息的**第一行**就是角色提示原文，其后是 opencode 内置的 system 段（`# Your Model` / `# Code Mode` / …） | 用 mock provider 落盘最终 chat-completions 请求体，逐条 grep marker | `evidence/t4-role-prompt.txt`、`evidence/t5-recorded-model-requests.jsonl` |
| T4.2 | `POST /api/session/{id}/agent {"agent":"<name>"}`（返回 204）之后，该 agent 的 `system` 是否被应用到**后续 turn**？ | ✅ **是**。切换后发一条 prompt，最终请求的 system 消息首行即该 agent 的角色提示 | 同上；并见 `session.agent.selected` 事件 + 会话里新增 `type=agent-switched` 消息 | `evidence/t4-role-prompt.txt` |
| T4.3 | prompt body 的 `agents:[{"name":"..."}]` attachment 是否把该 agent（及其 system 提示）拉进本次 turn？ | ❌ **不是 —— 它是 no-op**。最终请求里 system 消息是**默认 build agent** 的提示；assistant 消息的 `agent` 字段仍是 `build`；**没有** `agent-switched` 消息，**没有** `session.agent.selected` 事件 | 三条独立证据同时指向 no-op | `evidence/t4-role-prompt.txt` |
| T4.4 | 无活跃 run 时 `POST /api/session/{id}/prompt` + `delivery:"steer"` 是立即执行还是排队？ | ✅ **立即执行**。事件序列 `session.inbox.enqueued` → `session.execution.started`，两者相隔 **2~33 ms**（多次运行观测） | 抓 SSE 原始帧，比对 `created` 毫秒时间戳 | `evidence/t4-role-prompt.txt`、`evidence/t4-sse-frames.log` |
| T4.5 | 插件 `ctx.session.hook("prompt", cb)` 能否在 durable admission 时改写 `prompt.text`？ | ✅ **能**。最终请求的 user 消息变成 `PLUGIN_HOOK_PROMPT_REWRITE::ORIGINAL_USER_TEXT` | 装一个只挂 prompt hook 的插件再跑一遍 | `evidence/t4-plugin-hooks.txt` |
| T4.5b | （追加发现）插件 `ctx.session.hook("context", cb)` 能否直接改**模型请求的 system**？ | ✅ **能**，且比 (a′)+(b) 更灵活：`event.system.push({type:"text",text:"..."})` 后，最终请求的 system 消息里出现 `PLUGIN_HOOK_SYSTEM_MARKER` | 同上 | `evidence/t4-plugin-hooks.txt` |

### 2.2 逐条原始证据

**(1) T4.1 / T4.2 —— 角色提示进入最终模型请求**

`evidence/t4-role-prompt.txt`（节选）：

```
### case 1: explicit agent switch (POST /api/session/{id}/agent)
session=ses_ea8f1e895ffex215ixR9RIHTJK
204 <- HTTP status

=== per-session analysis ===
session ses_ea8f1e895ffex215ixR9RIHTJK:
   req#2 SYS_MARKER=True PROM_MARKER=False | ROLE_PROMPT_MARKER_VTEAM_SYS :: you are the vteam system-role agent\n# Your Model
session ses_ea8f1d3a5ffeLsaiMzINkAYxpF:
   req#4 SYS_MARKER=False PROM_MARKER=False | You are an AI agent running in OpenCode, a coding agent harness. Help the user a
session ses_ea8f1bfb9ffetZltfAK8kV7fBg:
   req#6 SYS_MARKER=False PROM_MARKER=True | ROLE_PROMPT_MARKER_VTEAM_PROM :: you are the vteam prometheus role agent\n# Your

=== session.agent.selected events ===
   {"sessionID": "ses_ea8f1e895ffex215ixR9RIHTJK", "agent": "vteam-sys"}

=== messages of ses_ea8f1e895ffex215ixR9RIHTJK ===
   type=idle             id=msg_1570e18b1002nN11G6pZiC5v4g {}
   type=assistant        id=msg_1570e189e0019N8MzamU9YJV1P {"agent": "vteam-sys"}
   type=user             id=msg_1570e183b001BQwCZeG3kamLDA {"text": "CASE1"}
   type=agent-switched   id=msg_1570e17ce001WXz65RYY9P4uUC {"agent": "vteam-sys"}
=== messages of ses_ea8f1d3a5ffeLsaiMzINkAYxpF ===
   type=idle             id=msg_1570e2cac001HbsQqv2ZM04DPo {}
   type=assistant        id=msg_1570e2c97001tpK85g9qRzV9c {"agent": "build"}
   type=user             id=msg_1570e2c7d0012RPImEpFBfjlWM {"text": "CASE2"}
```

三个 case 分别是：

| case | 做法 | 结果 |
|---|---|---|
| 1 | `POST /api/session/{id}/agent {"agent":"vteam-sys"}` + prompt | ✅ system 里有 `ROLE_PROMPT_MARKER_VTEAM_SYS`；assistant 消息 `agent: vteam-sys`；多出一条 `agent-switched` 消息 |
| 2 | prompt body 带 `agents:[{"name":"vteam-prom"}]` | ❌ system 里**没有** `ROLE_PROMPT_MARKER_VTEAM_PROM`；assistant 消息 `agent: build`；**没有** `agent-switched` 消息 |
| 3 | `POST /api/session` 时带 `"agent":"vteam-prom"` | ✅ system 里有 `ROLE_PROMPT_MARKER_VTEAM_PROM` |

> case 3 是**追加发现**：`POST /api/session` 的 body 里带 `agent` 也能直接选定角色 agent（比先建会话再切换更省事）。

最终请求体的 system 消息原文（`evidence/t5-recorded-model-requests.jsonl` 同款）：

```
ROLE_PROMPT_MARKER_VTEAM_SYS :: you are the vteam system-role agent
# Your Model
- Name: spike-model
- Provider ID: spike-mock
- Model ID: spike-model
# Code Mode
...
```

→ 角色提示被**前置**到 opencode 内置 system 段之前（不是替换、不是追加到末尾）。

**(2) T4.4 —— `delivery:"steer"` 在空闲会话上立即执行**

`evidence/t4-role-prompt.txt` / `repro.sh` 输出：

```
T4_STEER_EVENTS [[1792462505965, "session.inbox.enqueued"], [1792462505973, "session.execution.started"],
                  [1792462505993, "session.inbox.delivered"], [1792462506095, "session.execution.succeeded"]]
  steer executed immediately: enqueued->started delta = 8 ms
```

（另一次运行为 2 ms、33 ms。）

→ **Q11 有答案了**：`delivery:"steer"` 在"当前无 run"时**立即开跑**，不排队等待下一轮。
→ 追加发现：v2 的 prompt **默认 delivery 就是 `steer`**（响应体里 `"delivery":"steer"`，即使 body 里不写）。
→ 追加发现：`POST /api/session/{id}/prompt` 返回的是 **入队项**（`Session.Inbox.User`），**不是**最终答复；
真正终态要看 `session.execution.succeeded/failed/interrupted` 事件或 `GET /api/session/{id}/message`。

**(3) T4.5 / T4.5b —— 插件 hook 作为角色提示载体**

`evidence/t4-plugin-hooks.txt`：

```
=== recorded model requests ===
req#1 SYS len=2119 PROMPT_MARKER=False SYS_MARKER=False
req#1 USER = "PLUGIN_HOOK_PROMPT_REWRITE::ORIGINAL_USER_TEXT"
req#2 SYS len=8498 PROMPT_MARKER=False SYS_MARKER=True
req#2 USER = "PLUGIN_HOOK_PROMPT_REWRITE::ORIGINAL_USER_TEXT"
```

用到的插件源码（`proj-t4hook/.opencode/plugins/spike-hooks.ts`）：

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "spike-hooks",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      event.prompt.text = "PLUGIN_HOOK_PROMPT_REWRITE::" + event.prompt.text
    })
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "PLUGIN_HOOK_SYSTEM_MARKER::injected via ctx.session.hook('context')" })
    })
  },
})
```

- `prompt` hook **会改写 user 文本**（在 durable admission 时）。
- `context` hook **能往 system 里注入任意段**。
- 注意：`req#1`（2119 字节）是**会话标题生成**请求，它拿到了 prompt hook 的改写，但**没有**拿到 context hook 的 system 注入
  → `context` hook 只作用于 **primary** 请求；标题 / 压缩 / generate 各有独立 hook（与官方迁移指南"Register `context`, `compaction`, `generate`, and `title` separately"一致）。

### 2.3 T4 复现命令（逐条）

```bash
# 0) 起 mock provider
MOCK_PORT=45981 MOCK_OUT=/tmp/req.jsonl node docs/agent-platform/opencode-v2-spike-results/mock-provider.mjs &

# 1) 起 v2 serve（项目里放 mock-opencode.json 改名为 opencode.json）
cd $SCRATCH/proj
HOME=$SCRATCH/xdg XDG_CONFIG_HOME=$SCRATCH/xdg/.config XDG_DATA_HOME=$SCRATCH/xdg/data \
XDG_STATE_HOME=$SCRATCH/xdg/state XDG_CACHE_HOME=$SCRATCH/xdg/cache \
OPENCODE_SERVER_PASSWORD=spikepass OPENCODE_SERVER_USERNAME=opencode \
opencode serve --port 45980 --hostname 127.0.0.1 --print-logs --log-level debug &

# 2) 抓 SSE
curl -sN -u opencode:spikepass http://127.0.0.1:45980/api/event > sse.log &

# 3) T4.1/T4.2：切 agent + 发 prompt
SID=$(curl -s -u opencode:spikepass -X POST -H 'content-type: application/json' \
  -d '{"location":{"directory":"'"$PWD"'"}}' http://127.0.0.1:45980/api/session \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
curl -s -o /dev/null -w '%{http_code}\n' -u opencode:spikepass -X POST \
  -H 'content-type: application/json' -d '{"agent":"vteam-sys"}' \
  http://127.0.0.1:45980/api/session/$SID/agent          # -> 204
curl -s -u opencode:spikepass -X POST -H 'content-type: application/json' \
  -d '{"text":"T4-A hello"}' http://127.0.0.1:45980/api/session/$SID/prompt

# 4) 看最终模型请求体里有没有角色提示
python3 - <<'EOF'
import json
for l in open('/tmp/req.jsonl'):
    r=json.loads(l); b=r['body']
    for m in b.get('messages',[]):
        if m.get('role')=='system' and 'ROLE_PROMPT_MARKER_VTEAM_SYS' in str(m.get('content','')):
            print("FOUND in req#%d, system len=%d" % (r['n'], len(m['content'])))
EOF
```

> 完整自动化版本见 `docs/agent-platform/opencode-v2-spike-results/repro.sh`（它一次跑完 T4 的三条断言 + T5 的工具调用断言）。

### 2.4 对 T15 / D6 的结论

- **主路径 (a′)+(b) 成立**：`opencode.json` 写 `agents.<name>.system`，driver 在发 prompt 前先 `POST /api/session/{id}/agent {"agent":"<name>"}`（204），或建会话时直接带 `agent`。
- **不要用 prompt body 的 `agents:[{name}]`**：实测 no-op，会让"角色提示丢失"变成**静默**失效（与 v1 `prompt` 键被丢弃是同一类陷阱）。
- **兜底 (d) 文本前缀**：对**逐 agent 的角色提示**来说不再必需（它已真实到达模型）；但保留成本极低，作为"配置写错时的静默保险"保留。⚠️ 对**逐消息 blob** 来说，文本前缀是**不可省略的地板**——D6(f) 的插件交接在"插件未就绪 / 产物缺失 / 写盘失败"时**必须**退回它（blob 落在 user 段，优先级低于 system 段，但**绝不丢**）。
- **`agents.<name>.system` 在 `GET /api/config` 回显里原样存在**（本 spike 顺带复核：配置层无 `prompt` 键残留）→ T15 验收标准 5 可直接沿用。
- **（后续）T4.5 / T4.5b 的 `ctx.session.hook("context")` 结论已实现并实机证明**：本 spike 证明了"插件能把任意段推进**模型请求的 system 段**"，D6 的**候选 (f)**把它**产品化**为 vteam 逐消息 blob 的载体——worker 把 blob **原样**写进 `<workDir>/.vteam-system-handoff/<sessionID>.txt`，插件 `<workDir>/.opencode/plugins/vteam-system-handoff.ts` 在 `ctx.session.hook("context")` 里读它 → `event.system.push({type:"text", text})`。**实机证明**：system 段 20 688 字符（前置的 13 323 字符是 opencode 内置段，其后是 blob，blob 是 system 段的**最后一项**），**user 段不含 blob**；同一会话两次派发 blob **逐字节相同**。⚠️ 落地时另测出两条新事实：① **插件按 location 加载**（见 §3.1.1）；② `event.system.push(...)` 落在**内置 system 段之后** ⇒ 可缓存前缀是 `[内置][blob][消息…]`（与 v1 的次序相反，只在跨版本升级那一次有影响）。**实现**：`worker/src/driver/v2-system-handoff.ts`（+ 两个 spec）；**计划**：`.omo/plans/opencode-v2-adaptation.md` 的 **D6** 与 **T14b**。

---

## 3. T5 — v2 工具注册 API 与 ToolContext　**判定：PASS（但改变 T19 的产物形态）**

### 3.1 结论表

| # | 问题 | 答案 | 怎么证的 | 原始证据 |
|---|---|---|---|---|
| T5.1 | v2 声明工具的**精确签名** | 见 §3.2 的发布版类型原文 | `npm pack @opencode/plugin@2.0.32` 解包读 `dist/promise/tool.d.ts` / `dist/promise/plugin.d.ts`；再读 `@opencode/schema@2.0.32` 的 `dist/tool.d.ts` | `evidence/t5-published-types.txt` |
| T5.2 | vteam 现在用的 `context.sessionID` / `context.directory` / `context.agent` 在 v2 从哪来 | `sessionID` ✅ **同名保留**；`agent` ✅ **同名保留**；`directory` ❌ **v2 的 ToolContext 里没有**（见 §3.4） | 工具内部 `Object.keys(context)` 实测 | `evidence/t5-tool-registration.txt` |
| T5.3 | `.opencode/tools/*.ts` 的**文件自动发现**在 v2 是否仍存在 | ❌ **已移除**。放在 `.opencode/tools/` 下的文件**完全不会被 import**（连 import 副作用都不发生） | 在该目录放一个"import 时写 marker 文件"的探针 → marker 不出现；`.opencode/plugins/` 下的同款探针 → marker 出现 | `evidence/t5-tool-registration.txt` |
| T5.4 | `.opencode/plugins/*.ts` 是否被自动发现 | ✅ **是**。`GET /api/plugin` 里出现 `{"id":"spike-tools","source":{"type":"local","path":".../.opencode/plugins/tools.ts"}}` | 同上 | `evidence/t5-tool-registration.txt` |
| T5.5 | 插件文件里 `import { Plugin } from "@opencode/plugin"` 能否解析 | ✅ **能**（宿主内置该模块，**不需要** node_modules / package.json）；静态 import 与动态 `await import()` 都行 | 三种写法的探针（静态 / 动态 / 纯对象导出）全部 setup 成功 | `evidence/t5-tool-registration.txt` |
| T5.6 | 一份 ≤30 行的样例能否被真 serve 加载并被模型调用一次 | ✅ **能**。`session.tool.called` + `session.tool.success` 事件都出现；工具输出回到模型上下文 | mock provider 让模型发起该工具调用 | `evidence/t5-tool-registration.txt` |
| T5.7 | 双形态插件模块（v2 `Plugin.define` + v1 `async server()`）是否可行 | ✅ **可行**。v1 调 `server()`（并**也会**尝试调 `setup`），v2 调 `setup()` 且**完全忽略** `server()` | 在 1.18.32 与 2.0.28 双侧各跑一遍 | `evidence/t5-dual-v1.txt`、`evidence/t5-dual-entrypoint.txt` |
| T5.8 | （追加发现）插件工具默认能被模型直接调用吗 | ❌ **不能**。默认只出现在 **Code Mode 目录**里，模型必须通过 `execute` 工具用 JS 调它；必须显式 `options:{codemode:false}` 才进模型的 `tools[]` | 对比两次请求体的 `tools[]` 与 system 里的 Code Mode 目录 | `evidence/t5-tool-registration.txt` |
| T5.9 | （**后续实测补充**，见下方 §3.1.1）插件是**按 location 加载**的吗 | ✅ **是——每个 location 一次加载、一次 `setup`**。同一份插件文件在 serve 日志里出现**两次** `loading plugin`（对应两个 location） | 在一个 serve 上开两个 location（不同 `directory`），观察 `loading plugin` 行的条数与各自 `setup` 的调用次数 | D6(f) 落地时的实机记录（`worker/src/driver/v2-system-handoff.ts` 的模块头与 `.real.spec.ts`） |

### 3.1.1 追加实测：v2 **按 location 加载插件**（D6(f) 落地时测出）

> **这条不在 T4/T5 spike 的原始结论里**，是 D6 候选 (f)（逐消息 system blob 的插件交接）落地时测出来的。已回写到计划 `.omo/plans/opencode-v2-adaptation.md`（D6 / §2.5 / §8.2 / 附录 D）。

**事实**：v2 的插件**按 location 加载**——每个 location 一个插件实例、一次 `setup`。实测同一份插件文件在 serve 日志里出现**两次** `loading plugin`（对应两个 location）。

**为什么重要**："插件在别处加载过"**推不出**"本会话所在的 location 也加载了"。若用**一个全局**就绪标记来判定"插件路径是否生效"，那么**新 location 的第一次派发**会误判"插件已就绪"⇒ 写进交接文件的 blob **没有任何 hook 读它** ⇒ **blob 静默丢失**（最坏结果，而且不报错）。

**处置**：就绪标记**按 location 分桶**（`.ready/<location 哈希>.txt`，由插件 `setup` 写）⇒ 判据与 hook 的注册范围**严格一致**；serve 每次（重）启都清掉全部标记（宁可退回文本前缀，也不丢 blob）。

**实现位置**：`worker/src/driver/v2-system-handoff.ts`（交接存储 + 插件生成器 + 按 location 的就绪协商）、`worker/src/driver/v2-system-handoff.spec.ts`、`worker/src/driver/v2-system-handoff.real.spec.ts`；载体路由在 `worker/src/driver/v2-driver.ts` 的 `routeSystemBlob`。计划见 `.omo/plans/opencode-v2-adaptation.md` 的 **D6**（候选 (f)）与 **T14b**。


### 3.2 v2 声明工具的精确类型（发布版原文）

来源：`@opencode/plugin@2.0.32` → `dist/promise/tool.d.ts`

```ts
export interface ToolContext extends Omit<Tool.Context, "progress"> {
    readonly signal: AbortSignal;
    readonly progress: (update: Tool.Metadata) => Promise<void>;
}
export type Info<Input extends Tool.ValueSchema<any> = Tool.ValueSchema<any>,
                 Output extends Tool.ValueSchema<any> | undefined = Tool.ValueSchema<any> | undefined>
    = Omit<Tool.Info<Input, Output>, "execute"> & {
    readonly execute: (input: Parameters<Tool.Info<Input, Output>["execute"]>[0],
                       context: ToolContext) => Promise<Tool.Result<Output>>;
};
export interface ToolEditor {
    list(): readonly (Info & { readonly id: string })[];
    get(id: string): (Info & { readonly id: string }) | undefined;
    namespace(namespace: Tool.Namespace): void;
    add<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(tool: Info<Input, Output>): void;
    /** Updates an existing tool; missing IDs are ignored. */
    update(id: string, update: (tool: Types.Mutable<Info>) => void): void;
    remove(id: string): void;
}
export interface ToolDomain {
    readonly transform: Transform<ToolEditor>;
    readonly reload: () => Promise<void>;
    /** Currently registered tools, after every transform, keyed by effective name. */
    readonly list: () => Promise<readonly (Info & { readonly id: string })[]>;
    readonly hook: Hooks<ToolHooks>;
}
```

来源：`@opencode/plugin@2.0.32` → `dist/promise/plugin.d.ts`

```ts
export interface Context {
    readonly app: App;
    readonly location: Location.Info;
    readonly options: PluginOptions;
    readonly agent: AgentDomain;
    /* ... aisdk / command / credential / event / experimental / integration / mcp /
       model / generate / permission / plugin / provider / reference / rpc /
       session / shell / skill / storage / tool / vcs / websearch / worktree ... */
    readonly tool: ToolDomain;
    /* ... */
}
export type Cleanup = () => Promise<void> | void;
export interface Plugin {
    readonly id: string;
    readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
}
export declare function define(plugin: Plugin): Plugin;
```

> `define` 是 **identity function**（`dist/promise/plugin.js`：`export function define(plugin) { return plugin; }`）
> → 官方双形态写法 `export default { ...Plugin.define({id, setup}), async server() {...} }` 展开后等价于 `{id, setup, server}`。

来源：`@opencode/schema@2.0.32` → `dist/tool.d.ts`（工具的"底层"定义）

```ts
export interface Context {
    readonly sessionID: Session.ID;
    readonly agent: Agent.ID;
    readonly messageID: SessionMessage.ID;
    readonly id: CallID;
    readonly progress: (update: Metadata) => Effect.Effect<void>;
}
export type ValueSchema<A = unknown> = Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema;
export interface Result<Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined> {
    readonly output?: OutputValue<Output>;
    readonly content?: string | ReadonlyArray<Content>;
    readonly metadata?: Metadata;
}
export type Info<Input extends ValueSchema<any> = ..., Output ... > = {
    readonly name: string;
    readonly input: Input;            // JSON Schema / Standard Schema / Effect Schema
    readonly description: string;
    readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>;
    readonly output?: Output;
    readonly options?: Options;        // { namespace?, permission?, codemode?, pinned? }
};
```

### 3.3 `.opencode/tools/*.ts` 的文件自动发现：**已移除**

**负向对照实验**（`proj-t5f/.opencode/tools/legacy-probe.ts`）：

```ts
import { writeFileSync } from "node:fs"
writeFileSync(".../out/TOOLS_DIR_IMPORTED.txt", "imported " + new Date().toISOString())
export default { name: "legacy_probe", description: "...", input: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { content: "LEGACY_TOOL_FILE_EXECUTED" } } }
```

**结果**（`evidence/t5-tool-registration.txt`）：

```
=== markers after boot ===
  (tools-dir marker present? NO)
```

即：**该文件连 import 都没发生**（不是"import 了但形状不对"，而是根本不看这个目录）。
同一次运行里，`.opencode/plugins/` 下的插件**正常加载**（marker 出现、`/api/plugin` 列出 local 插件、工具进了模型的 `tools[]`）。

**对照（正向）**：`evidence/t5-tool-registration.txt`

```
  MARK_TOOL_LIST.txt: ["patch","edit","glob","grep","opencode_session_rename",...,"write","probe_direct","probe_codemode"]
```

→ `ctx.tool.list()` 里能看到插件注册的两个工具。

**文档侧印证**（读文档，非实验）：v2 官方 `https://opencode.ai/v2/docs/plugins` 的 "Discover" 一节只描述
`.opencode/plugins/` 目录（"direct `.ts` and `.js` files and immediate plugin package directories"），
`https://opencode.ai/v2/docs/tools/` 全篇**没有**任何"自定义工具文件目录"的描述。v2 迁移指南明确写：
> "**V1 plugin implementations do not run in V2.**"

### 3.4 ToolContext 三项来源（vteam 现状 → v2）

| vteam 现在用 | v2 对应 | 证据 | vteam 需要怎么改 |
|---|---|---|---|
| `context.sessionID` | ✅ `context.sessionID`（`Session.ID`，`ses_` 前缀不变） | `ctxKeys:["agent","id","messageID","progress","sessionID","signal"]` | 不改 |
| `context.agent` | ✅ `context.agent`（`Agent.ID`） | 同上 | 不改 |
| `context.directory` | ❌ **不存在**。`Tool.Context` 只有 `sessionID / agent / messageID / id / progress`（promise 层再加 `signal`） | 实测 `hasDirectory: false`；`Object.keys(context)` 无 `directory` | 三个替代来源（见下） |

**v2 拿到"工作目录"的三条路（按推荐度排序）**

1. **插件闭包里的 `ctx.location.directory`** —— 最省事。`Context.location` 是 `Location.Info`，含
   `directory` / `project.id` / `project.directory` / `project.canonical`。
   实测值：`pluginLocationDirectory: "/…/spike/proj-t5f"`。
   ⚠️ 官方文档提醒："This is the plugin instance's location, **not** the location of every session it can access."
   → vteam 的 worker 本来就是"一 worker 一 workDir 一 serve"，用 `ctx.location.directory` 与现状语义等价。
2. **`ctx.session.get({ sessionID }).location.directory`** —— 需要按会话取真值时的正解
   （`Session.Info` 有 `location:{directory, workspaceID?}`）。
3. **注入时把目录写进工具入参 / 工具描述** —— 完全可控，但改变了工具调用契约。

**对 `worker/src/browser/browser-tools.ts`（L166-180）的直接影响**：
`resolveScope(ctx)` 里的 `ctx?.directory` 在 v2 恒为 `undefined` → 会退化到
`member-<hash8(directory|agent)>` 分支（`agent` 有值，所以还会落到 member 分支，不会退到 `default`），
**但 scope 不再按会话目录区分**。必须改成上面的 1 或 2。

### 3.5 Code Mode 陷阱（追加发现，**必须回写 T19**）

v2 把工具分成两类：

- **直接工具**：进模型请求的 `tools[]` 数组，模型可以直接 `tool_calls`。
- **Code Mode 工具**：只出现在 system prompt 的 "## Available tools" 目录里，模型必须通过 `execute` 工具写 JS 调用。

**实测对照**（同一份插件注册两个工具，只有 `options` 不同）：

| 工具 | `options` | 出现在模型请求的 `tools[]`？ | 出现在 system 的 Code Mode 目录？ | 模型能直接调？ |
|---|---|---|---|---|
| `probe_direct` | `{ codemode: false }` | ✅ 是 | ❌ 否 | ✅ 能 |
| `probe_codemode` | 不写 `options` | ❌ 否 | ✅ 是（`- probe_codemode (1 tool)`） | ❌ 不能（只能经 `execute`） |

证据（`evidence/t5-tool-registration.txt` / `evidence/t5-recorded-model-requests.jsonl`）：

```
req#8 tools(13) = ['edit','glob','grep','probe_direct','question','read','shell','skill','subagent','webfetch','websearch','write','execute']
```

（不带插件时是 12 个：`['edit','glob','grep','question','read','shell','skill','subagent','webfetch','websearch','write','execute']`；
带插件后新增 `probe_direct` —— `probe_codemode` **不在** `tools[]` 里。）

同一份请求的 system prompt 里，Code Mode 目录只列了 code-mode 工具：

```
- probe_codemode (1 tool)
  - tools.probe_codemode(): Promise<string | null> // code-mode-only probe tool (no options)
```

（`probe_direct` 在同一份 system prompt 里**查不到** —— 它只走 `tools[]` 直连通道。逐条断言：

```
req#2 syslen=8543 probe_direct=False probe_codemode=True
```）

**两种调用路径都实测通过**（mock provider 分别用 `__TOOL__:` 与 `__EXECUTE__:` 触发）：

```
=== markers after prompts ===
  MARK_PROBE_CODEMODE_EXECUTED.txt: {"marker":"PROBE_CODEMODE_OK","ctxKeys":["agent","id","messageID","progress","sessionID","signal"]}
  MARK_PROBE_DIRECT_EXECUTED.txt:   {"marker":"PROBE_DIRECT_OK","input":{"note":"hi"},...,"hasDirectory":false,...}
```

→ **vteam 的三个生成器必须写 `options: { codemode: false }`**，否则模型无法直接调用 `browser` / `git_*` / 自定义工具
（v1 的工具是直接暴露给模型的，语义等价于 `codemode:false`）。

> 补充：`Tool.Options` 的类型是 `BaseOptions & ({codemode?: true; pinned?: boolean} | {codemode: boolean; pinned?: never})`
> → `codemode: false` 是合法取值。

### 3.6 最小可用 v2 工具（≤30 行，已实测被调用）

见 `docs/agent-platform/opencode-v2-spike-results/v2-tool-plugin.ts`。要点：

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "vteam-tools",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "spike_probe",
        description: "…",
        input: { type: "object", properties: { note: { type: "string" } }, required: [], additionalProperties: false },
        options: { codemode: false },              // ← 没有这行，模型只能经 Code Mode 调
        execute: async (input, context) => ({ content: JSON.stringify({ /* … */ }) }),
      })
    })
  },
})
```

事件证据（`evidence/t5-tool-registration.txt`）：

```
session.tool.input.started: {"sessionID":"ses_…","assistantMessageID":"msg_…","id":"call_mock_8","name":"probe_direct"}
session.tool.input.ended:   {"…","id":"call_mock_8","text":"{\"note\":\"hi\"}"}
session.tool.called:         {"…","id":"call_mock_8","input":{"note":"hi"},"executed":false}
session.tool.success:        {"…","id":"call_mock_8","content":[{"type":"text","text":"{\"marker\":\"PROBE_DIRECT_OK\",…}"}]}
```

→ `session.tool.success` 的 `content` 是**数组**（`[{type:"text",text}]`），不是 v1 的字符串 —— 与计划附录 B 的记载一致。

### 3.7 双形态插件模块（v1 + v2 一份产物）

**实验（`evidence/t5-dual-entrypoint.txt`）**：同一个 default export 同时带 `setup` 与 `server`：

```
=== markers ===
  D3_C1_SETUP.txt: setup called      ← 纯 v2（只有 setup）
  D3_C2_SETUP.txt: setup called      ← 纯 v2（动态 import 写法）
  D3_D1_SETUP.txt: setup called      ← 双形态：v2 调了 setup
  D3_D2_SETUP.txt: setup called      ← server 是非函数属性：也正常
=== /api/plugin non-builtin ===
[('c1-static','local'),('c2-dynamic','local'),('d1-dual','local'),('d2-dual','local')]
```

→ **v2 认 `{id, setup, server}` 这种形状，并且完全忽略 `server`**（`D3_D1_SERVER.txt` 不存在）。

**v1 侧（`evidence/t5-dual-v1.txt`，二进制 `1.18.32`）**：

```
--- v1 GET /config (plugin list) ---
plugin = ['file:///…/dual/proj/.opencode/plugins/dual-tools.ts']
…
"parts":[
  {"type":"tool","callID":"call_mock_66","tool":"dual_probe",
   "state":{"status":"completed","input":{"n":"1"},"output":"DUAL_V1_OK {\"n\":\"1\"}",…}}]
---
markers ---
  V1_DUAL_SERVER.txt: v1 server() called
  V1_DUAL_SETUP.txt: v2 setup called
  V1_DUAL_TOOL_EXECUTED.txt: v1 tool executed {"n":"1"}
```

→ v1 成功加载了 `.opencode/plugins/dual-tools.ts`、调用了 `server()`、并让模型**真正调用了 v1 形态的工具**（返回字符串）。

**两个必须注意的细节**

1. **v1 也会尝试调用 `setup(ctx)`**（`V1_DUAL_SETUP.txt` 存在），此时 `ctx.tool` 不存在 → v2 分支会抛错。
   → 双形态模块的 v2 分支必须**防呆**：`if (!ctx?.tool?.transform) return`。
2. **v1 的 `server()` 里 `await import("@opencode-ai/plugin")` 不需要 node_modules**：
   实测 scratch 项目里**没有** `node_modules`（`npm install` 没成功），但 v1 二进制自带该模块（`grep '@opencode-ai/plugin'` 在 v1 二进制里命中 3 次）→ import 照样解析成功。
   → vteam 生成物**不必**依赖 `.opencode/package.json` 才能被解析；该 package.json 仍应保留（用于 `tsc --noEmit` 编译期检查，见 T19 验收标准 4）。

**上游佐证**：本机已有一个按同样思路做的 OmO v2 入口
（`/Users/mac/.local/share/omo-v2/plugin/index.ts`）：

```ts
// Local OpenCode V2 plugin entrypoint for oh-my-openagent.
// Built from PR #8626 (dual-host: { id, server, setup }).
import plugin from "../oh-my-opencode/dist/index.js"
export default plugin
export const omoPlugin = (plugin as { server: unknown }).server
export const omoPluginV2 = { id: (plugin as { id: string }).id, setup: (plugin as { setup: unknown }).setup }
```

→ 现实世界里已经有人在做同一件事，双形态这条路是**被上游认可的**。

### 3.8 T5 复现命令

```bash
# 1) 放一个探针插件（import 时写 marker）
mkdir -p $PROJ/.opencode/plugins
cat > $PROJ/.opencode/plugins/probe.ts <<'EOF'
import { writeFileSync } from "node:fs"
writeFileSync("/tmp/PLUGIN_IMPORTED.txt", "imported")
export default { id: "probe", async setup(ctx) { /* ctx.tool.transform(...) */ } }
EOF

# 2) 起 serve（--print-logs --log-level debug 才会打出 "loading plugin" 行）
cd $PROJ && opencode serve --port 45982 --hostname 127.0.0.1 --print-logs --log-level debug &

# 3) ★ 必须先让 location 起来（建一个会话），插件才会被发现
curl -s -u opencode:spikepass -X POST -H 'content-type: application/json' \
  -d '{"location":{"directory":"'"$PWD"'"}}' http://127.0.0.1:45982/api/session

# 4) 看发现日志
grep 'loading plugin' serve.log
#   msg="loading plugin" id=…/.opencode/plugins/probe.ts entrypoint=file://…

# 5) 验证工具可被模型调用（见 repro.sh 的 T5 段）
```

> **踩坑记录（很重要）**：
> - v2 的插件发现是**按 location 惰性触发**的：只 `GET /api/plugin` 之前**没有**任何 location 活动时，返回的是**空数组**，
>   看起来像"插件没被加载"。必须**先建会话 / 发 prompt**，再检查。
> - 同理，插件的 `setup` 是**异步**完成的：建会话后立刻检查 marker 会得到假阴性（本次 spike 第一次就踩了）。
>   正确做法：建会话 → 发一条 prompt → 等 ≥6s → 再检查。
> - `--print-logs --log-level debug` 是观察插件加载过程的**唯一可靠手段**（`serve.log` 里的 `msg="loading plugin"` 行）。

### 3.9 对 T19 / D8 的结论

- 三个生成器（`custom-tool.ts` / `git-tools.ts` / `browser-tools.ts`）的**产物形态必须改**：
  从"`.opencode/tools/<file>.ts` 导出 `tool({...})`"改成"`.opencode/plugins/<file>.ts` 导出 `Plugin.define({id, setup})`，在 `setup` 里 `ctx.tool.transform(...)` 注册"。
  - 入参：Zod → **JSON Schema**。
  - 返回值：`string` → **`{ content }`**（`content` 可为 `string` 或 `[{type:"text",text}]` 数组）。
  - **必须加 `options: { codemode: false }`**（否则模型只能经 Code Mode 调，与 v1 行为不等价）。
  - `browser-tools.ts` 的 `context.directory` **必须换源**（§3.4）。
  - 工具名规则不变：默认导出 = 文件名；具名导出 = `<文件名>_<导出名>`（v2 里工具名由 `editor.add({name})` 显式给，映射逻辑由生成器自己写）。
- **双形态模块可行**（§3.7），过渡期一份产物两版通用；但 v2 分支要防呆。
- `.opencode/package.json` 仍建议保留并锁 `@opencode/plugin@2.0.32` —— 目的不是运行时解析（宿主已内置），
  而是**编译期检查**（T19 验收标准 4 的 `tsc --noEmit`）。

---

## 4. T6 — `--pure` 等价物　**判定：无完全等价物；有可落地替代方案**

v1 的 `opencode serve --pure` 会禁掉外部插件与 AGENTS.md 注入（v1 时代实测 ≈1900 input tokens vs 非 pure ≈7601）。
v2 **删掉了这个 flag**（传 `--pure` → CLI exit 1）。

### 4.1 候选矩阵（全部为**实验实测**）

污染基线的构造（全部在隔离的 `XDG_CONFIG_HOME` 里，**不碰用户真实配置**）：

```
$XDG/.config/opencode/opencode.jsonc   -> { ..., "plugins": ["./plugins/global-spike.ts"] }
$XDG/.config/opencode/plugins/global-spike.ts
        -> Plugin.define({ id: "global-spike", setup(ctx){ ctx.session.hook("context", e =>
             e.system.push({type:"text",text:"GLOBAL_PLUGIN_SYSTEM_MARKER …"})) } })
$XDG/.config/opencode/AGENTS.md         -> "GLOBAL_AGENTS_MARKER :: …"
$PROJ/AGENTS.md                         -> "PROJECT_AGENTS_MARKER :: …"
$PROJ/.opencode/plugins/vteam-plugin.ts -> 注入 "VTEAM_PLUGIN_SYSTEM_MARKER"
```

观测口径：
- **插件**：`GET /api/plugin` 的非 builtin 条目 + 最终请求 system 里有没有 `GLOBAL_PLUGIN_SYSTEM_MARKER`。
- **AGENTS.md**：最终请求 system 里有没有 `GLOBAL_AGENTS_MARKER` / `PROJECT_AGENTS_MARKER`。

| # | 候选 | 抑制全局插件？ | 抑制全局 AGENTS.md？ | 抑制项目 AGENTS.md？ | 副作用 / 结论 | 证据 |
|---|---|---|---|---|---|---|
| T6-A | **基线**：项目配置不写 `plugins` | ❌ 否 | ❌ 否 | ❌ 否 | — | `t6-matrix-round2.txt` |
| T6-B | 项目配置 `"plugins": []` | ❌ **否** | ❌ 否 | ❌ 否 | **无效**。v2 的 `plugins` 数组在多份配置文件之间是**合并**而不是替换，空数组是 no-op | 同上 |
| T6-C | 项目配置 `"plugins": ["-*"]` | ✅ 是 | — | — | ❌ **不可用**。`GET /api/plugin` 只剩 2 个（`opencode.config.policy` / `opencode.provider.opencode` 这类"忽略移除"的内置插件），`GET /api/agent` = `[]`，`GET /api/model` = `[]`，会话直接失败：`Agent not found: "build"` | `t6-matrix-round2.txt` + `t6-matrix-round3.txt`（T6-K：`["-*","opencode.agent",…]` 也救不回来，只剩 41 个插件且无模型请求） |
| T6-D | 项目配置 `"plugins": ["-global-spike"]` | ✅ **是（精确到 ID）** | ❌ 否 | ❌ 否 | ✅ **可用**。内置插件不受影响（88 个），vteam 自己的插件照常加载 | `t6-matrix-round3.txt`（T6-J：`GLOBAL_PLUGIN=False` 且 `VTEAM_PLUGIN=True`） |
| T6-E | 项目配置 `"instructions": []` | ❌ 否 | ❌ 否 | ❌ 否 | **无效**。`instructions` 只能**追加**额外指令文件，不能关掉 AGENTS.md 发现 | `t6-matrix-round2.txt` |
| T6-F | 环境变量 `OPENCODE_DISABLE_PROJECT_CONFIG=1` | ❌ 否 | ❌ **否** | ✅ **是** | ⚠️ **副作用大**：它同时禁掉**项目 `opencode.json`**（T6-M：项目里的 `plugins` 键被忽略 → 全局插件又回来了）→ vteam 不能用（会连自己注入的项目配置一起丢掉） | `t6-matrix-round2.txt` / `t6-matrix-round3.txt`（T6-M） |
| T6-G | `OPENCODE_CONFIG=<file>` | ❌ **否**（是**追加**，不是替换） | ❌ 否 | ❌ 否 | 全局配置照样被读（`global-spike` + 全局 AGENTS.md 都还在）。**不能用来隔离全局配置** | `t6-matrix-round3.txt`（T6-G'） |
| T6-H | `OPENCODE_CONFIG_CONTENT=<json>` | ❌ 同上 | ❌ 否 | ❌ 否 | 同上 | `t6-matrix-round3.txt`（T6-H'） |
| T6-I | **隔离 `XDG_CONFIG_HOME`（+ `HOME`），全局配置目录不存在** | ✅ **是** | ✅ **是** | ❌ 否（仍从工作目录发现） | ✅ **唯一可靠手段**。副作用：vteam 自己注入的全局配置（provider/凭据）也必须搬到隔离目录 | `t6-matrix-round2.txt`（T6-I）+ `t6-matrix-round4-final-recipe.txt`（T6-P） |
| T6-K | `"plugins": ["-*","opencode.agent","opencode.prompt.*","opencode.provider.*"]` | ✅ 是 | — | — | ❌ **救不回来**。`-*` 之后的"按 ID 重新启用"对内置插件无效（剩 41 个、无模型请求） | `t6-matrix-round3.txt` |
| T6-L | `"plugins": ["-*","opencode.*"]` | ✅ 是 | ❌ 否 | ❌ 否 | ⚠️ 内置 `opencode.*` 被恢复（88 个）、第三方全关，**但 vteam 自己的插件也被关掉**，且**无法再打开**（见 T6-N/Q/R） | `t6-matrix-round3.txt` |
| T6-N | 隔离 XDG + `"plugins": ["-*","opencode.*","./.opencode/plugins/vteam-plugin.ts"]` | ✅ 是 | ✅ 是 | ❌ 否 | ❌ **自己的插件仍然起不来**。路径条目排在 `-*` 之后**不能**重新启用它 | `t6-matrix-round4-final-recipe.txt` |
| T6-P | 隔离 XDG，**不写** `plugins` 键 | ✅ 是 | ✅ 是 | ❌ 否 | ✅ **推荐形态**：全局插件 / 全局 AGENTS.md 都出局，vteam 自己的插件（`.opencode/plugins/` 自动发现）正常加载，模型正常 | `t6-matrix-round4-final-recipe.txt` |

**`experimental` 键的实测结论**：v2 的 `experimental` 对象只有三个字段
（`@opencode/schema@2.0.32` → `dist/config/experimental.d.ts`）：

```ts
readonly portable_shell_scanner: Schema.Optional<Schema.Boolean>;
readonly subagent_depth: Schema.Optional<Schema.Int>;
readonly policies: Schema.Optional<Schema.Array<…>>;
```

→ **没有任何插件/AGENTS.md 开关**，候选 3 排除。

### 4.2 T6 结论

**v2 没有 `--pure` 的等价物**，但有一个可落地的等价组合：

> **"隔离配置发现路径" = 用 worker 自己的 `HOME` + `XDG_CONFIG_HOME` 起 serve**，
> 这样用户的全局 `opencode.json(c)`、全局 `plugins/`、全局 `AGENTS.md`、全局 `skills/` 全部不在作用域内；
> **vteam 自己的配置全部显式写进（隔离的）全局目录 + 项目 `opencode.json` + 项目 `.opencode/plugins/`**。
> 项目工作目录里**不要放 `AGENTS.md`**。

可选的补强（当隔离目录里仍可能混进别的插件时）：在项目 `opencode.json` 里用
`"plugins": ["-<具体插件ID>", ...]` 精确禁用**已知的**插件 ID。
⚠️ **不要用 `"plugins": ["-*"]` / `["-*","opencode.*"]`**：
它们会把内置的 `opencode.agent` / `opencode.provider.*` 一起关掉 → `Agent not found: "build"` → 会话直接失败；
而且 `-*` 之后**无法**把 vteam 自己的插件加回来。

### 4.3 与 v1 `--pure` 语义的差异（必须写进计划）

| v1 `--pure` | v2 隔离方案 | 差异 |
|---|---|---|
| 禁外部插件 | 全局插件不在作用域 + 项目配置显式声明 | v2 方案更彻底（连全局 skills/agents/commands 一起隔离） |
| 禁 AGENTS.md 注入 | 全局 AGENTS.md 不在作用域；**项目目录里的 AGENTS.md 仍会被发现** | ⚠️ **v1 `--pure` 禁的是全部 AGENTS.md**，v2 隔离方案只禁全局那份 |
| — | 项目 AGENTS.md 的唯一开关是 `OPENCODE_DISABLE_PROJECT_CONFIG=1`，但它会连**项目 `opencode.json`** 一起禁掉 → 不可用 | 结论：**vteam 必须保证工作目录里没有 AGENTS.md** |

### 4.4 对现有 OmO（`oh-my-openagent`）集成的影响

现状（`worker/Dockerfile` + `worker/src/resources/injector.ts`）：

- Dockerfile 用 `bunx oh-my-openagent@latest install --platform=opencode …` 安装，
  失败兜底时直接写 **`/root/.config/opencode/opencode.json`**（**全局**目录）：
  ```dockerfile
  printf '{\n  "plugin": [\n    "%s"\n  ]\n}' "${OMO_INSTALL_SPEC}" \
    | tee /root/.config/opencode/opencode.json > /root/.config/opencode/tui.json
  ```
- `injector.ts` 的 `injectOmoPlugin()` 也会把同一条目写进 `<workDir>/opencode.json`（v1 键 `plugin`）。

v2 下的三个问题：

1. **v1 插件实现不会在 v2 运行**（官方迁移指南明确警告："V1 plugin implementations do not run in V2.
   Moving a file or renaming its config entry is not enough."）。
   → OmO 必须提供 **v2 入口**（`{id, setup}`）。本机已有一个按此思路构建的版本
   （`/Users/mac/.local/share/omo-v2/plugin/index.ts`，见 §3.7），说明上游已在做。
2. **隔离 XDG 后，全局目录里的 OmO 条目会失效** → OmO 条目必须搬进
   **项目 `opencode.json` 的 `plugins`**（或搬进隔离的全局目录）。
3. **`plugin` → `plugins`**：v2 虽会归一化，但计划 T15 明确要求写新键；
   且 v2 的 `plugins` 数组**跨配置合并**、**顺序即优先级**（`"-"` 前缀禁用、`"*"` 全开），
   OmO 条目与 vteam 自己的插件条目的**相对顺序**要显式设计。

**建议（写进 T15 / T16）**

| 位置 | 内容 |
|---|---|
| 隔离的 `$XDG_CONFIG_HOME/opencode/opencode.json` | 只放 vteam 自己注入的 provider/凭据（承接 `model-credential-injector.ts`） |
| 项目 `<workDir>/opencode.json` | `agents`（含 `system`）、`mcp.servers`、`providers`、`plugins`（OmO 条目 + vteam 自己的插件条目） |
| 项目 `<workDir>/.opencode/plugins/*.ts` | vteam 生成的工具插件（双形态） |
| 项目 `<workDir>/AGENTS.md` | **不存在**（vteam 不生成，且要保证用户仓库里的 AGENTS.md 不落在 workDir 根上） |

### 4.5 残留风险（无法用配置消除）

- **系统/托管配置目录不受 `XDG_CONFIG_HOME` 控制**：
  macOS = `/Library/Application Support/opencode`，Linux = `/etc/opencode`。
  本机实测该目录**不存在**（`ls "/Library/Application Support/opencode"` → No such file or directory），
  但 v2 serve **会 watch 它**（serve 日志：`watcher subscribe path="/Library/Application Support" type=entries`）。
  → 在被 MDM 托管的机器上，机器级插件仍可能进入作用域。**规避手段只有 `policies`**（`{action:"plugin.use",…}`），
  而 policies 属于托管配置，项目配置覆盖不了。
- **`config.updated` / `policies` 优先级**：官方文档写明托管配置的优先级最高，users/projects 无法覆盖。

### 4.6 T6 复现命令

矩阵脚本在 `evidence/t6-matrix-round2.txt` / `round3` / `round4` 三份原始输出里；核心骨架：

```bash
# 污染基线（隔离目录，不动用户真实配置）
XDG=$SCRATCH/xdg
mkdir -p $XDG/.config/opencode/plugins
printf 'GLOBAL_AGENTS_MARKER :: …\n' > $XDG/.config/opencode/AGENTS.md
cat > $XDG/.config/opencode/opencode.jsonc <<'EOF'
{ "plugins": ["./plugins/global-spike.ts"] }
EOF
cat > $XDG/.config/opencode/plugins/global-spike.ts <<'EOF'
import { Plugin } from "@opencode/plugin"
export default Plugin.define({ id: "global-spike", async setup(ctx) {
  await ctx.session.hook("context", (e) => e.system.push({ type: "text", text: "GLOBAL_PLUGIN_SYSTEM_MARKER" })) } })
EOF
printf 'PROJECT_AGENTS_MARKER :: …\n' > $PROJ/AGENTS.md

# 起 serve（隔离 HOME + XDG_CONFIG_HOME）
HOME=$XDG XDG_CONFIG_HOME=$XDG/.config … opencode serve --port 45992 --hostname 127.0.0.1 &

# 观测
curl -s -u opencode:spikepass http://127.0.0.1:45992/api/plugin
# → 找 source.type != "builtin" 的条目
# 模型请求 system 里 grep GLOBAL_PLUGIN_SYSTEM_MARKER / GLOBAL_AGENTS_MARKER / PROJECT_AGENTS_MARKER
```

---

## 5. 文档 / 发布类型 与 实机行为的冲突清单

| # | 冲突点 | 文档/类型说 | 实机（2.0.28）说 | 处置 |
|---|---|---|---|---|
| C1 | 自定义工具的注册方式 | 计划 §2.6 写"`input` 从 Zod 改 JSON Schema、返回值 string→`{content}`"（**方向对**），但暗示"文件自动发现"仍在（Q2） | **文件自动发现已移除**；只能经 `ctx.tool.transform` | 以实机为准，Q2 关闭为"已移除" |
| C2 | 插件工具的暴露方式 | 官方 `https://opencode.ai/v2/docs/build/plugins` 的工具示例里没有提 `codemode` | 插件工具**默认只能经 Code Mode 调用**，必须 `options:{codemode:false}` | 文档缺这一条，**必须写进 T19 的模板** |
| C3 | `GET /api/plugin` 的稳定性 | 计划把 `GET /api/plugin` 当成 T6 的观测口 | 该端点是 **location 作用域**且**惰性**：location 没起来时返回空数组；插件 `setup` 是异步的。**实测还观察到同一次运行里它有时返回 89 条（含 local 插件）、有时返回 `total=0`，而插件明明已加载**（serve 日志有 `loading plugin`、工具也已进模型的 `tools[]`）——所以它**不能作为"插件是否加载"的唯一判据** | 观测"插件是否加载"请用 **serve 日志的 `msg="loading plugin"` 行** + **工具是否出现在模型请求的 `tools[]`**；`/api/plugin` 只作辅助。T6 矩阵里两个口径（`/api/plugin` 与 system 里的 marker）**互相印证、结论一致** |
| C4 | `options.codemode` 的类型 | 类型里 `codemode?: true`（单分支） | 实机接受 `codemode: false` | 以发布类型为准（第二分支 `codemode: boolean` 允许 false） |
| C5 | `Tool.Result.content` | 计划写"返回值从 string 改 `{content}`" | 类型是 `content?: string \| ReadonlyArray<Content>`（**两种都合法**），事件侧 `session.tool.success.content` 是**数组** | T19 生成器统一用 `{content: "字符串"}` 即可；渲染层按数组处理 |
| C6 | 双形态插件 | 官方迁移指南给了 `{...Plugin.define(...), server()}` 的写法 | v2 认这个形状并忽略 `server()`；但 **v1 也会调 `setup`** | v2 分支必须防呆 |
| C7 | `AGENTS.md` 与 `instructions` | 官方 instructions 文档：`instructions` 是"**追加**" | 实测 `instructions: []` **不会**关掉 AGENTS.md | 与文档一致，但计划里"用 instructions 抑制 AGENTS.md"的思路不成立 |
| C8 | `plugins` 数组的跨配置语义 | 官方 plugins 文档："Plugin arrays from applicable config files are applied from lowest to highest precedence **instead of replacing one another**" | 实测一致（`plugins: []` 不替换全局列表） | 计划 T15 写 `plugins` 时要意识到是**合并**语义 |

---

## 6. 仍未解决的问题 + 关闭它需要的命令

| # | 未决 | 状态 | 关闭命令 / 需要什么 |
|---|---|---|---|
| U1 | 计划 §10 **Q1**（`agents.<name>.system` 是否进最终模型请求） | ✅ **已关闭**：进 | 见 §2.1 |
| U2 | 计划 §10 **Q2**（`.opencode/tools/*.ts` 文件自动发现） | ✅ **已关闭**：**已移除** | 见 §3.3 |
| U3 | 计划 §10 **Q3**（`--pure` 等价物） | ✅ **已关闭**：无等价物，替代方案见 §4.2 | 见 §4.1 / §4.6 |
| U4 | 计划 §10 **Q11**（`delivery:"steer"` 无 run 时行为） | ✅ **已关闭**：立即执行 | 见 §2.2 |
| U5 | 计划 §10 **Q13**（v2 是否实际发 v1 legacy 事件） | ⚠️ **未正式关闭**。本 spike 抓到的 3 个会话的完整 SSE 帧里 **`message.updated` / `message.part.updated` / `message.part.delta` 命中数均为 0**（`server.connected` 命中 1，v2 事件 24 种），但这只是单次样本 | 复现命令：<br>`grep -c 'message.part.delta' evidence/t4-sse-frames.log` → 实测 0；<br>建议在 T11/T12 的契约测试里固化这条断言（跑满一轮含工具调用的会话再断言） |
| U6 | v2 是否发 `CLAUDE.md` 回退 | 附录 C 写"只发现 `AGENTS.md`"，本 spike **未实测** | 复现命令：<br>在项目目录放一个 `CLAUDE.md`（含 `CLAUDE_MARKER`）和 `AGENTS.md`（含 `AGENTS_MARKER`），跑一次 prompt，<br>`grep -o 'CLAUDE_MARKER\|AGENTS_MARKER' requests.jsonl` → 期望只出现 `AGENTS_MARKER` |
| U7 | `provider.package = "aisdk:@ai-sdk/openai-compatible"` 这种写法在 v2 是否等价 | 本 spike 只验证了 `"@opencode/ai/providers/openai-compatible"` | 复现命令：<br>把 mock 配置里的 `package` 改成 `"aisdk:@ai-sdk/openai-compatible"`，重启 serve，<br>`curl -s -u opencode:spikepash http://127.0.0.1:45980/api/model \| grep -q spike-model` → 期望命中 |
| U8 | vteam worker 镜像里 OmO 的 **v2 入口**是否可用 | 只验证了"本机已有一个 dual-host 构建"，没验证 vteam Dockerfile 装的那份 | 复现命令（在 worker 镜像里）：<br>`node -e 'const p=require("oh-my-openagent");console.log(Object.keys(p.default\|\|p))'` → 期望能看到 `id` 与 `setup`；<br>再在 v2 serve 下 `GET /api/plugin` 看 `oh-my-openagent` 是否 `state.status==="active"` |
| U9 | 系统/托管配置目录（`/etc/opencode`、`/Library/Application Support/opencode`）里的插件能否被压制 | 本机该目录不存在，未实测 | 复现命令：<br>`sudo mkdir -p /etc/opencode/plugins && sudo cp probe.ts /etc/opencode/plugins/` → 起 serve → `GET /api/plugin` 看是否出现；<br>能出现则只能用 `policies` 压 |

---

## 7. 复现物料清单

```
docs/agent-platform/opencode-v2-spike-results/
├── README.md                      # 本目录的用途与最短复现路径
├── repro.sh                       # 一键复现 T4 + T5 的全部断言（无凭据）
├── mock-provider.mjs              # 无凭据 OpenAI 兼容 mock provider（会落盘最终请求体）
├── mock-opencode.json             # mock provider + 角色 agent 的配置样例
├── v2-tool-plugin.ts              # 最小 v2 工具插件（≤30 行，已实测被模型调用）
├── dual-shape-plugin.ts           # v1+v2 双形态插件模块（已在 1.18.32 与 2.0.28 双侧实测）
└── evidence/
    ├── t4-role-prompt.txt         # T4 三种激活方式的逐条结果 + 会话消息 + agent.selected 事件
    ├── t4-plugin-hooks.txt        # T4 prompt hook / context hook 的效果
    ├── t4-sse-frames.log          # T4 的 SSE 原始帧
    ├── t5-tool-registration.txt   # T5 工具注册/调用全过程 + ToolContext 实测
    ├── t5-sse-frames.log          # T5 的 SSE 原始帧（含 session.tool.* 事件）
    ├── t5-recorded-model-requests.jsonl  # mock 落盘的最终模型请求体
    ├── t5-published-types.txt     # @opencode/plugin & @opencode/schema 2.0.32 的类型原文
    ├── t5-dual-entrypoint.txt     # v2 认哪种 default export 形状
    ├── t5-dual-v1.txt             # v1 1.18.32 侧的同一份双形态模块
    ├── t6-matrix-round2.txt       # T6 候选矩阵（第一轮）
    ├── t6-matrix-round3.txt       # T6 候选矩阵（第二轮：OPENCODE_CONFIG / -id / -* 等）
    └── t6-matrix-round4-final-recipe.txt  # T6 最终推荐方案的验证
```

---

## 8. 清理确认

本 spike 启动过的所有 opencode 进程（mock provider + 各端口的 serve）均已终止；
**未修改** `~/.config/opencode/opencode.jsonc`（所有污染基线都建在隔离的 `XDG_CONFIG_HOME` 里）、
**未修改**任何产品代码、**未**执行任何 git 写操作。
