# Learnings — vteam-custom-agent-opencode

Conventions, patterns, and successful approaches discovered during work on this plan.

_Append new entries below - never overwrite._

---

## Todo 1 — foundation: `agents.agent_key` + template backfill (2026-09-14)

- Schema: `agentKey String? @unique @map("agent_key")` 置于 `role` 之后（nullable：存量自定义/克隆无 key 仍合法，“必填”由 Todo 3 service 层强制，不在 DB 设 NOT NULL）。
- 格式单一来源：`AGENT_KEY_PATTERN = '^[a-z][a-z0-9_-]{0,62}$'`（string 常量，`agent.constants.ts:85`）；后续 todo 用 `new RegExp(AGENT_KEY_PATTERN)` 复用，禁止重复字面量。全仓 grep 确认该精确模式仅此一处（docs-mirror 的 `[a-z0-9_-]` 系列为原型 slug 白名单，无关）。
- 迁移 `20260914000000_add_agent_key/migration.sql` 手写（目录仅含 migration.sql，与 `20260913000000` 范例一致）：`ADD COLUMN agent_key VARCHAR(63) NULL` + `CREATE UNIQUE INDEX uk_agents_agent_key` + 回填 `UPDATE ... SET agent_key = role WHERE type='template' AND role IS NOT NULL AND agent_key IS NULL`。MySQL unique 对多 NULL 互不冲突，故可空+唯一组合安全；fresh DB `migrate deploy` 按序执行，无幂等问题。
- seed：模板 upsert 的 update/create 双路径均写 `agentKey: agent.role`（update 白名单现为 `['agentKey','policyId','prompt']`）；自定义/克隆行零触碰。
- 坑：改 schema 后必须先 `npx prisma generate` 再 `tsc`，否则 seed.ts 的 `agentKey` 报未知属性。`npx prisma validate` 确认 schema 合法。
- 验证：`npx tsc -p tsconfig.json --noEmit` exit 0；`npx jest src/prisma/seed.spec.ts` 10/10 green（含新增 `agentKey = role` 双路径断言）。
- Commit：`feat(db): add agent_key to agents with template backfill`。

## Todo 2 — DB-backed `/agent-policies` + 三态 tools 矩阵 (2026-09-14)

- `buildAgentPolicies()` 由纯函数改为 `async`：内置 6 项保持 `AGENT_POLICIES_ORDER` 顺序逐字派生（`ROLE_BOUNDARIES` 单一来源零触碰）；自定义块经 `prisma.agent.findMany({ where: { agentKey: { not: null }, policyId: { not: null } } })` + 一次 `executionPolicy.findMany({ id: { in } })` 拉全集内存映射（无 N+1），内存再按 `agentKey` 升序排（DB `orderBy` + 内存 sort 双保险，mock/collation 下仍稳定）。
- 防御三件套：`agentKey` 用 `new RegExp(AGENT_KEY_PATTERN)` 复用校验（不重复字面量）；命中内置名（克隆 `agentKey=role` 残留）直接跳过保字节一致；策略缺失/`config.permission` 非对象跳过（与 `resolveByAgent→null` 语义对齐）。
- 类型放宽：`AgentPolicyDefinition.name: string`、`guard.roles: Record<string, AgentGuardRole>`、`tools: Record<string, AgentToolState>`（新增 `'allow'|'ask'|'deny'` 三态别名，内置窄值仍兼容）；worker 侧已是 `string`/`Record<string,…>`，零改动验证通过。`AGENT_POLICIES_ORDER` 保持 `readonly VteamAgentName[]` 非导出不变。
- `guardForAgent(name, config?)`：内置命中即今日常量（config 整体忽略）；非内置 + config 非空 → 过滤后 tools + 全量 `ROLE_BASH_DENY_PATTERNS`（bash 底线是全局共享 floor，注释已记理由）；无 config 未知名保持旧 `{ tools: {}, bashDeny: [] }`。
- `PolicyConfigDto.tools` 为 `@IsOptional() @IsObject()` 可选；`assertValidConfig` 仅在显式传入非对象时 400，存量无 tools 行合法。
- Agent 模型无 `description` 列：自定义 `agents[].description` 取 `policy.description → agent.name` 回退。
- 验证：`npx tsc --noEmit` exit 0；`npx jest src/execution-policies` 30/30 green（含新增 `agent-policies.custom-agents.spec.ts`：字节一致快照 + demo-agent 矩阵 + resolve 双路径）。
- Commit：`feat(policies): emit db-backed custom agent definitions with tool matrix`。

## Todo 4 — dispatcher 按 agentKey 路由自定义 agent (2026-09-14)

- 新导出纯函数 `resolvePolicyAgentCandidate(row)`（worker-dispatcher.ts，紧随 `roleToAgentName`）：`agentKey` 合法（`new RegExp(AGENT_KEY_PATTERN)` 复用、`agent.constants.ts:85` 单一来源，禁止重复字面量）→ `vteam-<agentKey>`；缺席/非法视为缺席 → 回退 `roleToAgentName(role)`；均无 → null。返回类型用 `string | null`（自定义名不在 `VteamAgentName` 联合内），调用方 `policyCandidateAgent` 同步放宽类型。
- 接线（一处）：`effectivePlanForPolicy ? 'vteam-plan' : resolvePolicyAgentCandidate(agentIdentity)`，能力位门 `workerSupportsAgentPolicies` 与 `opencodeAgentName` 回退原样保留；`renderBoundarySection` 零改动（自定义名过不了 `isVteamAgentName` → `''`，已用单测锁定）。
- `AgentIdentityInfo` 增 `agentKey: string | null`（文件内有两个声明合并的同名 interface，`replaceAll` 同步加；spec 内 3 处字面量各补 `agentKey: null`——grep 只找 `AgentIdentityInfo` 会漏掉第 3 处内联字面量，tsc 是唯一兜底）。
- `agentRow` select 仅加 `agentKey: true`（`policyId` 未使用就不加）；默认 mock 行无 `agentKey` → `?? null` → 角色回退，既有 180 用例零改动全过。
- 非法 key 测试技巧：能力位 `names` 故意含 `vteam-Bad-Key`，断言仍省略 `agent` 键——证明非法名连门都进不了（不是“门假回退”，是“无候选”）。
- 环境坑：工作树有 Todo 3 未提交的 `agents/**` 改动（DTO 加必填 `agentKey`，spec 未同步），`tsc --noEmit` exit 1 的 13 个 error 全在该目录；自有文件用 `grep error TS | sed | uniq -c` 按文件分组自证清白，不碰越界文件。
- 验证：`npx jest src/chat/worker-dispatcher.spec.ts` 188/188 green（新增 7 个 it：helper 映射 1 + 边界缺席 1 + 分派 (a)~(e) 5）。
- Commit：`feat(dispatch): route custom agents by agentKey`。

## Todo 3 — Agent CRUD 穿透 `agentKey` + 分层 effectivePermission (2026-09-14)

- DTO 三件套：`CreateAgentDto.agentKey` 必填、`UpdateAgentDto.agentKey?` 可选、`CloneAgentDto.agentKey` 必填；统一 `@Matches(new RegExp(AGENT_KEY_PATTERN))`（`agent.constants.ts:85` 单一来源）+ 第二个 `@Matches(/^(?!vteam-).+$/)` 显式拒绝 `vteam-` 前缀（防 `vteam-vteam-x`）。
- Service 双层校验（DTO pipe 旁路时单测直调 service 仍生效）：`assertValidAgentKey`（缺失/空串→400 `AGENT_KEY_INVALID`； pattern 不符→400；`vteam-` 前缀→400，原样存储不 trim/小写）；`throwOnAgentKeyConflict` 捕获 `PrismaClientKnownRequestError P2002` → 409 `AGENT_KEY_CONFLICT`（create/clone/update 三路径 try/catch 包事务，冲突码为 service 内局部常量——`common/constants` 不在本次 scope 内，不碰）。
- 顺序语义：clone/update 先查源（404 `AGENT_NOT_FOUND` 优先）再验 key；update 仅 `dto.agentKey !== undefined` 时 set；clone 持久化新 key、源 key 永不复制；template 只读/可改设置语义零改动。
- `AgentRow` + 两 builder 返回均增 `agentKey: string | null`；`resolveManyByAgents` 入参补 `agentKey`（custom 解析出 `agentName = vteam-<key>` + 绑定策略 `config.tools` 三态）。存量 fixture 无 key → 传 `undefined`，`toHaveBeenCalledWith` 的 toEqual 语义忽略 undefined 属性，既有断言零改动通过。
- Spec 连带修复：controller.spec 的必填 DTO 构造（create/clone）+ `errorsOf` 负向用例（`{}` 对 clone 现为失败）；service.spec 既有 create/clone 调用补 key、列表键契约加 `agentKey`；新增 7 个 it（create 有效/非法/`vteam-`/409、clone 新 key+409、update set/skip、toAgentDto 分层断言）。
- 验证：`npx tsc -p tsconfig.json --noEmit` exit 0；`npx jest src/agents` 96/96 green（3 suites）。
- Commit：`feat(agents): manage agentKey with layered effective permission`。

## Todo 5 — custom/clone agent 可编辑 custom 策略装配 (2026-09-14)

- 根因：模板策略 `config` 无 `tools` 矩阵 + `type='template'` PATCH 403 → 克隆继承模板绑定后 `guardForAgent('vteam-<customKey>', config)` 走非内置分支读 `config.tools` → `{}` 全拒。修法：seed 模板 `config` 补 `tools: {...boundary.toolAllows}`（内置输出走 `ROLE_BOUNDARIES` 常量直取，落库不影响字节一致，实测 live diff 11993 字节逐字节一致）；`AgentsService.create/clone` 恒新建 `type='custom'` 策略（源 config JSON 深拷贝，`name=${agentName} 策略`），三路径：显式 policyId 原样绑 / role 命中 `ep_<role>` 深拷贝 / 兜底 deny-by-default 骨架（edit 全 deny + bash/task deny + tools `{}` + `denyTemplate: ROLE_POLICY_DENY_TEMPLATE`）。
- 模板行缺失时的二级回退：`resolveTemplateSource` 先查库 `ep_<role>`，缺失但 role 命中 `ROLE_BOUNDARIES` 时按 seed 同形派生（含 tools 拷贝）；`ROLE_POLICY_DENY_TEMPLATE` 由 seed 局部常量改为 `agent.constants.ts` 导入（单源）。
- Live 坑两则：(1) `docker compose build server + up --force-recreate server` 不重跑 `init`（独立镜像/容器），模板 tools 须 `docker compose run --rm server node dist/prisma/seed.js` 另行同步，否则克隆仍拷贝无 tools 旧 config；(2) `toAgentDto` 原在事务内调 `resolveManyByAgents`（经全局 Prisma 别连接读不到未提交的新策略行 → effectivePermission=null），改为写事务提交后解析——创建/克隆响应即带完整 tools（clone 实测 `tools=16, group_post=allow`）。
- 验证：`tsc --noEmit` exit 0；`jest src/agents src/execution-policies src/prisma/seed.spec.ts` 140/140（含新增 clone-模板/自定义独立性、create-role/骨架/显式绑定 5 用例 + seed tools 拷贝断言）；live 四项全过（字节一致/克隆 16 tools/PATCH 200 即时反射/模板 403 不动），证据 `.omo/evidence/custom-agent-opencode/policy-provision.txt`，QA 行已清（`a_0000000001` 无 key 无策略历史残留，非本次产生，保留）。
- Commit：`feat(policies): provision editable custom policies for custom agents`。
