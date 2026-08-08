# Phase 4 F3 缺陷复审证据 — MAJOR-1/MAJOR-2/MINOR-3 修复验证

> 日期：2026-08-08 | 执行：API 链路（curl）+ serve 34975 直查 | 环境：server :3000（已重启加载 F3 修复）+ worker w_local_1（online，port 34975）
> 复审依据：F3 QA 证据 `.omo/evidence/phase4-f3-qa.md` + `.omo/plans/phase4-worker-opencode.md` D8
> 成本：真实 opencode 调用 **3 次**（m_37/m_38/m_40，≤3 合规）

## 0. 执行摘要

| F3 缺陷 | 复审结果 | 说明 |
|---|---|---|
| MAJOR-1 二次 @ 复用会话回复不回流 | ⚠️ **部分修复** | 首个复用 dispatch（m_37）仍 120s 超时 + agent.error（不再静默失败）；**后续复用**（m_38/m_40）✅ 成功回流 m_39/m_41。根因：poll 首轮基线取到本次 assistant 占位消息 |
| MAJOR-2 产出物自动归档不可用 | ✅ **修复生效** | poll 路径携带 artifacts（extractArtifacts 验证通过）；m_41 严格契约声明被提取但因 type=markdown 非枚举被过滤（契约设计）；旁路 type=text 归档成功 |
| MINOR-3 模型污染仓库目录 | ⚠️ **部分生效** | 新会话工作目录 `/tmp/keta-worker-tasks/tasks/t_0000000006` 已创建 ✓；**复用会话沿用 serve 原 directory**（m_39 tool workdir=/data/git-project/aiagents/worker 实证）→ 复用场景隔离失效 |
| 首字延迟（D8 ≤15s） | ⚠️ 不稳定 | m_38 首字 17687ms（>15s，多轮 tool 调用）；m_40 首字 **4205ms**（✓） |
| 回归：首次 @ 链路 | ✅ 通过 | m_39/m_41 落库 + chat.message.new + emitFinal |

## 1. 环境确认

- GET /workers → `w_local_1` online，capabilities.port=34975，opencode 1.18.15（F3 基线不变）
- serve 34975 会话列表含复用目标 `ses_022993f15ffeHJrv0wjnbYwJTW`（a_product，directory=/data/git-project/aiagents/worker）
- 遗留任务 t_0000000006（in_progress，team=[a_architect,a_product]），群聊频道 c_0000000012

## 2. MAJOR-1 复审：二次 @ 复用会话回流（核心）

### 2.1 调用序列（本次复审）

| 消息 | 时间 | 触发 | 结果 |
|---|---|---|---|
| m_37 | 02:33:28 | @a_product「用一句话总结」 | ❌ **120s 超时** + agent.error（ev_0000000089 dispatch_timeout） |
| m_38 | 02:40:16 | @a_product「撰写复审验收清单文档」 | ✅ 回流 m_39（02:40:40 落库，parts 14） |
| m_40 | 02:46:02 | @a_product「输出严格契约格式产出物声明」 | ✅ 回流 m_41（02:46:07 落库，首字 4205ms） |

**serve 侧证据**（GET /session/ses_022993f15ffe.../message）：
- m_37 的回复 `msg_fdd806b0b00151x...` **已存在**且含 `step-finish(reason=stop)`，text time.start=02:33:32.034 → **serve 侧 4 秒即完成**，但 server poll 120s 未检测到

### 2.2 MAJOR-1 残留根因（新缺陷，非 F3 原根因）

F3 原根因（全量 getMessages 命中历史 step-finish + 幂等跳过）已被 `pollCursors` 增量检测修复。**但发现新缺陷**：

```
m_37 时序：
02:33:28.529  user 消息 msg_fdd806ad 创建（prompt_async 写入）
02:33:28.587  assistant 占位消息 msg_fdd806b0 创建（parts=[]，仅晚 58ms）
02:33:28.6xx  pollForCompletion 首轮 getMessages（dispatch 在 promptAsync 之后启动）
              → 首轮基线 cursor = lastId = msg_fdd806b0（assistant 占位，parts=[]）
02:33:28.7+   后续每轮 fresh = messagesAfter(messages, msg_fdd806b0) = []（永远空）
02:33:32.79   msg_fdd806b0 填充完成（step-finish stop）→ 但 cursor 已越过它
02:35:28      watchdog 120s 超时 → agent.error
```

**根因**：`pollForCompletion`（worker-dispatcher.ts:692）的**首轮基线在 promptAsync 之后**才取 `lastId`，而此时本次 dispatch 的 assistant 占位消息（parts=[]）已存在 → cursor 直接落在"本次回复的占位消息"上 → `messagesAfter` 永远返回空 → 永不命中 step-finish。与 F3 原根因（命中**历史** step-finish）表现不同：现在是**基线取到未来的占位消息**。

**为什么 m_38/m_40 成功（碰巧）**：m_37 超时后 `pollCursors` 残留 cursor=msg_fdd806b0（已完整）；m_38 dispatch 时首轮基线=该 cursor → 本次新消息（user prompt + assistant 回复）都在其后 → 正常命中。**不是修复真正生效，而是 cursor 恰好停在正确位置**。

**修复方向（记录，未改代码）**：
- 首轮基线应在 **promptAsync 之前**取（dispatch 时先记录基线，再发 prompt）；
- 或基线取"本次 user prompt 消息 id"而非"最后一条消息 id"；
- 或对首轮基线消息 `parts=[]` 的占位状态做防御（基线只记录不含本次占位）。

**对用户影响**：二次 @ 复用场景**不再是静默失败**（F3 无任何提示 → 现广播 agent.error dispatch_timeout，用户可见重试提示）——这是改进；但回复本身仍不回流（首个复用 dispatch 场景），D3 能力未完全达成。

## 3. MAJOR-2 复审：产出物自动归档

### 3.1 poll 路径携带 artifacts（修复生效）

- 代码确认：`handlePolledCompletion`（worker-dispatcher.ts:775）已携带 `artifacts: extractArtifacts(text)`；`handleTaskCompleted`（:615-636）循环 `artifactsService.onArtifactSubmitted`，invalid 不抛错仅 warn
- **extractArtifacts 实测**（node 调用编译产物）：
  - m_41 严格格式 `<artifact type="markdown" title="复审结论">...` → 提取结果为 **[]**（type=markdown 非枚举 → validateArtifactDeclaration 过滤，**契约设计**：type 限 text/doc/file）
  - 合法格式 `<artifact type="text" title="合法声明">正文</artifact>` → ✅ 提取 `[{type:text,title:合法声明,content:正文}]`
  - 无声明 → []（正常）
- **旁路归档链路验证**：POST /tasks/t_0000000006/artifacts `{type:text,title:...,content:...}` → `{status:"archived"}`，art_0000000009 落库 → 归档链路通

### 3.2 结论

MAJOR-2 修复**生效**：poll 路径产出物声明不再永久丢失——提取、校验、归档三步链路完整。m_41 未归档是**模型声明 type=markdown 违反契约枚举**（模型应声明 text/doc/file），非代码缺陷。API 层端到端验证受"模型不按契约声明"限制，spec 已覆盖（worker-dispatcher.spec.ts:1078/1232）。

## 4. MINOR-3 复审：工作目录隔离

- ✅ 新会话 dispatch：`/tmp/keta-worker-tasks/tasks/t_0000000006/` 已创建（02:33，ensureTaskWorkDir mkdir -p）
- ⚠️ **复用会话隔离失效**：m_39 的 tool part `workdir=/data/git-project/aiagents/worker`（bash 调用实证）→ serve 复用会话**沿用创建时 directory**（GET /session 显示 directory=/data/git-project/aiagents/worker），promptAsync 的 directory 参数**对已存在会话不生效** → 复用场景模型仍在仓库内工作目录执行命令
- ✅ 仓库根零污染：git status 无模型产物文件（本次 3 次调用的新未跟踪文件均为 .omo/ 证据与 F3 遗留截图）

## 5. 首字延迟

| 调用 | 首字延迟 | 判定 |
|---|---|---|
| m_38（多轮 tool 调用：ls/grep/read） | **17687ms** | ❌ >15s（模型 3 轮工具调用耗时） |
| m_40（单轮直接回复） | **4205ms** | ✅ ≤15s |

> 首字延迟主要由模型行为（是否多轮 tool 调用）决定，poll 检测本身在占位消息出现后立即记录（hasTextPart 检测）；D8 通过线对复杂任务仍偏紧。

## 6. 回归验证（首次 @ 链路）

- m_39/m_41 落库：senderType=agent、content{text,parts}、status=sent ✓
- SSE 事件序列：agent.loading(thinking→operating) → chat.message.new（channel scope）✓
- emitFinal 正常；无重复落库（completedSessions 幂等）✓

## 7. 复审结论

| 项 | 判定 |
|---|---|
| MAJOR-1 二次 @ 复用回流 | ⚠️ 部分修复：非静默失败（agent.error 可感知）✅；首个复用 dispatch 回复仍不回流 ❌（新根因：poll 基线取到 assistant 占位） |
| MAJOR-2 产出物归档 | ✅ 修复生效（链路完整，模型契约格式问题非代码缺陷） |
| MINOR-3 工作目录隔离 | ⚠️ 部分生效（新会话 ✓；复用会话沿用 serve 原 directory ✗） |
| 首字延迟 ≤15s | ⚠️ 不稳定（4205ms ✓ / 17687ms ✗，视模型 tool 调用而定） |

**F4 前建议**：① poll 基线移至 promptAsync 之前（修 MAJOR-1 残留）；② 复用会话的工作目录隔离需在 serve 层解决（复用会话 directory 不可变，或换用新会话/会话重建）；③ 首字延迟优化依赖模型行为（非 poll 代码可控）。

> 遗留：测试数据（任务 t_0000000006 / 频道 c_0000000012 / 消息 m_33~m_41）保留可查；旁路验证产物 art_0000000009 保留（type=text 契约合法样例）。

---

# Phase 4 M4 最终确认 — MAJOR-1 修复真实验证（1 次调用）

> 日期：2026-08-08 | 环境：server :3000（已重启加载 poll 基线修复）+ worker w_local_1（online，port 34975）
> 成本：真实 opencode 调用 **1 次**（仅此一次，复用 F3 遗留任务 t_0000000006 会话）
> 目标：验证 MAJOR-1（二次 @ 复用会话回复回流）修复在真实环境生效

## 1. 环境确认

- ✅ GET /workers → `w_local_1` online，capabilities.port=34975，opencode 1.18.15，load.instances=0
- ✅ 遗留任务 t_0000000006（in_progress，team=[a_architect, a_product]），群聊频道 c_0000000012
- ✅ 登录 admin/admin123 → accessToken 有效（221 字符）

## 2. 核心验证：二次 @ 复用会话回流（MAJOR-1）

| 步骤 | 结果 |
|---|---|
| 发送前最新消息 | m_0000000041（F3 遗留最后一条 agent 回复） |
| POST 消息 | **m_0000000042** user「@产品经理 请简要列出本任务的 3 条验收标准」，mentions=[a_product] → trigger `a_product s_0000000009 dispatched`（**复用 F3 会话 s_0000000009** ✓） |
| 轮询检测 | **m_0000000043 agent sent** 回流落库，parts=[text, step-start, reasoning, text, step-finish]，createdAt 19:03:50.587Z |
| **MAJOR-1 判定** | ✅ **修复生效**——此前 m_37（首个复用 dispatch）120s 超时 + agent.error；本次 m_42→m_43 正常回流，未触发 dispatch_timeout，无 agent.error |

**首字延迟**：m_42 createdAt 19:03:45.571Z → m_43 createdAt 19:03:50.587Z = **5016ms（5.02s）**——≤15s 通过线 ✅，5s 目标线 ✗（超 16ms，模型即时单轮回复，接近但未达标）

## 3. 产出物声明

- m_43 文本**无 `<artifact>` 声明**（模型直接回答 3 条验收标准，未声明产出物）→ 无新归档，符合预期
- GET /tasks/t_0000000006/artifacts → 仍仅 art_0000000009（F3 旁路验证遗留，type=text），**无新增**（模型未声明 → 无归档，契约链路正常）

## 4. 工作目录隔离（MINOR-3 复查）

- ✅ 任务工作目录 `/tmp/keta-worker-tasks/tasks/t_0000000006/` 存在（02:33 创建，本轮为空目录）
- ✅ 仓库根**零新增模型产物**：git status 最近 10min 修改文件仅 f3-*.png（F3 遗留截图）；本轮无新未跟踪文件（m_43 回复仅文字，无 tool 调用，未写文件）
- ℹ️ 复用会话场景隔离仍依赖 serve 原 directory（MINOR-3 已知限制，本轮模型未调用工具故无实证 workdir，不影响验收）

## 5. 最终结论

| 项 | 判定 |
|---|---|
| **MAJOR-1 二次 @ 复用回流** | ✅ **真实环境修复生效**（m_42→m_43 首轮复用 dispatch 正常回流，未超时、无 agent.error） |
| 首字延迟 | ⚠️ 5016ms（≤15s 通过线达成；5s 目标线差 16ms） |
| 产出物归档 | ✅ 链路正常（无声明→无归档，契约行为符合） |
| 工作目录隔离 | ✅ 本轮零污染 |

> M4 验收结论：**MAJOR-1 修复通过真实验证**。F3 复审发现的"首个复用 dispatch 回复不回流"缺陷已由"promptAsync 前取基线 cursor + baselineId 兜底跳过空占位"修复闭合。遗留：复用会话 workdir 隔离（serve 层限制）、首字延迟 5s 目标线（依赖模型行为）。
