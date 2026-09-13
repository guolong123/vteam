# vteam-role-behavior-enforcement - Work Plan
## TL;DR (For humans)

**What you'll get**: 五个内置角色（产品经理/架构师/开发者/测试/项目经理）从"同一套工具、只靠提示词区分"变成"职责可指导、越权被物理拦截、越界得到纠正指令"。两层强制：**① opencode 原生 `agent.<name>.permission.edit` 路径 glob（`edit` 是 edit/write/apply_patch 的唯一原生闸门）做主要文件写约束，随配置生效、`--pure` 下仍生效；`permission.read` glob 约束读取；vteam MCP 工具按**真实暴露名 `vteam_<action>`** 收窄；所有角色 `permission.task:"deny"` 禁子代理。② worker 注入 guard 插件 `tool.execute.before`：**仅对未知/自定义/MCP 工具做 allowlist 默认拒绝**，read 类交层①、edit 类按 writeGlobs、bash 仅按硬化模式、`task`/`execute` 拒绝，并回传越界纠正**。种子里固化五条角色策略并绑定模板 Agent，开箱即用。

**Why this approach**: 当前 `agent_tool_effects`/`permissionScope` 运行时零消费点，`ExecutionPolicy→opencode` 是死代码。opencode 原生 `permission.edit` 支持路径 glob 且随配置生效（`--pure` 只禁插件）；已核实 `write`/`edit`/`apply_patch` 均走 `edit` 权限、`task` 工具名为 `task`、`Wildcard.match` 的 `*`→`.*` 跨分隔符。子代理不继承父 agent 权限，故用 `task:"deny"` 封堵绕过。

**What it will NOT do**: 不按 4 角色重构；不做双轨；不在 worker 硬编码角色语义；不改动 vteam MCP"仅主 Agent"门；不迁移 omo 全量 hooks；不新建策略管理前端页；不用绝对路径 glob；不依赖子代理权限继承；不用 MCP 工具裸名（必须带 `vteam_` 前缀）。

**Effort**: 大。约 24 个实现 todos 分 5 波 + 4 项最终验证；无 Prisma migration。

**Risk**: 中高。opencode 版本未锁定（`worker/Dockerfile:30`）；MCP 工具名必须用真实暴露名 `vteam_<action>`；guard 生命周期须防"残留 enabled 导致全平台 fail-closed"；均已按评审修复。

**Decisions**: 见"Decision highlights"与"Degradation states"。

### Decision highlights
- 角色集：保留 5 角色，重划边界（产品=需求+原型；架构师=技术方案/设计文档；开发者=编码+实现说明；测试=用例/计划/执行/报告；项目经理=流程控制）。
- enforcement 唯一来源：`ExecutionPolicy`（角色模板策略，`agents.policyId` 绑定；clone 继承；custom 经 DTO）。单一 `ExecutionPolicyService`（`execution-policies/`）。
- **统一角色命名空间 = opencode agent 名**（`vteam-plan`、`vteam-<role>`）；**统一工具命名空间 = 真实暴露名**（MCP：`vteam_<action>`，前缀取自注册的 MCP server 名 `vteam`，`seed.ts:427-440`；自定义工具：其注入 action 名）。
- 强制层①（主）：`permission.edit` 路径 glob + `permission.read` glob + `permission.bash` + MCP/自定义工具 `permission.<真实名>:"deny"` + **`permission.task:"deny"`（所有角色）**；glob 用**通用根无关形式 `**tasks/*/<subdir>/**`**（两种 worktree 均命中；绝对路径无效）。
- 强制层②（辅）**分支优先级**：`roles.json` 缺失/`enabled!==true` → pass-through；session 未映射/agent 未知 → pass-through（非角色会话）；**仅当 session 已映射且角色条目存在**才强制——read 类（`read`/`grep`/`glob`/`lsp`/`webfetch`/`todowrite`）交层①；`edit`/`write`/`apply_patch`（兼容 `patch`/`multiedit`）按 `edit` 策略/writeGlobs；`bash` 仅按 `bashDeny` 硬化（不匹配即放行，再由层① `permission.bash` 生效）；`task`/`execute` deny；**其余未知/自定义/MCP 工具按 `tools` allowlist，未列出即 deny**；角色条目残缺 → fail-closed。
- 子代理：`permission.task="deny"` 使 task 调用在**运行时被拒绝**（`Permission.ask` → `DeniedError`），**并非"工具隐藏"**；不依赖继承。
- 优先级：绑定策略且 worker 能力位 `enabled && names.includes(agent)` 真 → `agent = effectivePlan ? 'vteam-plan' : 'vteam-<role>'`；否则现状回退。
- **失败中性化**：`/agent-policies` 拉取失败或角色集为空时，injector 主动写 `roles.json{enabled:false}` 并移除 guard 插件文件与 `plugin` 条目（同停用清理），再置能力位假——杜绝残留 enabled guard 造成全平台 fail-closed。
- 测试：tests-after，更新 `seed.spec.ts`，e2e 含服务端绑定会话 + 成员 JWT + serve 回读 + INCONCLUSIVE。

### Degradation states
| 状态 | 层① 原生 permission | 层② guard |
|---|---|---|
| 正常（非 pure + guard 注入成功 + `roles.json.enabled=true` + session 已映射且角色条目完整） | 生效 | 生效（分支优先级见 Decision highlights） |
| `--pure`（OPENCODE_PURE=1 或 OmO 关闭） | **仍生效（仅原生 edit/write 等）** | 插件不加载：bash 绕过/自定义工具无守卫、无纠正；worker 阻断级告警 |
| guard 加载但 `roles.json` 缺失或 `enabled!==true` | 生效 | **pass-through + 告警** |
| guard 加载、enabled、但 session 未映射或 agentName 不在 roles | 生效 | **pass-through + 告警**（非角色会话，避免误伤默认 agent） |
| guard 加载、enabled、session 已映射但角色条目残缺 | 生效 | **fail-closed**：危险 bash、写类、`task`、`execute`、allowlist 外工具 deny + 纠正 |
| **`/agent-policies` 拉取失败或角色集为空** | 生效（旧 agent 节或残留，但 server 不再选策略 agent） | **主动中性化**：写 `roles.json{enabled:false}` + 移除插件文件与 `plugin` 条目 + 能力位置假 + 告警 |
| worker 能力位假（未注入成功） | server 不下发策略 agent → 无角色强制（回退现状） | 按上一条已中性化 |

## Scope
**In**:
- 种子：5 条角色 `ExecutionPolicy`（`config = { permission（edit/read glob + bash + task deny + `vteam_<action>` deny）, correction }`）+ 模板 Agent `policyId` 绑定（create/update）+ 升级语义；`seed.spec.ts` 同步（含 mock）。
- 规范单一来源：`ROLE_BOUNDARIES: Record<agentName, { scope, deliverables, handoffTo, writeGlobs, readGlobs, bashEffect, mcpDenies, toolAllows }>`（agent 名 key；工具名用真实暴露名），驱动提示词/策略/guard/测试。
- 提示词：五角色四方向重写（含越界拒绝与转交）；`buildSystemInstructions` 预取策略后注入【职责边界】段。
- server：单一 `ExecutionPolicyService` + `execution-policies` 模块；`GET /agent-policies`（worker 鉴权，输出 opencode agent 定义 + guard `{ enabled, roles }`，工具名带 MCP 前缀）；agent DTO/toAgentDto 暴露并绑定 `policyId`；clone 继承；dispatch 优先级 + 能力位（含名称）门槛 + 回退。
- worker：能力位上报（enabled + names）；injector **单写者**写 `opencode.json` + guard 制品（`roles.json` + `sessions/` + 插件文件，单一路径）+ manifest 显式清理 + **失败中性化**；guard 插件（分支优先级）；session→policy 映射；配置发现 / `--pure` / glob 基址断言；版本记录。
- 验证：单测、seed.spec、e2e（可复现命令 + 可回读断言）。

**Out / Must-NOT-Have**:
- 不按 4 角色重构；不删除架构师。
- 不保留 `toolEffects`/`permissionScope` 作为 runtime enforcement；不做双轨。
- 不在 worker 硬编码角色语义。
- 不改造 vteam MCP"仅主 Agent"门。
- 不迁移 omo 全量 hooks。
- 不覆盖存量 clone/custom agent 的 prompt（能力补齐除外）。
- 不做 ExecutionPolicy 管理前端页。
- 不使用绝对路径 glob；不依赖子代理权限继承；不使用 MCP 工具裸名。

## Verification strategy
- **单元/契约**：`execution-policies`（CRUD/模板只读/policyId DTO/clone 继承/单一 service）、`execution-policy.service.spec`（编译 + edit/read glob + task deny + `vteam_<action>` deny + 未绑定回退）、`agent-policy.resolver.spec`（优先级 + `vteam-plan` 职责 + `enabled && names.includes`）、`injector.spec`（单写者三节共存；guard 三制品路径；cleanup 完整；**失败中性化：成功后再失败 → enabled=false + 插件移除，不 fail-closed**）、`role-guard/policy.spec`（**分支优先级**：read 类放行、edit 越界 deny、bash 非匹配放行/匹配 deny、task/execute deny、未知/MCP allowlist 默认 deny、未映射 pass-through、残缺 fail-closed）、`session-policy-map.spec`、`worker-capabilities.spec`。
- **seed**：`seed.spec.ts`（mock `executionPolicy`；5 策略 upsert；模板 create+update 写 policyId；update 不含越权字段；prompt 四方向 + 转交 + 无禁用词）。
- **类型/Lint**：三端通过。
- **e2e（Todo 21）**：层①拒绝 + guard 纠正 + ask 权限确认（服务端绑定会话）+ `task` 契约断言 + clone；断言从 serve 回读或 API 状态；未触发判 **INCONCLUSIVE**。
- **回归**：`server`/`worker` 测试全绿。

## Execution strategy
- **Wave 0**（1）：基线提交。
- **Wave 1**（2-10）：glob 基址 spike + 角色映射常量 + 策略种子 + 五角色提示词 + seed.spec。前置 0。
- **Wave 2**（11-12）：单一 service、DTO/clone、`/agent-policies`。前置 1。
- **Wave 3**（15→14→13，16 独立，17→15）：injector 单写者与 guard 制品（含失败中性化）+ 能力位上报 + dispatch 优先级 + builder 改造 + 配置发现/`--pure` 断言。前置 2。
- **Wave 4**（18-20）：guard 插件、session 映射、guard 判定。前置 3。
- **Wave 5**（21-24）：e2e + 文档 + 回归 + 矩阵自检。前置 4。
- **依赖注记（左依赖右）**：`15→11/12`（跨波）、`14→15`、`13→14`、`17→15`、`18→15/16`、`19→18`、`20→18/19`、`16 独立`；其余并行。（Wave 3 的执行顺序为 15、14、13，与注记一致。）

## Todos

- [x] 1. 动代码前提交当前工作区基线
  References: `/Users/mac/01work/git-project/vteam`；`git status --porcelain`；`git log -1`
  Acceptance: 改动前工作区干净或先形成 baseline commit（`chore: baseline before role enforcement`）。
  QA: happy - `git status --porcelain` 空后开工；failure - 有未提交改动直接开工即违反。Evidence: `.omo/evidence/role-enforcement/baseline-git.txt`。
  Commit: `chore: commit baseline before role enforcement`
  Recommended task executor category: quick

- [x] 2. glob 基址 spike + 定义角色边界映射常量（agent 名 + 真实工具名）
  References: `server/src/common/constants/agent.constants.ts`；`worker/src/runtime/opencode-server.ts`；`worker/Dockerfile:30`；`server/prisma/seed.ts:427-440`（MCP server 名 `vteam`）；`server/prisma/seed.ts:488-509`（工具真实暴露名 `vteam_<action>`）
  Acceptance: 实测 `Instance.worktree` 两种情形，通用根无关 glob `**tasks/*/<subdir>/**` 命中；禁用绝对路径与 `git init`。新增 `ROLE_BOUNDARIES: Record<agentName, { scopeSummary; deliverables; handoffTo; writeGlobs; readGlobs; bashEffect; mcpDenies: string[]; toolAllows: Record<string,'allow'|'ask'> }>`，key=opencode agent 名；`toolAllows`/`mcpDenies` 的键必须是**真实暴露名**（MCP 用 `vteam_<action>`，前缀取自注册 server 名 `vteam`；自定义工具用注入 action 名）。
  QA: happy - spike 证据含两种 worktree 命中/不命中；常量中所有 MCP 键带 `vteam_` 前缀且与 `seed.ts:488-509` 名一致；failure - 出现裸 MCP 名或绝对路径则失败。Evidence: `.omo/evidence/role-enforcement/glob-base-spike.md` + `agent.constants.spec.ts`。
  Commit: `feat(seed): resolve glob base and add canonical role boundary map`
  Recommended task executor category: deep

- [x] 3. seed：新增 5 条角色 ExecutionPolicy 并绑定模板 Agent policyId
  References: `server/prisma/seed.ts:115-297`；`schema.prisma:485-495`、`:464`；Todo 2
  Acceptance: 5 行 `ep_<role>`（`type:'template'`，`config = { permission: { edit: globMap, read: globMap, bash: effect, task:'deny', "vteam_<action>":'deny' }, correction }`，**不含 `write` 键**）幂等 upsert；模板 Agent create 与 update 均写 `policyId`；策略 upsert 先于 agent upsert；不改 clone/custom 行。
  QA: happy - 空库 seed 后 5 策略存在、5 模板 policyId 非空；重跑幂等。failure - 策略缺失时绑定 null 并告警。Evidence: `server/src/prisma/seed.spec.ts` + `.omo/evidence/role-enforcement/seed-db.txt`。
  Commit: `feat(seed): add role execution policies and bind template agents`
  Recommended task executor category: unspecified-high

- [x] 4. buildSystemInstructions 注入【职责边界】段（预取策略，保持同步纯函数）
  References: `server/src/chat/worker-dispatcher.ts:268-335`、`:212-242`；`execution-policies/execution-policy.service.ts`
  Acceptance: `BuildSystemInstructionsOptions` 新增 `boundarySection?: string`；调用方先 await 解析策略再传入；未绑定不注入（字节级不变）。
  QA: happy - 绑定产品策略输出含【职责边界】+scopeSummary；failure - 未绑定输出与基线一致。Evidence: `server/src/chat/worker-dispatcher.spec.ts`。
  Commit: `feat(dispatch): inject role boundary section from execution policy`
  Recommended task executor category: unspecified-low

- [x] 5. 重写产品经理提示词（需求+原型，越界拒绝/转交）
  References: `seed.ts:115-148`；Todo 2；docs 16 §3
  Acceptance: 四方向齐全；只做需求分析与原型设计；含拒绝话术与转交（编码→开发者/测试→测试/方案→架构师/流程→项目经理）；移除 UI 设计转交；不含"主 Agent"/"牵头协调者"。
  QA: happy - 断言四方向+正确转交；failure - 禁用词或错误转交则失败。Evidence: `.omo/evidence/role-enforcement/seed-spec.txt`。
  Commit: `feat(seed): rewrite product manager role prompt`
  Recommended task executor category: writing

- [x] 6. 重写架构师提示词（技术方案/设计文档，只读代码）
  References: `seed.ts:182-212`；Todo 2；docs 16 §5
  Acceptance: 四方向齐全；只产出方案/设计文档，不编码、不写仓库；只读核对仓库用 `git_clone`/`git_pull`/`git_status`/`git_diff`/`git_log`（只读，已列入矩阵 toolAllows）；越界转交开发者；不含禁用词。
  QA: happy - 四方向+边界+转交开发者；failure - 出现实现代码职责则失败。Evidence: `.omo/evidence/role-enforcement/seed-spec.txt`。
  Commit: `feat(seed): rewrite architect role prompt`
  Recommended task executor category: writing

- [x] 7. 重写开发者提示词（实现说明+编码）
  References: `seed.ts:213-245`；Todo 2；docs 16 §6
  Acceptance: 四方向齐全；产出代码+实现说明（含验证方式）；不做需求定义、不替代测试判定；接收缺陷修复；不含禁用词。
  QA: happy - 四方向+编码职责+缺陷修复衔接；failure - 出现需求/验收判定则失败。Evidence: `.omo/evidence/role-enforcement/seed-spec.txt`。
  Commit: `feat(seed): rewrite developer role prompt`
  Recommended task executor category: writing

- [x] 8. 重写测试提示词（用例/计划/执行/报告，不改代码）
  References: `seed.ts:246-277`；Todo 2；docs 16 §7
  Acceptance: 四方向齐全；产出用例/计划/执行/报告；不改实现代码；不越权验收；含拒绝话术。
  QA: happy - 四类产出物+不改代码+不越权验收；failure - 出现修复代码则失败。Evidence: `.omo/evidence/role-enforcement/seed-spec.txt`。
  Commit: `feat(seed): rewrite tester role prompt`
  Recommended task executor category: writing

- [x] 9. 重写项目经理提示词（只做流程控制/进度）
  References: `seed.ts:149-181`；Todo 2；docs 16 §9.2
  Acceptance: 四方向齐全；仅拆解编排/进度/风险/阻塞协调；不产出需求/方案/代码/用例；不越权验收；越界拒绝话术。
  QA: happy - 含"流程控制/进度"与"不产出具体交付物"；failure - 出现编码/需求/用例职责则失败。Evidence: `.omo/evidence/role-enforcement/seed-spec.txt`。
  Commit: `feat(seed): rewrite project manager role prompt`
  Recommended task executor category: writing

- [x] 10. 更新 seed.spec.ts
  References: `server/src/prisma/seed.spec.ts:8-24`（mock 加 `executionPolicy:{upsert}`）、`:65`、`:83-98`；Todo 2-9
  Acceptance: 断言 5 策略 upsert；模板 create+update 均含 policyId；update keys=`['policyId','prompt']` 且不含 `permissionScope/name/persona/defaultModelId`；策略 upsert 先于 agent upsert；各 prompt 四方向+转交+无禁用词。
  QA: happy - 该 spec 全绿；failure - mock 缺 key 抛 TypeError 即未完成。Evidence: `.omo/evidence/role-enforcement/seed-spec.txt`。
  Commit: `test(seed): cover role policies and prompt boundaries`
  Recommended task executor category: unspecified-high

- [x] 11. 单一 ExecutionPolicyService + ExecutionPolicy 模块 + DTO/clone policyId 绑定
  References: `execution-policies/execution-policies.module.ts`；`platform-mcp/execution-policy.service.ts`（删除重复）；`agents.service.ts:161-188/196-222/246-285/492-512`；`dto/create-agent.dto.ts:100`、`update-agent.dto.ts:72`；`app.module.ts`
  Acceptance: 仅一个 `ExecutionPolicyService`（`execution-policies/`）provide/export、`app.module` 注册、ChatModule 可注入（避免循环依赖）；CRUD 可用、template 写 403；DTO 校验 permission；create/update 持久化 policyId；clone 复制；toAgentDto 返回。
  QA: happy - clone 继承；custom 经 PATCH 改 policyId 生效；member 改 template 403。failure - 非法 permission 400。Evidence: `execution-policies.controller.spec.ts` + `agents.service.spec.ts`。
  Commit: `feat(policy): unify service, bind policyId on agent create/clone/update`
  Recommended task executor category: unspecified-high

- [x] 12. GET /agent-policies：生成 opencode agent 定义 + guard `{enabled, roles}`（agent 名 + 真实工具名）
  References: `execution-policies/execution-policy.service.ts`、`mcp-servers/mcp-servers.service.ts`、`server/src/workers/worker-or-jwt.guard.ts`；`seed.ts:427-440`/`:488-509`；Todo 2
  Acceptance: 返回 `{ agents: [{ name: 'vteam-<role>'|'vteam-plan', permission: { edit: globMap, read: globMap, bash: effect, task:'deny', "vteam_<action>":'deny' } }], guard: { enabled:true, roles: Record<agentName, { permission, tools, bashDeny, correction }> } }`；key 一律用 opencode agent 名；**工具名一律用真实暴露名**（MCP `vteam_<action>`，前缀取自注册 server 名）；不含 `write` 键；含 `vteam-plan` + 5 角色；glob 用 Todo 2 通用形式；策略缺失回退最小权限。
  QA: happy - worker token 拉取返回 6 定义；`guard.roles` key 与 `agents.name` 完全一致；所有 MCP 键带 `vteam_` 前缀；未鉴权 401。failure - 出现裸 MCP 名、key 不一致或缺策略返回默认。Evidence: `agent-policies.controller.spec.ts`。
  Commit: `feat(policy): expose agent definitions and guard roles with real tool names`
  Recommended task executor category: unspecified-high

- [x] 13. dispatch 优先级 + 能力位（含名称）+ 回退现状
  References: `worker-dispatcher.ts:1580-1618`、`:3056-3072`；`common/opencode-agent-duty.ts:27`；Todo 14
  Acceptance: 仅当 `worker.capabilities.agentPolicies.enabled === true && names.includes(候选 agent)` 时：`agent = effectivePlan ? 'vteam-plan' : 'vteam-<role>'`；否则**保持现状**（`opencodeAgentName` 有值则传，否则不传）；`vteam-plan` 加入计划职责集合；能力位假/名称不在清单/端点缺失一律不传策略 agent。
  QA: happy - 断言（enabled × names 含/不含 × 绑定/未绑定）组合；failure - 未绑定 payload 与基线一致。Evidence: `worker-dispatcher.spec.ts` + `opencode-agent-duty.spec.ts`。
  Commit: `feat(dispatch): capability+name gated policy agent selection`
  Recommended task executor category: unspecified-high

- [x] 14. worker 能力位上报（enabled + names；依赖 Todo 15 的注入结果）
  References: `worker/src/protocol/worker-protocol.ts:33-63`；`worker/src/index.ts`（buildCapabilities）；`server/src/workers/workers.service.ts`；Todo 15
  Acceptance: `WorkerCapabilities.agentPolicies?: { enabled: boolean; names: string[]; generatedAt?: string }`；由 Todo 15 的 injector 成功写入 agent 节后置 `enabled:true` 且 `names`=本次写入名，失败/中性化后置 false/[]；随注册/心跳上报；server 暴露 `workerSupportsAgentPolicies(worker, agentName)`（旧数据缺失=false）。
  QA: happy - 注入成功后 capabilities 含 enabled:true 与 6 名；失败/中性化 false。failure - 旧 worker 无字段视为 false。Evidence: `worker/index.spec.ts` + `workers.service.spec.ts`。
  Commit: `feat(worker): advertise agent policy capability with names`
  Recommended task executor category: unspecified-high

- [x] 15. worker injector 单写者注入 + guard 制品 + 完整清理 + 失败中性化
  References: `injector.ts:132-237`、`:82-86`、`:519-538`、`:255-268`
  Acceptance: agent 节写入**并入 `injectMcp()` 同一次读改写**（禁止并行写同一文件）；guard 制品：`<workDir>/.vteam-role-guard/roles.json`（`{ enabled: boolean, roles: Record<agentName,{permission,tools,bashDeny,correction}> }`）、`<workDir>/.vteam-role-guard/sessions/`、`<workDir>/.opencode/plugin/vteam-role-guard.ts`；成功后按 Todo 14 置能力位；`InjectManifest` 增 `agentNames`/`guardRolesFile`/`guardSessionsDir`/`guardPluginFile`；`cleanupByManifest` 显式分支（skills→删目录、tools→删文件、agentNames→重写 opencode.json 删除不在集合名、guardRolesFile→删文件、guardSessionsDir→删目录、**guardPluginFile→删插件文件并从 opencode.json `plugin` 数组移除条目**；绝不把新键走 tools 分支）；**失败中性化**：`/agent-policies` 拉取失败或角色集为空时，主动写 `roles.json{enabled:false}`（或删除）**并**移除插件文件与 `plugin` 条目（同停用清理），再置能力位假 + 告警——绝不留下 `enabled:true` 的残留 guard。
  QA: happy - 一次运行 mcp/plugin/agent 三节共存且幂等；停用后 agent 名、roles.json、sessions、插件文件与 plugin 条目一并清理；**"成功后再失败"用例：guard pass-through（非 fail-closed）**。failure - 并发写丢节、漏删插件条目、新键误删、残留 enabled 即失败。Evidence: `injector.spec.ts`。
  Commit: `feat(worker): single-writer injection with full cleanup and failure neutralization`
  Recommended task executor category: unspecified-high

- [x] 16. 改造/退役 opencode-config-builder.ts
  References: `worker/src/resources/opencode-config-builder.ts`（死代码，无 import）
  Acceptance: 删除或改为 `buildAgentDefinitions(agents, guard)` 纯函数；无角色 `if`；有 spec；无遗留 import。
  QA: happy - spec 覆盖生成；failure - 未知字段抛错。Evidence: `opencode-config-builder.spec.ts`。
  Commit: `refactor(worker): replace dead builder with agent definition writer`
  Recommended task executor category: unspecified-low

- [x] 17. 配置发现 / `--pure`（含 worker 重启） / 通用 glob 基址断言 + 版本记录 + 回滚
  References: `worker/src/runtime/opencode-server.ts:296-345`；`worker/Dockerfile:30`；`worker/src/restart/restart-coordinator.ts`
  Acceptance: 断言 `Filesystem.findUp` 从 `directory=<workDir>/tasks/<id>` 解析到 `<workDir>/opencode.json` 的 `agent` 节；**pure 断言在 worker 侧完成**：以 `OPENCODE_PURE=1`（或关 OmO）重启 worker 后，**原生 `permission.edit` 管理的 edit/write 越界写入仍被层①拒绝**（措辞限定为原生 edit/write 类；自定义工具文件写与 shell 重定向写属 guard 依赖，pure 下无守卫，为非阻断已知项），且 worker 日志含"guard 未加载/降级"阻断级告警；复核 Todo 2 通用 glob 用真实 `relative(worktree,path)` 命中；记录实际 opencode 版本；给出回滚（unbind/重跑 seed + 删除 agent 节、roles.json、sessions、插件文件与 plugin 条目）。
  QA: happy - 命中样例 + pure 下原生 edit/write 越界被拒且日志告警；failure - 基址不符启用 Todo 2 前缀方案并回改常量。Evidence: `.omo/evidence/role-enforcement/config-discovery-pure-version.md`。
  Commit: `test(worker): assert config discovery, universal glob base, pure enforcement`
  Recommended task executor category: deep

- [x] 18. guard 插件 vteam-role-guard.ts + 注册 + 发现/hook 覆盖 spike
  References: `injector.ts:255-268`；opencode 插件 `tool.execute.before`；`.vteam-role-guard/roles.json`
  Acceptance: 写 guard 插件并在 opencode.json `plugin` 节注册（发现目录以 spike 实测为准，回退用绝对路径）；从 `.vteam-role-guard/roles.json` 按 agentName 读策略；记录 hook 签名/`sessionID`/工具参数键（`edit`/`write` 为 `filePath`，`apply_patch` 为 `patchText`，`bash` 为 `command`）与 MCP/custom/git 工具是否触发；MCP 若未触发则用层①真实名 permission 拦截。
  QA: happy - 插件加载且越界 throw；MCP 结论入档。failure - 目录不生效则绝对路径回退生效。Evidence: `.omo/evidence/role-enforcement/guard-plugin-spike.md`。
  Commit: `feat(worker): add role guard plugin with discovery spike`
  Recommended task executor category: deep

- [x] 19. session→policy 映射（agentName key）+ 原子写 + 清理 + 未映射放行语义
  References: `exec-server.ts:1107-1130`、`:1137-1141`；`.vteam-role-guard/sessions/`
  Acceptance: prompt 前写 `<workDir>/.vteam-role-guard/sessions/<opencodeSessionId>.json`（`{ agent: <agentName>, dir }`，临时 rename）；结束删除；**未映射 session/未知 agent → guard pass-through（不 fail-closed）**；已映射但角色残缺 → fail-closed；不依赖子代理继承；读取缺失不阻断执行启动。
  QA: happy - 并发会话文件正确、结束清理；未映射 session 不被误拒；已映射残缺角色 fail-closed。failure - 写失败仅告警。Evidence: `session-policy-map.spec.ts`。
  Commit: `feat(worker): track session policy keyed by agent name with safe fallback`
  Recommended task executor category: unspecified-high

- [x] 20. guard 判定（分支优先级 + 真实工具名 + bash 硬化 + 纠正）
  References: `.vteam-role-guard/roles.json` + `sessions/*.json`；opencode hook input/output
  Acceptance: `evaluateToolCall(agentName, session, tool, args)` **按固定优先级**：
    1) `roles.json` 缺失、`enabled!==true` 或 **JSON 解析失败** → allow（pass-through）+ 告警（解析失败绝不 fail-closed）；
    2) session 未映射或 agentName 不在 `roles` → allow（pass-through）+ 告警；
    3) 角色条目残缺 → deny（fail-closed）+ 纠正；
    4) 分支：**read 类**（`read`/`grep`/`glob`/`lsp`/`webfetch`/`websearch`/`list`/`todowrite`/`todoread`）→ allow（交层①）；**edit 类**（固定 `edit`/`write`/`apply_patch`，兼容 `patch`/`multiedit`）→ 按 `edit` 策略/writeGlobs，越界 deny（**固定列表；worker 无 opencode 依赖，不 import `Permission.disabled`/`EDIT_TOOLS`**，以 Todo 18 spike 记录的版本为准）；**`bash`** → 仅按 `bashDeny`（`>`/`>>`/`tee`/`cp`/`mv` 到白名单外/`sed -i`/`truncate`/`dd`/`ln`/`python -c`/`node -e`/`node <file>`/`perl -i`/`git apply`/`patch`/`git push`/`rm`）命中即 deny，未命中 allow（再由层① `permission.bash` 生效）；**`task`/`execute`** → deny；**内置通行集**（不属上述类别的内置工具）：`question`/`plan_exit`/`skill` → allow（交层①）；`browser` → 仅当在角色 `tools` allowlist 时 allow，否则 deny；**其余未知/自定义/MCP 工具**（真实名，MCP 为 `vteam_<action>`）→ 角色 `tools` allowlist，未列出即 deny（**默认拒绝只覆盖未知/自定义/MCP，不覆盖内置通行集**）；
    5) 纠正文案：`【越界拦截｜角色：X】不能调用 <tool>。职责：<scope>。请 <建议> 或 notify_agent 转交 <角色>。`
  QA: happy - `read` 与 `git status` 放行；`write` 越界 deny；`vteam_*` 未 allowlist deny；`task`/`execute` deny；未映射 pass-through；残缺 fail-closed。failure - 开发者 writeGlobs 内写放行；bash 非危险命令走层① ask/allow。Evidence: `worker/src/role-guard/policy.spec.ts`。
  Commit: `feat(worker): guard branch-precedence decision with real tool names`
  Recommended task executor category: unspecified-high

- [x] 21. e2e：可复现脚本（层①拒绝 + guard 纠正 + ask 确认 + task 契约 + clone）
  References: Todo 3/12/13/14/15/17/18/19/20；`scripts/`；`server/src/questions/questions.service.ts:325-439`、`:442-465`；`server/src/workers/session-lifecycle.service.ts:80,149`；`server/src/questions/questions.controller.ts:41-88`；`server/src/questions/dto/reply-question.dto.ts:10-29`；`server/src/chat/chat.controller.ts:156`（`POST /api/v1/channels/:id/messages`）与 `:49`（`GET /api/v1/channels?teamId=`）；`server/prisma/seed.ts:14,948-971`；`worker/src/exec/exec-server.ts:63-67`；`worker/src/config.ts:144`、`worker/src/runtime/opencode-server.ts:342`、`worker/.env.example:27`；`worker.client.ts:921-929`
  Acceptance: 新增 `scripts/e2e-role-boundaries.sh`。
    - env：`SERVER_URL`、`X_WORKER_TOKEN`、`WORK_DIR`、`SERVE_BASE_URL`、`OPENCODE_SERVER_PASSWORD`（Basic auth，username=opencode；**不用笔误名**）、`WORKER_EXEC_URL`（或写明由 `SERVE_BASE_URL` origin + execPort 4198 推导）、`MEMBER_JWT`。
    - setup：`POST /api/v1/auth/login` 用 **seed-admin/Admin@123456**（`tm_0000000001` owner）取 `accessToken`；`POST /api/v1/tasks {title, teamId:"tm_0000000001"}` 取 `taskId`；`taskDir=$WORK_DIR/tasks/$taskId`。
    - 直连断言（a/d/e/g）：`POST {SERVE_BASE_URL}/session`（Basic auth）取 `SID`；`POST {WORKER_EXEC_URL}/execute` 传 `{agent:'vteam-<role>', directory:taskDir, sessionId:SID, taskId, agentId:'a_<role>', prompt:[{type:'text',text:...}]}` 得 202；轮询 `GET {SERVE_BASE_URL}/session/SID/message`（Basic auth）回读：a) 产品改 `taskDir/server/src/foo.ts` 出现层① edit 拒绝（字面子串由 Todo 17 spike 确认）；d) 开发者放行；e) 项目经理 bash 被拒；g) clone 产品角色仍被拒。
    - ask 断言（c，**必须服务端绑定**）：不直连 serve 造会话；创建任务后经群聊接口 `POST /api/v1/channels/:id/messages`（`chat.controller.ts:156`；channel id 经 `GET /api/v1/channels?teamId=`）发送 `@测试-1` 执行测试命令的指令，使 dispatcher 建立并绑定 Session；轮询 `GET /api/v1/questions?taskId=$taskId&status=pending`（Bearer MEMBER_JWT）取 permission question id；`POST /api/v1/questions/:id/reply {"response":"once"}`；断言 reply 返回 200（非 503 `QUESTION_WORKER_UNAVAILABLE`）且该 question 不再 pending。
    - task 断言（f，**确定性契约**）：断言 `/agent-policies` 与注入的 `opencode.json` 均含 `permission.task="deny"`（运行时 task 调用经 `Permission.ask` 被拒绝，**非"工具隐藏"**）；并附一个 **guard 策略单测**：给定角色规则集，权限判定对 `task` 返回 deny（**不 import opencode 内部 `Permission.disabled`**——worker 无 opencode 依赖）；可选 e2e 断言 task 调用返回拒绝。
    - 通用规则：任意场景轮询超时未见预期工具/消息即判 **INCONCLUSIVE 并失败，禁止记为通过**；证据存原始响应 JSON。
  QA: happy - a/c/d/e/f/g 全过且证据含原始 JSON 与 taskId；failure - 任一未拦截/未触发即失败/INCONCLUSIVE；ask 若 503 即 fail（检查是否经服务端绑定）。Evidence: `.omo/evidence/role-enforcement/e2e-role-boundaries.txt`。
  Commit: `test(e2e): runnable layered role enforcement with bound-session ask flow`
  Recommended task executor category: unspecified-high

- [x] 22. 文档更新（16/15/A1 + 降级表 + 回滚 + 版本 + README 笔误）
  References: `docs/agent-platform/16-...md`、`15-...md`、`A1-opencode-channel-report.md`、`worker/README.md:70`
  Acceptance: 16 篇五角色默认表与 seed 策略一致（含项目经理、移除 UI 设计内置）；15 篇补 ExecutionPolicy 与 policyId；A1 报告更新"通道①已落地"，记录 `edit` 唯一写闸门、通用 glob、opencode 版本、`task` 禁用、guard 分支优先级与失败中性化、真实工具名 `vteam_<action>`；写 Degradation states 与回滚；修正 `worker/README.md:70` 笔误为 `OPENCODE_SERVER_PASSWORD`；不再声称 toolEffects/permissionScope 生效。
  QA: happy - grep 一致；failure - 文档与实现冲突。Evidence: 文档 diff。
  Commit: `docs: document layered enforcement, guard lifecycle and rollback`
  Recommended task executor category: writing

- [x] 23. 回归：三端 typecheck + lint + 全量测试
  References: 三端 package.json
  Acceptance: 对应命令全绿。
  QA: happy - exit 0；failure - 修复后重跑。Evidence: `.omo/evidence/role-enforcement/regression.txt`。
  Commit: `test: full regression for role enforcement`
  Recommended task executor category: quick

- [x] 24. 能力矩阵自检（防漂移，含真实工具名与注册表一致性）
  References: Todo 2 常量、Todo 3 策略、Todo 12 定义、`server/prisma/seed.ts:488-509`、`mcp-servers` 注册表、`worker/src/git/git-tools.ts`
  Acceptance: 断言"agentName × 关键工具"矩阵与 Permission matrix 一致（层① `permission.edit`/`read` glob + `bash` + `task` + 工具 deny；层② guard 分支）；**按命名空间分别校验**：MCP 来源键（`vteam_<action>`）必须存在于 `tools` 表 `source='mcp'`（`seed.ts:488-509`）；自定义工具键（`git_*`）必须存在于 worker `GIT_TOOLS`（`worker/src/git/git-tools.ts`），二者命名空间独立、自定义键**不强制** `vteam_` 前缀；任一漂移即失败。
  QA: happy - 一致且全部键前缀正确；failure - 裸名/缺失/漂移即红。Evidence: `agent.constants.spec.ts` 扩展。
  Commit: `test: assert role tool matrix and real tool names match registries`
  Recommended task executor category: unspecified-low

## Final verification wave
- [ ] F1. 计划合规审计 — 抽查 References 真实存在、Acceptance 无歧义、QA 含命令与证据路径。Evidence: `.omo/evidence/role-enforcement/F1-plan-audit.txt`。
  Recommended task executor category: unspecified-high
- [ ] F2. 代码质量 review — worker 零角色硬编码；单一 ExecutionPolicyService；`edit` 唯一写闸门且全角色 `task` deny；工具名全用真实名；`opencode.json` 单写者；guard 三制品单一路径且 cleanup 完整、失败中性化；无死代码。Evidence: `.omo/evidence/role-enforcement/F2-code-quality.txt`。
  Recommended task executor category: unspecified-high
- [ ] F3. 真实手动 QA — 跑 Todo 21 脚本 a/c/d/e/f/g（含服务端绑定 ask 流与 INCONCLUSIVE 判定），确认 pure 下原生 edit/write 仍拒（Todo 17）、guard 分支与文案可操作、clone 正确。Evidence: `.omo/evidence/role-enforcement/F3-manual-qa.txt`。
  Recommended task executor category: unspecified-high
- [ ] F4. 范围保真 — 未重构 4 角色、无双轨、无 worker 角色语义、未动 MCP 主 Agent 门、未覆盖自定义 prompt、未用绝对路径 glob、未依赖子代理继承、未用裸 MCP 名。Evidence: `.omo/evidence/role-enforcement/F4-scope-fidelity.txt`。
  Recommended task executor category: unspecified-high

## Commit strategy
- Todo 1 先落 baseline commit。
- 每 todo 一 commit，前缀 `feat/fix/refactor/test/docs/chore` + 域。
- 无 Prisma migration。
- 合并且打 tag 前三端 typecheck + test 全绿。

## Success criteria
- 五角色 prompt 四方向 + 边界/转交；项目经理无编码/需求/用例职责；全部无"主 Agent"。
- seed 后 5 策略存在、5 模板 policyId 绑定（create+update）、clone 继承、重跑幂等不覆盖用户 prompt。
- `/agent-policies` 返回 `vteam-plan` + 5 `vteam-<role>`，`permission.edit`/`read` 为路径 glob，`permission.task=deny`，无 `write` 键；guard `roles` key 与 `agents.name` 完全一致；**所有 MCP 工具名带 `vteam_` 前缀**；glob 经两种 worktree 实测且未用绝对路径。
- 优先级无歧义且防绕过：能力位 `enabled && names.includes` 真 → 策略 agent；否则现状回退；`plan_mode.agentName` 不能提权。
- guard **分支优先级**正确：read 类交层①放行；edit 类按 writeGlobs；bash 仅硬化；task/execute deny；内置 `question`/`plan_exit`/`skill` 通行、`browser` 按 allowlist；未知/自定义/MCP 按 allowlist 默认 deny；未映射 session pass-through；残缺或解析失败 roles.json 不 fail-closed（残缺条目 fail-closed、解析失败 pass-through）。
- 失败中性化：`/agent-policies` 拉取失败/空角色集后不残留 enabled guard（pass-through），无全平台 fail-closed。
- e2e（2026-09-13 clean-slate 实测，证据 `.omo/evidence/role-enforcement/e2e-role-boundaries.txt`）：a/d/f/g VERIFIED（a/g 断言来自 serve 回读的 guard 拒绝；d 为写成功+读回；f 为配置契约 + 单测）；c/e 为 INCONCLUSIVE——c 的 @mention 已两次 dispatch 到服务端绑定会话（旧"任务永不 dispatch"阻塞已消除），但模型全程 prose 转交、未触发 ask 门控动作，故无 question 可 reply；e 三次尝试模型均因看不到 bash 工具而 prose 拒绝、未做门控调用（bash 被层①隐藏即 containment 本身，无破坏效应）。三端 typecheck/lint/test 全绿；F1-F4 APPROVE。

## Permission matrix（agentName → 工具；层① 原生 permission 为路径强制主层，层② guard 分支）

> key 为 opencode agent 名。**无原生 `write` permission**（`edit` 是 edit/write/apply_patch 的闸门）。glob 用通用根无关 `**tasks/*/<subdir>/**`。所有角色 `permission.task:"deny"`。**工具名一律真实暴露名：MCP 为 `vteam_<action>`**。guard 分支：read 类交层①；edit 类按 writeGlobs；bash 仅硬化；task/execute deny；其余未知/自定义/MCP 按 `tools` allowlist，未列出即 deny。

| agentName | 层① `permission.edit`（glob map） | 层① `permission.read` | 层① `permission.bash` | 层② guard `tools` allowlist（真实名；其余默认 deny） |
|---|---|---|---|---|
| `vteam-product` | `{"*":"deny","**tasks/*/prototypes/**":"allow","**tasks/*/docs/**":"allow"}` | `{"*":"allow"}` | deny | `vteam_submit_artifact`/`vteam_doclib`/`vteam_issue_create`/`vteam_issue_list`/`vteam_issue_get`/`vteam_issue_update`/`vteam_issue_transition`/`vteam_group_post`/`vteam_notify_agent`/`vteam_memory_save`/`vteam_memory_search`/`vteam_read_file`/`vteam_task_context`/`vteam_chat_history`/`vteam_team_view`/`vteam_my_profile` |
| `vteam-architect` | `{"*":"deny","**tasks/*/docs/**":"allow"}` | allow | ask | `vteam_submit_artifact`/`vteam_doclib`/`vteam_read_file`/`vteam_group_post`/`vteam_notify_agent`/`vteam_memory_save`/`vteam_memory_search`/`vteam_task_context`/`vteam_chat_history`/`vteam_issue_list`/`vteam_issue_get`/`vteam_team_view`/`vteam_my_profile` + 自定义只读 `git_clone`/`git_pull`/`git_status`/`git_diff`/`git_log` |
| `vteam-developer` | `{"*":"deny","**tasks/*/**":"allow"}` | allow | ask | `vteam_submit_artifact`/`vteam_read_file`/`vteam_group_post`/`vteam_notify_agent`/`vteam_memory_save`/`vteam_memory_search`/`vteam_task_context`/`vteam_chat_history`/`vteam_issue_list`/`vteam_issue_get`/`vteam_issue_update`/`vteam_issue_transition`/`vteam_team_view`/`vteam_my_profile` + 自定义 `git_clone`/`git_pull`/`git_status`/`git_diff`/`git_log` |
| `vteam-tester` | `{"*":"deny","**tasks/*/tests/**":"allow","**tasks/*/docs/**":"allow"}` | allow | ask | `vteam_submit_artifact`/`vteam_issue_create`/`vteam_issue_list`/`vteam_issue_get`/`vteam_issue_transition`/`vteam_read_file`/`vteam_doclib`/`vteam_group_post`/`vteam_notify_agent`/`vteam_memory_save`/`vteam_memory_search`/`vteam_task_context`/`vteam_chat_history`/`vteam_team_view`/`vteam_my_profile` + `git_clone`/`git_pull`/`git_status`/`git_diff`/`git_log` |
| `vteam-project_manager` | `{"*":"deny"}` | allow | deny | `vteam_task_context`/`vteam_group_post`/`vteam_notify_agent`/`vteam_issue_create`/`vteam_issue_list`/`vteam_issue_get`/`vteam_issue_update`/`vteam_issue_transition`/`vteam_memory_save`/`vteam_memory_search`/`vteam_team_view`/`vteam_my_profile`/`vteam_read_file`/`vteam_doclib` |
| `vteam-plan` | `{"*":"deny"}` | allow | deny | `vteam_task_context`/`vteam_read_file`/`vteam_doclib`/`vteam_team_view`/`vteam_my_profile` |

> vteam MCP"仅主 Agent"门由 platform-mcp.service.ts 保留，为第二道。guard `tools` 为白名单：未列出即 deny；`execute`/`task` 永不列入。
