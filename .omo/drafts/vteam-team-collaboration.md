---
slug: vteam-team-collaboration
status: in-review
intent: clear
review_required: true
pending-action: dual high-accuracy review (momus + oracle) on .omo/plans/vteam-team-collaboration.md
approach: vteam 团队协作增强：计划平台化（plans/plan_tasks 数据域 + plan_* MCP 工具 + 双时点评审 + 状态机联动）+ 任务级执行模式切换（direct/plan）+ Agent 性格维度（persona）+ 团队感知 MCP（L1）+ L2 自治（复用 question_confirm）
---

# Draft: vteam-team-collaboration

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
| id | outcome (one line) | status | evidence path |
| --- | --- | --- | --- |
| tc-store | plans/plan_tasks 表（含 assigneeInstanceId）+ tasks.execution_mode 字段 + 迁移 + 模块骨架 | active | server/prisma/schema.prisma, tasks 模型 :122 |
| tc-mcp-plan | MCP plan_submit（六要素校验）/ plan_review / plan_task_transition | active | platform-mcp.tools.ts |
| tc-mcp-l1 | MCP team_view / my_profile（团队感知，只读） | active | platform-mcp |
| tc-flow | 状态机联动（start 前置按模式校验）+ 模式切换规则 | active | tasks.service.ts transitionOpts |
| tc-review | 双时点评审流程（计划前确认假设 + 计划后 plan_review）+ 系统消息 | active | tasks/platform-mcp + chat |
| tc-inject | GLOBAL_SYSTEM_INSTRUCTIONS【计划工作流】段（按 execution_mode 条件注入） | active | worker-dispatcher.ts |
| tc-persona | Agent 第五维【性格】段：预制性格库 + 安全阀 + 正交组合 | active | agents.prompt 模板 / 16 篇库 |
| tc-auth | L2 自治：主 Agent 申请增员（question_confirm 确认后执行） | active | platform-mcp + tasks updateTeam |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| execution_mode 默认 | 默认 'direct'（轻量），plan 按需开启 | 对齐 omo「默认轻量 + 关键词/配置按需开启」 | 是 |
| 评审位 | 用户默认 / 主 Agent 指派任意成员（notify_agent）；不绑角色 | 复用性 + FR-04/08 验收权在成员 | 是 |
| 评审准则 | 默认放行、REJECT 只拦 blocker（附具体 reason） | 对齐 Momus blocker-finder 哲学 | 是 |
| persona 落点 | agents.prompt 模板扩展【性格】段（新模板可选并入，存量不改） | 零 schema 改动、纯配置 | 是 |
| L2 自治边界 | 增员/改团队须用户/托管确认（question_confirm）；L3 完全自治 out | 治理 + 对齐 omo lead 专属纪律 | 是 |
| 模式切换时机 | 创建时定（DTO）；执行中 plan→direct 放宽、direct→plan 需补计划 | 防绕过计划 | 是 |

## Findings (cited - path:lines)
- tasks 表已有 managedMode（任务级模式开关先例）：schema.prisma:133；CreateTaskDto:102 可同构加 executionMode
- Agent 模型 prompt TEXT（提示词落点，persona 并入模板）：schema.prisma:379
- TaskAgent（角色多实例，同 agentId 多 seq，各独立会话）：schema.prisma:160；多实例并行开发底座已具备
- 平台 MCP 16 工具（含 notify_agent 互@、question_confirm 确认门、memory_save/search 记忆）：platform-mcp.tools.ts:224+
- question_confirm：仅主 Agent 可调用，kind=question/permission——L2 自治确认门复用点（platform-mcp.tools.ts questionConfirm）
- 任务状态机 transitionOpts.start.preflight 已有团队/主 Agent 校验（tasks.service.ts:645-658）——按模式加计划校验的同构位置
- GLOBAL_SYSTEM_INSTRUCTIONS 8 段静态注入（worker-dispatcher.ts:58-77）——【计划工作流】段按模式条件注入的落点
- omo 参照：Team Mode team_task_create 任务分配（lead→成员）+ 双时点评审（Metis 输入侧/Momus 输出侧）+ 模式关键词触发（keyword-detector）

## Decisions (with rationale)
1. 计划平台化为新数据域（plans/plan_tasks），非产出物（用户确认：计划是平台机制，非模型自维护）——可校验/追踪/联动/持久化/复用
2. 模式切换任务级 execution_mode（direct/plan 默认 direct），三处联动（状态机校验/系统提示注入/MCP 引导）——对齐 managedMode 先例 + omo 默认轻量
3. 评审不绑角色：评审位=用户默认/主 Agent 指派任意成员；双时点（计划前确认假设=Metis 对应、计划后可执行性评审=Momus 对应）
4. persona 为第五维（性格与四方向正交），预制性格库 + 安全阀（苛刻须附建议，对齐 Momus blocker-finder）
5. L1 感知 MCP（team_view/my_profile）只读放权；L2 自治走 question_confirm 确认门；L3 完全自治 scope out
6. 复用性：全部挂协议层（MCP/数据表/状态机/系统提示段），不绑 agent；主 Agent 位动态化、评审位可指派

## Scope IN
- server：plans/plan_tasks 表 + execution_mode 字段 + 迁移 + PlansModule；MCP plan_submit/plan_review/plan_task_transition/team_view/my_profile；状态机联动（start 前置 + 切换规则 + mark-pending-review 校验）；双时点评审流程 + 系统消息；【计划工作流】系统提示段；persona 性格库 + 提示词模板；L2 增员申请（question_confirm）
- 单测：plans/platform-mcp/tasks/worker-dispatcher 各 spec 扩展
- seed：persona 性格库常量（可选并入模板提示词）

## Scope OUT (Must NOT have)
- L3 完全自治（agent 无确认改团队/配置）；web 计划/性格管理界面（后续迭代）
- P3 远期：巡检调度器 todo 级强制、skills 携带权限语义、review-work 多视角评审
- 不新增依赖；不改任务状态机迁移逻辑本身（仅加条件校验分支）；存量 agent prompt 不强制改（persona 为新模板选项）
- 本计划不含 k8s 部署（部署沿用既有流程，另行执行）

## Open questions
无（范围已由用户确认；默认值可在审批时否决）

## Approval gate
status: approved
<!-- 用户 2026-08-16 批准范围（8 组件）→ git 收尾（d04c9b4 提交 + fetch，不 push）→ 计划编写 + Metis gap analysis 合并 -->
<!-- 高精度双评审 5 轮：Round1 Momus OKAY/Oracle CR → Round2 Momus OKAY/Oracle CR → Round3 Momus OKAY/Oracle CR → Round4 Momus OKAY/Oracle CR → Round5 Momus OKAY/Oracle APPROVE -->
<!-- 全部评审问题已合并：B1-B5/M1-M8/m1-m4/R1-R5/R3 4项/R4 MED-A/B/R5 MINOR-1/2 + 工具计数链 16→24 -->
<!-- 双 receipts：momus ses_ff7d2d38affeumj9ztXOWFHj9V [OKAY]；oracle ses_ff7d2c15bffe00BeuDmxPhDTS8 [APPROVE] -->
<!-- 交付：.omo/plans/vteam-team-collaboration.md（8 实现任务 + F1-F4）；执行经 $start-work vteam-team-collaboration -->
<!-- 用户选择不推送；远端注意：xishuhq/aiagents 404，实际 origin=xishuhq/xteam -->
