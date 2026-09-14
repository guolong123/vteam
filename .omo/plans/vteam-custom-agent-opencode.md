# 计划：自建 Agent 成为一等公民（opencode 原生 agent + 可配三态权限）

## TL;DR (For humans)

让用户自建的 Agent 变成真正的 opencode 原生 agent：新增 `agentKey` 标识字段 → opencode agent 名 = `vteam-<agentKey>`；权限绑定 custom ExecutionPolicy（clone 自模板，可逐工具改三态）；`/agent-policies` 由硬编码常量改为读 DB 泛化下发；guard/dispatch 全链路打通。页面恢复三栏（允许/询问/拒绝）可切换，内置模板只读、自建可配。

## 决策来源（用户原话）

- 「命名规则上通过增加一个标识字段来决定，vteam-<agent_name>」
- 「按照推荐」= 权限来源绑定 custom ExecutionPolicy（clone 自模板，逐工具改三态）
- 前置约束（沿用）：「不需要标注已退役相关说明」「涉及兼容问题不保留老代码，保持代码干净，不做 AB 实现」

## 现状（已实测）

- `/agent-policies` 由纯函数 `buildAgentPolicies()` 生成，硬编码 6 个角色（`AGENT_POLICIES_ORDER`），**不读 DB**。
- 自建/克隆 agent（`type=custom|clone`）无 `role` → `resolveByAgent` 落 `agentName='vteam-plan'` 或 null → dispatch 不传 agent → 用 serve 默认 agent 跑。
- guard `roles.json` 无该 agent → 未知 agent **直接放行**，无边界约束。
- 注入产物实测 `agent keys = [vteam-plan, vteam-product, vteam-architect, vteam-developer, vteam-tester, vteam_project_manager]`，无自建 agent。
- injector `cleanupByManifest('agentNames')` 只删「上次自己注入、本次不在集合」的键 → 手工键保留；plugin 判定块与 guard 角色表均为**角色无关**通用逻辑（无 `vteam-*` if 分支）。
- injector 目前仅 worker 启动时跑一次（`worker/src/index.ts:589`）。

## 冻结设计（本计划唯一事实源）

### D1 命名
- 新增 `Agent.agentKey String? @unique @map("agent_key")`：机器安全标识，`^[a-z][a-z0-9_-]{0,62}$`，不含 `vteam-` 前缀、不含 CJK。
- opencode agent 名 = `vteam-<agentKey>`。
- 模板 agent：`agentKey = role`（product / project_manager / architect / developer / tester）→ 与现状 `vteam-<role>` **逐字节一致**。
- 自建/克隆：创建时用户提供 `agentKey`（必填、校验格式、唯一）。

### D2 权限来源
- 自建 agent 绑定一条 `type=custom` 的 ExecutionPolicy（clone 自模板 → 改三态）。
- 策略 `config` 扩展：`{ permission, correction, tools }`，其中
  - `tools: Record<string, 'allow'|'ask'|'deny'>` = 逐工具三态矩阵（UI 可编辑；MCP + 自定义工具真实名）。
  - `permission` = 层① 原生（`edit`/`read`/`bash`/`task`）。
- 层② guard 解析：`guardForAgent(agentName, config)` → 内置名命中 `ROLE_BOUNDARIES` 用常量（**行为逐字节不变**）；否则用 `config.tools`（allow/ask 放行、deny 排除）；再否则 `{}/[]`。
- 内置模板策略保持现状（`mcpDenies` 在层①、`toolAllows` 在层②），仅 custom 策略走统一 `tools` 矩阵。

### D3 契约泛化
- `/agent-policies` 改为**异步读 DB**：6 内置角色 + 所有「有 `agentKey` 且绑定 `policyId`」的 agent，各出一条 agent 定义 + guard role。
- 输出保持 `{ agents, guard:{enabled:true, roles} }`；内置部分**逐字节不变**（加断言锁定）。

### D4 运行链路
- dispatcher：目标成员的 opencode agent 名优先取「该 Agent 的 `agentKey` → `vteam-<agentKey>`」；无 `agentKey` 回退现状（`roleToAgentName(role)`）。
- `TeamMember.opencodeAgentName` 显式覆盖仍不得绕过能力位门（沿用现状语义）。
- 传播：默认接受「需重启 worker 生效」；若 Todo 2 发现低成本重注入点则一并做（不新增对外 API）。

## Todos

- [x] 1. [foundation] `Agent.agentKey` schema + 迁移（回填模板=role）+ seed
  References: `server/prisma/schema.prisma:446-481`（Agent model）、`server/prisma/seed.ts:296-366`（策略+模板 upsert）、`server/prisma/migrations/`
  Acceptance: `agents` 加 `agent_key VARCHAR(63) NULL UNIQUE`；迁移回填 5 模板 `agent_key = role`；seed upsert 模板时写 `agentKey = role`；`agentKey` 格式 `^[a-z][a-z0-9_-]{0,62}$`。
  QA: happy - 空库 seed 后 5 模板 `agent_key` 非空且等于 role；failure - 重复/非法 key 落库即失败。Evidence: `server/src/prisma/seed.spec.ts` + migration SQL。
  Commit: `feat(db): add agent_key to agents with template backfill`
  Recommended task executor category: unspecified-high

- [x] 2. [server] `/agent-policies` 读 DB 泛化 + 策略 `tools` 分级 + `guardForAgent` 回退
  References: `server/src/execution-policies/execution-policy.service.ts:244-397`、`agent-policies.controller.ts`、`server/src/common/constants/agent.constants.ts:243-438`
  Acceptance: `buildAgentPolicies()` 改异步：内置 6 条由 `ROLE_BOUNDARIES` 生成（**逐字节不变**），其后追加所有 `agentKey != null && policyId != null` 的 agent 条目（name=`vteam-<agentKey>`，permission 由策略 config）；`PolicyConfigDto`/`assertValidConfig` 接受可选 `tools` 三态 map；`guardForAgent` 对内置名走常量、对 custom 走 `config.tools`。
  QA: happy - 内置 6 条与基线逐字节一致断言；新建 custom 策略后 `/agent-policies` 含 `vteam-<key>`。failure - 内置任一字节变化即失败。Evidence: `server/src/execution-policies/agent-policies.matrix.spec.ts`。
  Commit: `feat(policies): emit db-backed custom agent definitions with tool matrix`
  Recommended task executor category: deep

- [x] 3. [server] Agent CRUD `agentKey`（create/clone/update 校验 + DTO）+ `effectivePermission` 双层
  References: `server/src/agents/agents.service.ts:157-534`、`server/src/agents/dto/{create,update,clone}-agent.dto.ts`
  Acceptance: `CreateAgentDto`/`UpdateAgentDto`/`CloneAgentDto` 增 `agentKey`；服务层校验格式+唯一（重复 → 409）；`toAgentDto` 返回 `agentKey` + `effectivePermission`（含层② `tools`/`bashDeny`）；clone 复制源 `agentKey` 时改写为新值（用户提供）。
  QA: happy - POST 带合法 key 落库；重复 key 409；GET 返回双层。failure - 非法 key 400。Evidence: `server/src/agents/agents.service.spec.ts`。
  Commit: `feat(agents): manage agentKey with layered effective permission`
  Recommended task executor category: unspecified-high

- [x] 4. [dispatcher] 自建目标 → `vteam-<agentKey>` 路由 + 边界/计划职责处理
  References: `server/src/chat/worker-dispatcher.ts:97-135`、`:1700-1735`、`server/src/workers/workers.service.ts:160-172`
  Acceptance: 目标 Agent 有 `agentKey` → 候选 agent 名 `vteam-<agentKey>`；能力位门 `workerSupportsAgentPolicies` 用该名判定；`isVteamAgentName`/`renderBoundarySection` 对自定义名不误判（不注入 `ROLE_BOUNDARIES` 边界段，改由策略 correction 提供）；无非 agentKey 行为变化。
  QA: happy - 自建目标 dispatch payload `agent = vteam-<key>`；failure - 无 agentKey 目标与基线一致。Evidence: `server/src/chat/worker-dispatcher.spec.ts`。
  Commit: `feat(dispatch): route custom agents by agentKey`
  Recommended task executor category: unspecified-high

- [x] 5. [server] 自定义 Agent 策略供给：模板策略补 `tools` + clone/create 自动配可编辑 custom 策略
  References: `server/prisma/seed.ts:318-346`、`server/src/agents/agents.service.ts:168-300`、`server/src/execution-policies/execution-policy.service.ts:153-199`、`agent.constants.ts`（ROLE_BOUNDARIES）
  Acceptance: ① seed 模板策略 `config` 增 `tools = { ...ROLE_BOUNDARIES[agentName].toolAllows }`（内置 `/agent-policies` 输出仍逐字节不变——`guardForAgent` 命中 `ROLE_BOUNDARIES` 先返回）；② `AgentsService.clone`：自动 clone 一份 `type=custom` 策略（config 深拷贝）绑给克隆体，使克隆体可 PATCH 三态（源为 template 或 custom 均 clone，避免共享可写策略）；③ `AgentsService.create`（custom）未传 `policyId` 时按 `role` 复制对应模板策略生成 custom 策略，无 `role` 则生成安全骨架（`edit:{'*':'deny'}`/`read:{'*':'allow'}`/`bash:'deny'`/`task:'deny'`、`tools:{}`、correction 用 `ROLE_POLICY_DENY_TEMPLATE`）；④ 显式传 `policyId` 时原样绑定不改。
  QA: happy - 克隆模板 agent 后 `/agent-policies` 该克隆体 guard.tools 非空且 PATCH 其 custom 策略改三态生效；无 role 新建 → 骨架策略存在；failure - 克隆体 tools 为 `{}` 即失败。Evidence: `server/src/agents/agents.service.spec.ts` + `.omo/evidence/custom-agent-opencode/policy-provision.txt`。
  Commit: `feat(policies): provision editable custom policies for custom agents`
  Recommended task executor category: deep

- [x] 6. [web] 三栏（允许/询问/拒绝）可切换 UI：模板只读、自建可配 + 创建/克隆 `agentKey` 字段
  References: `web/app/(main)/agents/page.tsx`（`effectOf` ~495-502、`groups` ~472-493、EffectivePermission 类型、create/clone mutation ~1873-1910）、`web/lib/api.ts`
  Acceptance: 工具行渲染三态分段控件（允许/询问/拒绝），`type=template` 只读（`data-readonly`，点击不变），`type=custom|clone` 可切换并 PATCH 保存到其 custom 策略 `config.tools`；创建表单含 `agentKey` 输入（格式即时校验+错误提示）；克隆表单含 `agentKey`；层① 行（bash 等）沿用现有只读展示。
  QA: happy - Playwright：模板页三栏不可点；自建页切换后刷新保持。failure - 模板页可改即失败。Evidence: `web/app/(main)/agents/page.tsx` + `.omo/evidence/custom-agent-opencode/web-three-state.png`。
  Commit: `feat(web): editable three-state tool matrix for custom agents`
  Recommended task executor category: visual-engineering

- [x] 7. [e2e] 端到端：自建 agent 出现在注入 `opencode.json` + guard 真拦截 + 三态落库生效 + 回归
  References: `scripts/e2e-role-boundaries.sh`、`.omo/evidence/role-enforcement/F3-own/injected-opencode.json`、`.omo/evidence/role-enforcement/F3-own/agent-policies.json`
  Acceptance: 脚本可复现：① 新建自建 agent（key=`demo-agent`）+ clone 策略并改某工具为 deny → ② 注入产物 `opencode.json` 的 `agent` 含 `vteam-demo-agent` 且 guard `roles` 含同 key → ③ 对 `vteam-demo-agent` 下发被 deny 的工具调用被 guard 拒绝（纠正文案）→ ④ 内置 6 角色注入产物与基线逐字节一致。
  QA: happy - 四步全绿并留证据；failure - 任一不成立即失败。Evidence: `.omo/evidence/custom-agent-opencode/e2e.txt` + `injected-opencode.json`。
  Commit: `test(e2e): custom agent opencode injection and guard enforcement`
  Recommended task executor category: unspecified-high

## Final verification wave

- [x] F1. 计划合规审计 — Todos 全合入；内置角色注入产物逐字节不变断言在案；References 真实存在。Evidence: `.omo/evidence/custom-agent-opencode/F1-plan-audit.txt`。
  Recommended task executor category: unspecified-high
- [x] F2. 代码质量 review — 无 `as any`/`@ts-ignore`/stub；单一事实源（策略=唯一来源）；无退役说明/AB 双轨；老代码清理干净。Evidence: `.omo/evidence/custom-agent-opencode/F2-code-quality.txt`。
  Recommended task executor category: unspecified-high
- [x] F3. 真实手动 QA — Playwright 三栏切换（模板只读 / 自建可配并持久化）+ 自建 agent 真执行被 guard 拦截证据。Evidence: `.omo/evidence/custom-agent-opencode/F3-manual-qa.txt`。
  Recommended task executor category: unspecified-high
- [x] F4. 范围保真 — 未越界改动；内置角色行为不变；未引入双轨。Evidence: `.omo/evidence/custom-agent-opencode/F4-scope-fidelity.txt`。
  Recommended task executor category: unspecified-high

## Commit strategy

- 每 todo 一 commit，前缀 `feat/fix/refactor/test/docs/chore` + 域。
- Todo 1 含 Prisma migration（先于其余）。
- 合并且打 tag 前三端 typecheck + 相关 jest 全绿。
- 不 push（等用户指示）。

## Success criteria

- `cd server && npx tsc -p tsconfig.json --noEmit`、`cd worker && npx tsc --noEmit`、`cd web && npx tsc --noEmit` 均 exit 0。
- 相关 jest 全绿（agents / execution-policies / agent-policies / worker-dispatcher / injector / role-guard-plugin / web）。
- 实测：新建自建 agent（含 `agentKey`）→ 注入产物 `agent` 含 `vteam-<agentKey>` + guard `roles` 含同 key；对其下发越界工具调用被 guard deny；页面三栏可切换且模板只读、自建可编辑。
