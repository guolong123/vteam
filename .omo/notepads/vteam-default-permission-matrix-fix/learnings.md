# Learnings — vteam-default-permission-matrix-fix · Todo 1 (server)

## 2026-09-14 · server-gated 从 guard allowlist 拆分（Todo 1 DoneClaim 要点）

- 新增单一来源 `ROLE_SERVER_GATED_TOOLS`（5 真实名：task_transition / question_confirm /
  task_create / plan_mode / team_add_member）于 `agent.constants.ts`，紧邻
  `VTEAM_MCP_TOOL_NAMES`；`execution-policy.service.ts` 仅 import，不重复字面量。
- `VTEAM_MCP_TOOL_NAMES` 补 `vteam_task_create`（22→23），追加末尾，与
  `platform-mcp.tools.ts` 注册顺序一致；`toolAllows` 的 MCP 键归属断言自动通过。
- `defineBoundary` 经预计算 `SERVER_GATED_SET` 排除门控工具：
  `mcpDenies = VTEAM_MCP_TOOL_NAMES - toolAllows - serverGated`（D3）。
- D4 补齐后 product 的 `toolAllows` 覆盖全部 18 个非门控 MCP → 其 `mcpDenies` 为空数组。
  教训：`seed.spec.ts` 旧断言 `otherKeys.length > 0`（默认每角色必有 deny）被证伪，
  已改为与 `ROLE_BOUNDARIES[agentName].mcpDenies` 逐项一致的精确断言；"无 deny 键"
  本身就是 D1 的正确形态，不要把"至少一个 deny"当不变量。
- `seed.spec.ts` 旧断言"task_transition 必须显式 deny"（把 bug 锁成契约，与
  `agent.constants.spec.ts:186-193` 同类问题）已改为：5 门控工具在层① permission
  无键。`seed.ts` 本体零改（permission 由 `boundary.mcpDenies` 派生，自动跟随）。
- `seed.ts` 的 `vteamTools` 注册表（22 项，缺 `task_create`）未动：属 seed 运行时数据，
  留给 Todo 3（seed 对齐）处理；`VTEAM_MCP_TOOL_NAMES`（23）是 guard/层① 的口径，
  两者暂不一致是已知遗留，不在本 todo 验收内。
- `ResolvedExecutionPolicy.serverGated` 为 `[...ROLE_SERVER_GATED_TOOLS]` 拷贝，
  `resolveByAgent` / `resolveManyByAgents` 均返回；worker wire 格式
  (`AgentGuardRole` / `buildAgentPolicies().guard.roles[*]`) 零改动——matrix +
  custom-agents 两个 spec 显式断言 permission/tools 均无门控键。
- 验证：`cd server && npx tsc -p tsconfig.json --noEmit` exit 0；
  `npx jest src/prisma/seed.spec.ts src/common src/execution-policies` →
  14 suites / 127 tests 全绿（含更新后的 1 snapshot，其 diff 仅为门控 deny 删除 + D4 allow 新增）。
- Commit：`feat(policies): split server-gated tools from guard allowlist`（仅 server
  侧文件；`.omo/boulder.json` 的未暂存改动为前人遗留，未纳入本次提交）。

## 2026-09-14 · guard 层② 放行 server-gated 5 工具（Todo worker DoneClaim 要点）

- `worker/src/role-guard/policy.ts` 新增本地 `SERVER_GATED_TOOLS`（5 真实名，与
  server `ROLE_SERVER_GATED_TOOLS` 逐字同值，worker 独立、零 import server），分支置于
  `TASK_TOOLS` 之后、`BUILTIN_PASSTHROUGH` 之前：`task`/`execute` 仍 deny，门控 5 工具
  一律 `{action:'allow'}`（判定权交 platform-mcp 服务端 `mainAgentInstanceId` /
  `mainAgentMemberId`）。
- `worker/src/resources/role-guard-plugin.ts` 的 `DECISION_BEGIN/END` 内联快照同步追加
  同名 `new Set([...])` 字面量 + 同序分支（发射产物仅 `node:` import，自包含）；快照内
  注释的反引号按模板字面量转义（`\`ROLE_SERVER_GATED_TOOLS\``）。
- Before：门控 5 工具在任何角色 `tools` allowlist 皆无 → guard 终分支 deny（含主 agent），
  server 门控收不到请求（任务流转/plan mode/成员添加/confirm 全断）。After：任一已知角色
  调用 5 工具均 allow；`task`/`execute` 与未列入非门控 MCP（`vteam_member_remove` /
  `vteam_bogus` 负对照）仍 deny。
- Parity：`role-guard-plugin.spec.ts` 矩阵 20→25 例（+5 门控），快照求值 vs `policy.ts`
  逐字节一致；`policy.spec.ts` 新增 `4d2` 段（5×allow + task/execute 仍 deny +
  负对照 deny）。
- Wire 格式零改：`opencode-config-builder.ts` / `assertGuardRole` /
  `ROLE_ALLOWED_FIELDS` 未动。
- 验证：`cd worker && npx tsc --noEmit` exit 0；
  `npx jest src/role-guard src/resources` → 7 suites / 131 tests 全绿。
- 注意：工作区另有他人未暂存改动（`server/prisma/seed.ts`、`.omo/boulder.json`），
  本次提交仅含 4 个 worker 文件 + 本 notepad，未纳入他人改动，未 push。
- Commit：`feat(guard): pass through server-gated tools to the main-agent gate`。

## 2026-09-14 · seed 角色 prompt 与 tool allowlist 对齐（Todo seed DoneClaim 要点）

- 五角色 prompt「可用工具」行按 `ROLE_BOUNDARIES[*].toolAllows` 补齐（prompt 跟随常量）：
  product +`wecom_reply`/`channel_send`（16→18）；architect +同2项（18→20，git 5 项本就在行内）；
  developer +`doclib`/`wecom_reply`/`channel_send` 并把 git 5 项并入「可用工具」行
  （14→17+5，沿用 architect 的 `+ git_…（只读）` 行格式）；tester +`wecom_reply`/
  `channel_send`+git 5 项（15→17+5，同格式）；project_manager +`chat_history`/
  `wecom_reply`/`channel_send`（14→17）。
- 六列表均不含 server-gated 5 工具（`task_transition`/`question_confirm`/`task_create`/
  `plan_mode`/`team_add_member`）；`vteam-plan` 无 seed 模板 prompt（5 模板外），跳过。
- `vteamTools` 注册表 +`task_create`（22→23）：`{ action: 'task_create',
  name: 'vteam_task_create', description: '在团队会话无任务时创建任务（仅主 Agent 可调）' }`，
  与 `platform-mcp.tools.ts` 同名同义（seed 侧短描述风格）。
- `seed.spec.ts` 新增「可用工具」集合相等断言：解析 prompt 行（按 `/`/`+` 切分、去
  `（只读）` 后缀）与 `ROLE_BOUNDARIES[agentName].toolAllows` 键集逐项比对 + 门控工具
  不得出现；漂移即失败。
- 验证：`cd server && npx tsc -p tsconfig.json --noEmit` exit 0；
  `npx jest src/prisma/seed.spec.ts` → 12/12 全绿（含新增断言）。
- 注意：工作区另有并行改动（worker 4 文件、`.omo/boulder.json` 前人遗留、本 notepad
  的 worker 段），本次提交仅含 2 个 seed 文件，未纳入他人改动，未 push。
- Commit：`docs(seed): align role prompts with effective tool allowlist`。

## 2026-09-14 · web 门控工具只读徽章（Todo web DoneClaim 要点）

- `EffectivePermission` +`serverGated?: string[]`（可选，后端未返回时按空集处理，
  非门控行行为零变）。
- 单一判定 `isServerGated(tool)`：经 `matrixAliasesOf` 取三别名
  `[name, action, vteam_<action>]`（去重，与 `effectOf` 同一优先级），任一命中
  `serverGated` 即门控；`effectOf` 保持 allow/ask/deny 唯一出口不动，
  `matrixKeyOf`/PATCH 路径不动；`handleToolChange` 首行拒掉门控行（纵深防御，
  双保险不可 PATCH）。
- 门控行渲染：左侧文案 `仅主 Agent · 服务端判定（主实例）`（不再走 effectOf 的
  拒绝红字），右侧 `ServerGatedBadge` 只读 pill（sky 系 `#0369A1`，区别于三态色，
  EffectBadge 同款 padding/radius/字号，`title` 提示判定权在服务端主实例）；
  无 `ToolEffectSelect`、不可点击。行 `data-server-gated="true"/"false"`，
  徽章 `data-testid="server-gated-badge"` + `data-server-gated="true"`。
  custom/clone 同一渲染路径，天然同徽章（永不可编辑）。
- Live 验证：`GET /agents/a_developer` 的 `serverGated` 5 项齐全；但库内种子数据
  陈旧——`permission` 仍含门控 deny 键（`vteam_plan_mode` 等）且 `/tools?source=mcp`
  无 `vteam_task_create`（22 项旧种子）。Web 以 `serverGated` 为准绳先行判定，
  所以页面正确（4 行徽章，第 5 项无目录行可渲染；重跑 seed 后自动补齐，无需改 web）。
- 验证：`cd web && npx tsc --noEmit` exit 0；
  `npx next lint --file 'app/(main)/agents/page.tsx'` 唯一 warning
  （`deleting` 未使用）经 `git diff` 确认不在本次 diff，属基线遗留。
- 证据：`.omo/evidence/permission-matrix/web-server-gated.png`（dev 服
  `API_PROXY_TARGET=http://localhost:13000` + Playwright 登录截图；脚本放 /tmp，
  未落仓）：4 门控行均 `仅主 Agent` 蓝徽章、零分段控制，其余行三态控制照常。
- Commit：`feat(web): show server-gated tools as main-agent-only`（仅 page.tsx +
  截图 + 本 notepad，未 push）。

## 2026-09-14 · e2e 矩阵拆分复现脚本（Todo e2e DoneClaim 要点）

- 新增 `scripts/e2e-permission-matrix.sh`（唯一源码改动），10 步全绿、连续 3 次
  `PASS permission-matrix`（exit 0）：0 哨兵新鲜度 → 1 门控 6 角色×5 工具 allow +
  `vteam_member_remove` deny（含越界拦截文案）→ 3 新增 allow（PM chat_history、
  dev doclib、6 角色 wecom_reply）→ 6 回归 deny（plan group_post、dev
  issue_create）→ 2 层① 6 内置 agent permission 无门控键 → 4a/4c 非主实例
  plan_mode/task_transition 双 -32003 403 → 4b 主实例 plan_mode 同值写成功 →
  4d 主实例 task_transition 状态非法动作仅 409 → 5 两侧常量逐项一致。
- 服务端门用真实 HTTP（`POST /api/v1/platform-mcp` + `x-worker-id`/
  `x-worker-token`，JSON-RPC `tools/call`）：注意 controller 恒回 HTTP 200，
  403 体现在 body `error.code=-32003` + `message=[403] …仅主 Agent…`——断言必须
  看 body 而非 HTTP 状态。非主实例用 DB 会话兜底选
  `sessions.team_member_id <> main`（本次为 `tmm_0000000001`）；主实例
  `tmm_0000000002`，任务 `t_0000000001`（pending/planMode=0）。
- 幂等设计：plan_mode 传 DB 当前值（同值 no-op）；task_transition 按状态选永非法
  动作（completed→start，其余→archive），主实例恒得 409
  `TASK_INVALID_TRANSITION` 不落库；4d 额外断言任务 status 未变。脚本业务只读，
  无行创建，无需清理（EXIT trap 仅清 mktemp）。
- `docker compose cp` 会保留容器源文件 mtime（evidence 中
  injected-opencode.json 显示旧时间戳属正常），新鲜度以字节比对为准，脚本断言
  内容不看 mtime。鲜度门用 guard 哨兵（PM task_transition）而非 mtime：失活才
  `up -d --force-recreate worker` + 轮询。
- 主从实例 id 来源：`teams.main_agent_member_id` + `sessions(worker_id,
  team_member_id)`；token 链 `X_WORKER_TOKEN → WORKER_TOKEN → repo .env →
  compose-worker-token`，worker id 默认 `w_compose_worker`。
- 证据：`.omo/evidence/permission-matrix/` 下 `guard-decision.json`（41 条原始
  判定）、`server-gate-nonmain-*.json`（双 403 body）、
  `server-gate-main-*.json`、`injected-opencode.json`、`roles.json`、
  `constants-{server,worker}.json` + `constants-compare.txt`、`e2e.txt`。
- Commit：`test(e2e): verify default permission matrix split`（仅本脚本 + 证据 +
  本 notepad，未 push）。
