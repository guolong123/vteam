---
slug: vteam-web-collab
status: approved
intent: clear
review_required: false
pending-action: write .omo/plans/vteam-web-collab.md
approach: vteam 团队协作功能 Web 前端补充：Agent 性格配置 UI + 任务执行模式（创建/显示/切换）+ 任务详情执行计划区块（清单/评审）+ 看板徽章 + e2e + web 部署
---

# Draft: vteam-web-collab

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
| id | outcome (one line) | status | evidence path |
| --- | --- | --- | --- |
| wf-agents | agents 页 persona 配置 UI（ConfigPanel 性格区块 + 类型 + 保存） | active | web/app/(main)/agents/page.tsx:796,84-95 |
| wf-task-create | tasks/new 执行模式选择（direct/plan + payload） | active | web/app/(main)/tasks/new/page.tsx:531,1768-1791 |
| wf-task-detail | tasks/[id]：模式徽章/切换 + 执行计划区块（清单/状态/评审）+ SSE 刷新 | active | web/app/(main)/tasks/[id]/page.tsx:1740,96-118 |
| wf-board | 看板卡片 plan 模式徽章 | active | web/app/(main)/board/page.tsx:214 |
| wf-e2e | e2e 断言补充（persona/execution-mode/plan-review） | active | web/e2e/pages.spec.ts, reference/testids.ts |
| wf-deploy | web 镜像构建（根 context）+ helm upgrade（web tag）+ 浏览器实测 | active | docs/deployment.md, 部署先例 |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| 计划 UI 落点 | 内嵌任务详情页（TaskPanel 加「执行计划」区块），不新增独立导航页 | 探索建议最小化方案（nav 零改动） | 是 |
| 模式切换 UX | 任务详情页加切换入口；direct→plan 未批准 409 时显示引导文案 | 后端已实现 409 语义 | 是 |
| persona UI | ConfigPanel 性格 select（5 性格 + 文案预览）；创建弹窗可选加 | 后端 PATCH /agents 已支持 | 是 |
| board 徽章 | 小改动：卡片加 plan 模式徽章 | 可选增强 | 是 |
| web 部署 | 本计划重建 web 镜像（vteam-k8s-team-collab-web）+ helm upgrade web tag（REV 45） | 前端改动必须重新部署才可见 | 是 |
| seed persona | 不预置（用户配置）；存量 agent persona=null 正常显示「未配置」 | 避免默认行为变化 | 是 |

## Findings (cited - path:lines)
- agents 页：ConfigPanel 编辑面板（:796），区块序：提示词(:1093)→确认文案(:1134)→模型(:1177)→技能(:1428)→工具(:1537)→权限(:1575)；persona 全页零引用；UpdateAgentPayload(:84-95) 无 persona；后端 PATCH /agents/:id 支持 persona（agents.service.ts:247-248）、toAgentDto 返回 persona（:330）
- tasks/new：表单（:211）title/desc/背景文档/priority/托管模式开关(:531)/角色卡(:621)；payload(:1768-1791) 无 executionMode；后端 CreateTaskDto.executionMode 就绪（tasks.service.ts:229）
- tasks/[id]：三栏布局，TaskPanel 右侧面板（:1740），序：标题/状态徽章(:1783)/描述/主Agent团队/产出物/待办Issue/任务操作(:2105 含托管开关)；TaskDetail(:96-118) 无 executionMode；全 web 无 plans API 调用（GET /plans、PATCH /plans/:id/review、GET /plans/:id/tasks 均零引用）——**评审无 UI 入口（关键缺口）**
- board：TaskCard(:214) 状态徽章(:269)；数据源 GET /projects/:pid/tasks(:362)
- 群聊 SSE：MessageList 已渲染 system 消息（tasks/[id]/page.tsx:1160-1163）——计划系统消息自动显示，零改动
- 导航：NAV_ITEMS(:35-45) 无 plans 项；内嵌方案无需新增
- 后端 API 就绪（REV 44）：GET /plans?taskId=、PATCH /plans/:id/review（rejected 必填 reason，非 reviewing 400）、GET /plans/:id/tasks、PATCH /tasks/:id/execution-mode（@IsIn，direct→plan 未批准 409）、PATCH /agents persona
- web 测试基建：build/lint/test:e2e（playwright）；e2e 27 用例（pages.spec 16 个 testid 断言）；reference/testids.ts 全量 testid
- web 镜像构建需**根 context**（web/Dockerfile 引用 web/package.json+worker+scripts；learnings 记录过坑）

## Decisions (with rationale)
1. 用户评审计划 UI 是核心缺口（探索确认全 web 无 plans 引用）——必须补：任务详情页「执行计划」区块含评审按钮（approved/rejected+reason）
2. 计划 UI 内嵌任务详情页（最小化方案，nav 零改动）；计划状态经 SSE/refetch 刷新（群聊已有 SSE 基建）
3. persona/executionMode UI 均复用既有样式先例（select/switch/区块卡），不引入新依赖
4. 前端类型与后端 toTaskDto/API 对齐（TaskDetail.executionMode、UpdateAgentPayload.persona）
5. web 部署为本计划收尾（镜像重建 + helm upgrade web tag + 浏览器实测）——保证"看得见"

## Scope IN
- web 前端：agents 页 persona 配置、tasks/new 执行模式、tasks/[id] 模式徽章/切换 + 执行计划区块（清单/评审）、board plan 徽章、e2e 断言
- 部署：web 镜像构建（根 context）+ helm upgrade（web tag vteam-k8s-team-collab-web）+ 浏览器实测

## Scope OUT (Must NOT have)
- 独立计划管理导航页（内嵌方案）；seed persona 预置
- 服务端改动（后端已完备；仅发现 bug 才修，且需单独确认）
- MCP 工具 UI（Agent 侧能力，用户透明）；新增 npm 依赖
- 不改 nav-dock 导航结构（内嵌方案）

## Open questions
无（范围已确认；探索确认全部落点与后端契约）

## Approval gate
status: approved
<!-- 用户 2026-08-16 批准范围（6 组件：wf-agents/wf-task-create/wf-task-detail/wf-board/wf-e2e/wf-deploy） -->
<!-- 用户要求：保证功能完整性，检查类似问题缺口 -->
<!-- Metis gap analysis 完成（bg_7a11cd74）：无 blocker；3 major + 5 minor 已全部合并到计划（Major1 单次 GET /plans 含 tasks；Major2 404 空态分流；Major3 e2e 无计划空态+persona 不写污染；Minor4-9 就地处理）-->
<!-- 待办：用户选择「立即执行（$start-work vteam-web-collab）」或「先跑高精度评审」 -->
