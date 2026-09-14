# 计划：vteam-plan 转正为可见内置角色（@ 可触发，自带 subagent 扇出）

## TL;DR (For humans)

把 `vteam-plan` 从"影子身份"转正为第 6 个可见内置角色：DB 模板行 + `ep_plan` 策略 + seed 团队计划员成员 + 四方向 prompt，主 Agent `@计划员` 即可派活（起草与评审）。plan 成员可调 `task` 起只读评审子会话（`subagent_type` 恒为 `vteam-plan`，防绕过）；`plan_review` MCP + worker `/review` 整套删除（单路径，不留双轨）。

## 决策来源（用户确认）

- 「vteam-plan 默认内置一个角色，主 Agent 自己控制 @ 它来创建计划和评审计划」+「agent 管理能看到、群聊能看到」。
- 「1 删（`plan_review` + `/review`）」+「2 agent 默认列表增加计划员，新建团队用户自选」。
- 沿用约束：干净代码、不做 AB 双轨、不留退役说明；`execute` 身份未查明，保持全 deny。

## 已实测事实（本会话）

- opencode `task` 工具三道门：`ctx.ask({permission:'task'})`（原生）+ guard `TASK_TOOLS` + `agent.get(subagent_type)` 须解析 + `mode='primary'` 不可被 spawn；子会话默认 fresh（不传 `task_id` 即新会话）；深度默认 1 + `childToolDenies` 自动追加 `todowrite`/`task` 双 deny；权限经 `deriveSubagentSessionPermission` 从父派生（父越严子越严）。
- Guard 对未映射子会话 pass-through（by design），故评审子会话的硬约束只能来自层① + 服务端门。
- PM（seed 主 Agent）自身 `edit` 全 deny、`group_post` 有；plan 成员回群聊必须经 `group_post`（群聊只显示经此工具发布的内容）。
- `role='plan'` 全链路直通：`roleToAgentName`→`vteam-plan`、`isVteamAgentName`、`getOpencodeAgentDuty`→plan 均已覆盖，无需改映射函数。
- 现有 dispatch 的 plan-mode 身份 overlay（主 Agent 切 `vteam-plan`）**保留不动**：主 Agent 在计划期同样只需要只读 + plans 写 + 群聊 + question + 门控工具，扩大后的 vteam-plan 策略恰好覆盖。

## 冻结设计（唯一事实源）

### D1 vteam-plan 策略（读为主，窄口可写）
- `toolAllows` += `vteam_group_post`（回群聊唯一通道）；其余不变（`submit_artifact`/`issue_*`/`notify_agent` 不加；`memory_*` 不加）。
- `writeGlobs` += 计划目录 glob（新增 `planDirGlob()` helper，语义对齐 `taskSubdirGlob`；实现者须单测证明 `.opencode/plans/x.md` 命中、仓库路径不命中，层① 与 guard 双侧）。
- 层① `task: 'deny' → 'allow'`**仅 vteam-plan**（`buildRolePermission` 按名分支，其余 5 角色保持 deny）。
- `mode: 'primary' → 'all'`**仅 vteam-plan**（其余 5 个不动；`AgentPolicyDefinition.mode` 类型同步放宽）。

### D2 guard `task` 精确开口（policy.ts + 内联插件体，两处同改 + parity）
- 允许当且仅当：会话映射到 `vteam-plan` **且** `args.subagent_type === 'vteam-plan'`；其他一律走原分支（含 `execute` 全 deny 不变）。
- 注释写明原理：子会话无映射（pass-through），硬约束靠层①（只读 + 窄写 + `task` 自 deny 防套娃）+ 服务端主门。

### D3 seed 转正
- `a_plan`（type=template, role=`plan`, agentKey=`plan`, policyId=`ep_plan`）+ `ep_plan`（type=template，config 同 D1 形状）+ seed 团队计划员成员（`teamRoleMap`/`teamRoleLabels` 加 `plan→计划员`，alias `计划员-1`，非主 Agent，主 Agent 保持 PM）。
- plan 角色四方向 prompt（身份/职责/边界/协同：只读分析 + `.opencode/plans/**` 窄写 + 群聊回复 + @ 响应；禁实现/禁执行/禁用户问答越权由主 Agent 收口）+ docs 16 篇新增计划员章节。
- `plan-creation` skill 改写使用者为主 Agent→计划成员：删 `question`/`vteam_plan_review` 调用（用户交互与正式送审归主 Agent），加"扇出纪律"节（`subagent_type` 恒 `vteam-plan`、前台阻塞等结果、2~4 路、禁套娃、VERDICT 回收）。
- `plan-review-*` skill 加一句"可能以 subagent 身份运行"注记；检查清单不动。
- `tl_vteam_plan_review` 目录行随 tool 删除一并删。
- 新建团队：零改动（模板存在即用户可选；TeamMembersPanel 读 `/agents` 自动含新模板）。

### D4 删除 `plan_review` 整套（单路径）
- 删：`platform-mcp.tools.ts` 注册 + `platform-mcp.service.ts` handler 及私有方法（`resolveReviewPlan/runSingleReview/reviewWithTimeout/buildReviewPrompt/toReviewVerdict/normalizeReviewTimeout` + 超时常量；`describeReviewError` 若他用保留，否则同删；`WorkersService` @Optional 注入若仅评审用则同删）+ `platform-mcp.plan-review.spec.ts` + `WorkerClient.review` 及相关常量/spec + worker `/review` 路由/handler/类型/spec + `scripts/e2e-plan-skills.sh` + `e2e-permission-matrix.sh` 的 6 值断言回 5。
- `ROLE_SERVER_GATED_TOOLS` / worker 镜像集合删 `vteam_plan_review`（回 5 值）；`VTEAM_MCP_TOOL_NAMES` 保留 `vteam_task_create`（仍是注册工具）。

### D5 主 Agent 编排流（`PLAN_PRODUCE_INSTRUCTION` 改写，dispatch 逻辑不动）
`@计划员`派起草（含任务简报）→ 收群聊摘要 → `question` 选评审视角 → `@计划员`带视角清单派评审 → 收 VERDICT 聚合 → REJECT 则带 feedback 重派 → APPROVE 则宣布 → `task_transition` 出计划模式。

## Todos

- [x] 1. [policy+guard] vteam-plan 策略扩展 + task 精确开口 + mode all
  References: `server/src/common/constants/agent.constants.ts`（toolAllows/writeGlobs/ROLE_SERVER_GATED_TOOLS 减 plan_review）、`server/src/execution-policies/execution-policy.service.ts`（buildRolePermission 按名分支 task、buildAgentPolicies 按名 mode、AgentPolicyDefinition.mode 类型）、`worker/src/role-guard/policy.ts` + `worker/src/resources/role-guard-plugin.ts`（task 分支 resent）
  Acceptance: vteam-plan toolAllows 含 group_post 不含其他新增；writeGlobs 命中 plans 路径、不命中仓库路径（双侧单测）；层① vteam-plan task allow、其余 deny；mode 仅 vteam-plan 为 all；guard 仅 (vteam-plan 会话 + subagent_type==='vteam-plan') 放行 task，其余（含 execute、他角色 task、缺失 args）全 deny；server-gated 回 5 值。
  QA: tsc 双端 exit 0；相关 jest 全绿（含 parity 矩阵新增 task 分支用例）。Evidence: `.omo/evidence/plan-member/subagent-gate.txt`。
  Commit: `feat(policies): plan role member capabilities and scoped task spawn`
  Recommended task executor category: deep

- [x] 2. [seed] plan 转正：模板 + 策略 + 成员 + prompt + skill 改写 + 文档
  References: `server/prisma/seed.ts`（templateAgents/policy/member/prompt/skill/tool registry）、`server/src/prisma/seed.spec.ts`、`docs/agent-platform/16-内置Agent角色与提示词库.md`
  Acceptance: `a_plan`/`ep_plan`/计划员成员落库（成员非主 Agent）；plan prompt 四方向齐全；`plan-creation` 改写（使用者=计划成员，无 question/plan_review 调用，有扇出纪律节）；review skill 注记；删 `tl_vteam_plan_review`；16 篇同步。
  QA: seed 后 DB 行齐全；`npx jest src/prisma/seed.spec.ts` 全绿。Evidence: `.omo/evidence/plan-member/seed.txt`。
  Commit: `feat(seed): vteam-plan as built-in member role`
  Recommended task executor category: writing

- [x] 3. [flow] 删 plan_review 整套 + 主 Agent 编排指令改写
  References: `server/src/platform-mcp/platform-mcp.{tools,service}.ts`、`server/src/workers/worker.client.ts`、`worker/src/exec/exec-server.ts`、相关 spec、`scripts/e2e-*.sh`、`server/src/chat/worker-dispatcher.ts`（仅 PLAN_PRODUCE_INSTRUCTION 文本）
  Acceptance: plan_review 注册/handler/client/端点/spec/e2e 脚本全删无残留（grep 零命中，`tl_vteam_plan_review` 除外由 Todo 2 处理——两处都删，以 Todo 2 的 seed 行为准，此处只删代码）；`PLAN_PRODUCE_INSTRUCTION` 改为 D5 编排流且 plan-off 输出逐字节不变；dispatch 逻辑零改动。
  QA: tsc 双端 exit 0；相关 jest 全绿；`grep -rn plan_review server/src worker/src --include='*.ts' | grep -v spec` 仅剩 skill 文本引用。Evidence: `.omo/evidence/plan-member/removal.txt`。
  Commit: `refactor: remove server-orchestrated plan review in favor of member subagents`
  Recommended task executor category: deep

- [x] 4. [e2e] 计划成员 @ 触发 + subagent 评审全链路
  References: `scripts/e2e-permission-matrix.sh`（范式与门计数回 5）
  Acceptance: 脚本可复现：① seed 后 `a_plan`/`ep_plan`/成员在位；② worker 注入的 `vteam-plan` 定义为 mode all、task allow、plans 窄写、group_post 在列；③ guard 对 (vteam-plan, task+vteam-plan) allow，对 (他角色, task) 与 (vteam-plan, task+他名) 与 execute 全 deny；④ 真实 @ 触发计划成员起草并落盘计划文件；⑤ 计划成员起 fresh review subagent 并回 VERDICT（文本含 VERDICT 即算通过）；⑥ 子会话禁套娃（task 在子会话内 deny）；⑦ 内置 6 角色注入字节回归（vteam-plan 变更为预期内差异，其余 5 角色逐字节不变）。
  QA: happy - 七步全绿并留证据；failure - 任一不成立即失败。Evidence: `.omo/evidence/plan-member/e2e.txt`。
  Commit: `test(e2e): plan member subagent flow`
  Recommended task executor category: unspecified-high

## Final verification wave

- [x] F1. 计划合规审计 — Todos 全合入；References 真实存在；删除项零残留。Evidence: `.omo/evidence/plan-member/F1-plan-audit.txt`。
  Recommended task executor category: unspecified-high
- [x] F2. 代码质量 review — 无 `as any`/`@ts-ignore`/stub；无 AB 双轨/退役说明；新增 attack 面（task 开口、plans 窄写）有 tests 锁定。Evidence: `.omo/evidence/plan-member/F2-code-quality.txt`。
  Recommended task executor category: unspecified-high
- [x] F3. 真实手工 QA — @ 触发起草落盘 + subagent 评审 VERDICT + 禁套娃实测 + 页面可见计划员（群成员列表与 agent 管理）。Evidence: `.omo/evidence/plan-member/F3-manual-qa.txt`。
  Recommended task executor category: unspecified-high
- [x] F4. 范围保真 — 未越界；其余 5 角色行为零回归；`plan_review` 相关无残留引用（skill 文本对历史功能的描述性提及除外，需逐条说明）。Evidence: `.omo/evidence/plan-member/F4-scope-fidelity.txt`。
  Recommended task executor category: unspecified-high

## Success criteria

- 三端 tsc exit 0；相关 jest 全绿。
- `@计划员` 起草并落盘；fresh review subagent 回 VERDICT；禁套娃实测。
- 内置注入除 vteam-plan 预期变更外逐字节不变；`plan_review` 零残留。
