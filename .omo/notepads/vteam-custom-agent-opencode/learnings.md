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
