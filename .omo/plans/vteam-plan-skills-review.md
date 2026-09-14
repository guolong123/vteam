# 计划：计划编制/评审 skills + 新会话评审机制

## TL;DR (For humans)

内置 6 个 skills（`plan-creation` + 5 个 `plan-review-<role>`，seed 预置、全局注入、prompt 点名加载），新增 MCP 工具 `vteam_plan_review`（仅主 Agent）：主 Agent 起草计划后用 `question` 问用户选评审者，一次调用扇出**全新会话**给各评审者，并行收集 `VERDICT: APPROVE/REJECT` 后返回，REJECT 则修订再审。

## 决策来源（用户确认）

- Skill 触发 = **A**：prompt 点名加载，零新机制代码（skill 全局注入是既定机制）。
- 评审范围 = **主 Agent 指定，指定前先 `question` 问用户**确认走哪些评审。
- 参考：编制 skill 参照 Prometheus（explore-first + 并行/串行分析）；评审 skill 参照 momus（只读+二值裁决）+ oracle（高智商咨询）风格。

## 已实测事实（本会话）

- Skill 机制：`Skill` 行（name 唯一 + SKILL.md 全文 + enabled）→ worker `injectSkills()` 写 `<workDir>/.opencode/skills/<name>/SKILL.md` → opencode 原生发现 → agent 按名 `skill()` 加载（guard 对 `skill` 放行）。`AgentSkill` 关联表在 dispatch/注入链路**从未被读取** → "注入到对应 agent" = 全局文件 + prompt 点名，不做选择性注入。
- Seed 已有 `BUILTIN_SKILLS` 范式（`prototype-designer`，含 frontmatter `allowed-tools`），新 skill 照抄格式；seed upsert 置 `enabled: true`。
- `WorkerClient.execute` 是 `Promise<void>`（fire-and-forget，结果走 ingress 事件），服务端**无** await-execution 原语 → 评审不等 ingress，另开 worker 同步单轮通道。
- Worker `execute` 不传 sessionId 即 `createSession` 全新会话 + 写 guard 映射；`assertWorkerTask` 认内存 `activeExecutions`（`registerExecution`/`unregisterExecution(workerId, scope=team:<teamId>, teamMemberId)`）或 DB 会话绑定。
- vteam `Session` 对 (team, member) 有唯一键 → 评审会话**不写** vteam Session 行（短暂存在，避免污染工作会话 + 避开唯一键冲突）。
- `question`（opencode 内置，多选）与 `skill` 均在 guard `BUILTIN_PASSTHROUGH`，vteam-plan 下可直接调用，无需改 guard。

## 冻结设计（唯一事实源）

### D1 Skill 名单（6 个，seed 预置 + enabled）
- `plan-creation`：主 Agent 计划模式编制计划。内容：Prometheus 式 explore-first + 并行/串行分组；任务拆解格式；经 `task_context.agentMembers` 做团队能力映射（含自建 agent，不硬编码角色）；任务分配章节格式；计划文件落 `.opencode/plans/`；起草后 `question`（多选）问用户选评审者 → 调 `vteam_plan_review`；REJECT 则修订再审。
- `plan-review-product|architect|developer|tester|project_manager`：结构统一——只读计划文件 → 本职业视角逐项质疑 → 输出 `VERDICT: APPROVE/REJECT` + 依据；明确禁止修改计划文件。职业视角按用户定义（产品重用户视角/完整性/必要性/易用性；开发重实现细节；测试重测试方案/验证方式；架构重技术合理性；PM 重进度/风险/协调）。

### D2 Prompt 点名（A 方案）
- `PLAN_PRODUCE_INSTRUCTION`（`worker-dispatcher.ts`）追加：先 `skill(plan-creation)`；起草 + 群聊通知后，用 `question` 多选问用户选评审角色；调 `vteam_plan_review(reviewers=[...])`；有 REJECT 则修订（可再问用户是否重审）。
- 5 个角色 seeded prompt 各加一句评审子句：被要求评审计划时先 `skill(plan-review-<role>)`，冷评审，只输出 VERDICT + 依据。

### D3 新 MCP 工具 `vteam_plan_review`（暴露名，注册名 `plan_review`）
- 参数：`{taskId, selfInstanceId, reviewers: string[]（role 名）, planPath?: string}`；**仅主 Agent**（复用 `findTaskTeamGate` 主门，非主 403）。
- 语义：`planPath` 缺省取 `<taskWorkDir>/.opencode/plans/` 下最新 `.md`，无文件则 400 明示；reviewers 解析为"首个该 role 的团队成员"，**跳过缺席 role 与主 Agent 自身 role**（附 notes 说明，不报错）。
- 对每位评审者并行调 worker 新端点（D4），聚合并返回 `{verdicts:[{role,memberId,verdict,findings}], notes:[]}`；`Promise.allSettled` + 单评审超时（默认 10min，可配），超时/异常记为 `NEEDS-ATTENTION` 附原文。
- VERDICT 解析：`/VERDICT:\s*(APPROVE|REJECT)/i`，失败记 `NEEDS-ATTENTION`。
- 身份：调用前后 `registerExecution`/`unregisterExecution`（finally 必解），过 `assertWorkerTask` 快路径；**不写** vteam Session 行。
- **server-gated**：`vteam_plan_review` 加入 `ROLE_SERVER_GATED_TOOLS` + `VTEAM_MCP_TOOL_NAMES`（新注册工具），worker 侧 `SERVER_GATED_TOOLS` 同步 + parity/e2e 断言更新（5→6）。

### D4 Worker 新端点 `POST /review`（单轮同步执行）
- 请求：`{prompt, model?, agent?, directory?, taskId?, agentId?, channelId?, system?, timeoutMs?}`（**无 sessionId**——恒全新会话）；响应：`{text, sessionId}`。
- 行为：`createSession` → 写 guard 映射（`agent` 即评审者角色 agent 名）→ `runSendAndAwait` 复用 → 返回收集文本；**不发** SESSION_UPDATED/AGENT_STATUS 等 realtime 事件（评审会话不污染 UI 状态）。
- Server 侧 `WorkerClient.review(worker, opts): Promise<{text, sessionId}>`，超时透传（默认 10min）。

### D5 评审 prompt（服务端组装，不落盘）
```
你是<角色名>评审者，正以全新会话冷评审任务 <taskId> 的执行计划。
先加载技能：skill(plan-review-<role>)，严格按其执行。
# 待评审计划（<planPath> 全文）
<plan markdown>
# 输出（严格）：先给 VERDICT: APPROVE 或 VERDICT: REJECT，再列依据 findings。
只评审，不修改任何文件，不执行计划。
```

## Todos

- [x] 1. [seed] 6 个 skills 预置 + 5 角色 prompt 评审子句
  References: `server/prisma/seed.ts:606-660`（BUILTIN_SKILLS 范式）、`server/src/prisma/seed.spec.ts`；角色 prompt 在 `seed.ts` 各模板段。
  Acceptance: `plan-creation` 含 D1 全部要素（explore-first/并串分组/能力映射/分配章节/落盘路径/question 选评审者/调 plan_review/REJECT 修订）；5 个 review skill 结构统一且职业视角各异、禁改文件、VERDICT 格式；`allowed-tools` frontmatter 准确（creation 含 task_context/read_file/doclib/chat_history/question/vteam_plan_review；review 含 read_file/task_context/chat_history/skill）；全部 `enabled: true`；角色 prompt 评审子句点名对应 skill。
  QA: seed 后 DB 有 6 行且 enabled；`SKILL.md` frontmatter 合法。Evidence: `server/src/prisma/seed.spec.ts`。
  Commit: `feat(seed): plan creation and per-role review skills`
  Recommended task executor category: writing

- [x] 2. [dispatcher] `PLAN_PRODUCE_INSTRUCTION` 接入 skill→question→plan_review 流程
  References: `server/src/chat/worker-dispatcher.ts:255-273`（PLAN_PRODUCE/REVIEW_INSTRUCTION）；`worker-dispatcher.spec.ts`。
  Acceptance: PRODUCE 追加三步（skill(plan-creation)→question 多选评审者→vteam_plan_review→REJECT 修订）；REVIEW 指令注明评审在全新会话、输入仅计划文件；不改现有注入字节（开关外）。
  QA: 含新指令的 system 构建单测。Evidence: `server/src/chat/worker-dispatcher.spec.ts`。
  Commit: `feat(dispatch): wire plan skill and review flow into plan instructions`
  Recommended task executor category: unspecified-high

- [x] 3. [mcp] `plan_review` 工具 + 聚合 handler + `WorkerClient.review`
  References: `server/src/platform-mcp/platform-mcp.tools.ts`（注册）、`server/src/platform-mcp/platform-mcp.service.ts`（handler）、`server/src/workers/worker.client.ts`（client）、`server/src/common/constants/agent.constants.ts`（server-gated 常量）。
  Acceptance: 工具注册（name `plan_review`，主 Agent 门，非主 403）；handler 按 D3（plan 定位→成员解析→register→并行调 `POST /review`→unregister(finally)→VERDICT 解析→聚合返回）；`vteam_plan_review` 进 `ROLE_SERVER_GATED_TOOLS` + `VTEAM_MCP_TOOL_NAMES`；`WorkerClient.review` 超时可配。
  QA: 主门单测；VERDICT 解析单测（含 NEEDS-ATTENTION）；聚合单测（混合 APPROVE/REJECT/超时）。Evidence: `server/src/platform-mcp/*.spec.ts`。
  Commit: `feat(mcp): plan_review with fresh-session fan-out`
  Recommended task executor category: deep

- [x] 4. [worker] `POST /review` 单轮同步执行端点
  References: `worker/src/exec/exec-server.ts:400`（路由风格）、`:1189`（createSession）、`:1427`（runSendAndAwait）、`:1292`（guard 映射）。
  Acceptance: 按 D4（恒新会话、guard 映射写评审角色、无 realtime 广播、返回 `{text, sessionId}`、timeoutMs 生效）；与 `/execute` 互不干扰。
  QA: 端点单测（mock driver：断言 createSession 被调、sessionId 未复用、返回文本透出）。Evidence: `worker/src/exec/exec-server.spec.ts`。
  Commit: `feat(worker): single-turn review execution endpoint`
  Recommended task executor category: unspecified-high

- [x] 5. [e2e] 计划 skills 全链路验证 + 文档同步
  References: `scripts/e2e-permission-matrix.sh`（范式）；`docs/agent-platform/16-内置Agent角色与提示词库.md`（角色 prompt 文档）。
  Acceptance: ① seed 后 6 skills 存在且 enabled，workdir 注入出 6 份 SKILL.md；② `vteam_plan_review` 在 server/worker 两侧 server-gated 一致（6 值），guard 放行、MCP 主门对非主 403；③ 有真实 LLM 时做一次单评审者 live smoke（超时放宽，仅断言返回 VERDICT 可解析），无 LLM 时以 mock 覆盖并注明；④ 16 篇等文档与 seed prompt 同步（或显式记录分歧）。
  QA: 脚本可重复通过。Evidence: `.omo/evidence/plan-skills/e2e.txt`。
  Commit: `test(e2e): plan skills and review flow`
  Recommended task executor category: unspecified-high

## Final verification wave

- [x] F1. 计划合规审计 — Todos 全合入；References 真实存在；skill 名/MCP 名/端点契约三处一致。Evidence: `.omo/evidence/plan-skills/F1-plan-audit.txt`。
  Recommended task executor category: unspecified-high
- [x] F2. 代码质量 review — 无 `as any`/`@ts-ignore`/stub；无 AB 双轨/退役说明；新通路无安全回退（主门、身份注册、超时、finally 清理齐全）。Evidence: `.omo/evidence/plan-skills/F2-code-quality.txt`。
  Recommended task executor category: unspecified-high
- [x] F3. 真实手工 QA — skills 注入可见；`question` 选评审者可用；一次真实 plan_review 回合（VERDICT 可解析；REJECT 能触发修订）。Evidence: `.omo/evidence/plan-skills/F3-manual-qa.txt`。
  Recommended task executor category: unspecified-high
- [x] F4. 范围保真 — 未越界（dispatch 主路径、guard 判定、普通 MCP 工具零回归）。Evidence: `.omo/evidence/plan-skills/F4-scope-fidelity.txt`。
  Recommended task executor category: unspecified-high

## Success criteria

- `cd server && npx tsc -p tsconfig.json --noEmit`、`cd worker && npx tsc --noEmit` 均 exit 0；相关 jest 全绿。
- 6 skills 落库且 enabled；`.opencode/skills/` 注入可见。
- `vteam_plan_review` 双侧 server-gated 一致；非主调用 403。
- 一次真实评审回合产出可解析 VERDICT。
