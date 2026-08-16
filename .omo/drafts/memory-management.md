---
slug: memory-management
status: plan-written
intent: clear
review_required: false
pending-action: handoff — present plan summary and ask ONE question (start now vs high-accuracy review first)
approach: vteam 平台记忆管理：Prisma 记忆表（task/project/global 三级）+ 平台 MCP memory_save/memory_search（复用 assertWorkerTask 归属校验）+ 混合触发（accept 私信主 Agent 引导总结）+ GLOBAL_SYSTEM_INSTRUCTIONS 扩展 + REST 管理端点 + Web 记忆管理页面
---

# Draft: memory-management

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
| id | outcome (one line) | status | evidence path |
| --- | --- | --- | --- |
| mem-store | 记忆数据层：Prisma `memories` 表（level/taskId/projectId/content/tags/createdBy/deletedAt）+ 迁移 + resyncIdPrefix | active | server/prisma/schema.prisma, common/id-generator.ts:42 |
| mem-mcp | 平台 MCP 新增 memory_save / memory_search（zod schema + handler + assertWorkerTask 归属 + 级别校验） | active | server/src/platform-mcp/platform-mcp.tools.ts:224, platform-mcp.service.ts:808 |
| mem-trigger | 混合触发：accept 时 privateMessage 私信主 Agent 引导 memory_save；archive 群聊提示（会话冻结约束） | active | server/src/tasks/tasks.service.ts:635-753, 844-1010 |
| mem-inject | GLOBAL_SYSTEM_INSTRUCTIONS 扩展【记忆管理】段（工具用法 + 何时检索/总结） | active | server/src/chat/worker-dispatcher.ts:58-77 |
| mem-rest | REST 管理端点：GET /memories（level/projectId/taskId 筛选 + 关键词 + 分页）、DELETE /memories/:id（软删），AdminGuard | active | server/src/tools/tools.controller.ts:36, admin.guard.ts:25 |
| mem-web | Web 记忆管理页面（列表/级别筛选/搜索/删除）+ 导航入口 NAV_ITEMS | active | web/app/(main)/agents/page.tsx, nav-dock.tsx:35 |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| 记忆存取模式 | 对齐 21 篇「按需注入」：MCP 工具由模型自主调用，不自动注入记忆 | 21-平台MCP-Server设计方案.md:37-39 | 是 |
| 工具面 | 仅 memory_save + memory_search 两工具 | 最小工具面，检索覆盖 list 需求 | 是 |
| 级别写入权限 | MCP memory_save 支持 task/project/global 三级；global 级靠 GLOBAL_SYSTEM_INSTRUCTIONS 语义引导（仅写平台通用知识） | 用户需求「调用内置记忆 mcp 更新」；避免另设 admin 专用通道 | 是 |
| 检索实现 | content LIKE 模糊 + tags 精确匹配 + level 过滤；无全文索引 | 平台无搜索中间件，LIKE 满足内网规模 | 是 |
| 触发时点 | accept（completed）私信主 Agent 引导总结；archive 时会话冻结（sessions→archived），Agent 无法响应，仅群聊系统消息补充 | 13-任务状态机.md:107, tasks.service.ts:741-746 | 是 |
| REST 鉴权 | GET/DELETE /memories 挂 AdminGuard（admin 专用管理端点，不扩展权限矩阵 8 资源） | 对齐 tools/skills 管理端点模式；避免权限矩阵种子改动 | 是 |
| 管理操作面 | 页面支持查看/级别筛选/关键词搜索/删除（软删）；不做编辑（后续迭代） | 用户需求「页面配置管理」，最小闭环 | 是 |
| web 导航 | NAV_ITEMS 新增「记忆管理」入口（memories）+ PAGE_TITLE 映射 | nav-dock.tsx:35, app-shell.tsx:212 | 是 |

## Findings (cited - path:lines)
- vteam 三层实体：任务(task) → 项目(project) → 全局；无记忆功能/记忆表（README.md:5-33, 15-数据模型细化.md:87）
- 平台 MCP 现有 14 工具 + 手写 JSON-RPC 分发 + zod 校验（platform-mcp.tools.ts:224-332, platform-mcp.controller.ts:111-205）
- 归属校验模式 assertWorkerTask：workerId header + DB session 绑定权威 + 活跃集合快路径（platform-mcp.service.ts:808-861）
- 任务状态机：accept→completed（基线锁定）、archive→archived（会话冻结/回收）（13-任务状态机.md:105-107, tasks.service.ts:698-748）
- 系统消息机制：transitionOpts.sysMessage/privateMessage + transition() 事务内 tx.message.create + 广播；privateChannel 目前仅 start 分支解析（tasks.service.ts:877-959）
- GLOBAL_SYSTEM_INSTRUCTIONS：平台协议 system 通道注入，taskId 已注入（worker-dispatcher.ts:58-77, 21篇:103）
- ID 生成：IdGeneratorService.nextId(prefix) → `me_0000000001`（common/id-generator.ts:42）；onModuleInit resyncIdPrefix 续号（session-lifecycle.service.ts:47）
- REST 模式：@Controller + 全局 JwtAuthGuard + AdminGuard + QueryDto 分页 {items,total,page,pageSize}（tools.controller.ts:36-81, admin.guard.ts:25-67）
- web 模式：app/(main)/<module>/page.tsx + api.get/delete + TanStack Query；导航 NAV_ITEMS（nav-dock.tsx:35-45）+ PAGE_TITLE（app-shell.tsx:212-231）；api 封装 request<T>（web/lib/api.ts:51-133）
- opencode 内置 memory 仅 project/all-projects、存 worker 本地，无法覆盖任务级/全局级（memory help）

## Decisions (with rationale)
1. 落点 = vteam 平台功能（用户确认）；触发机制 = 混合（用户确认：平台 accept/archive 提示 + Agent 主动调 MCP 落库，平台不自动提取）
2. 页面配置管理 = 用户追加需求（确认）：Web 记忆管理页面 + REST 管理端点，mem-rest/mem-web 组件 active
3. 记忆表 `memories`：id(me_ 前缀) / level(task|project|global) / taskId? / projectId?（task 级冗余存，便于项目内检索）/ content TEXT / tags JSON / createdBy / deletedAt? / createdAt / updatedAt
4. 工具归属：memory_save 落库需 selfInstanceId（对齐落库类工具）；task 级校验任务归属；project 级经 taskId 反查项目校验成员；检索时 task 上下文聚合 task+project+global 三级可见记忆
5. 混合触发实现：transitionOpts.accept 增 privateMessage（私信主 Agent 引导 memory_save）；transition() privateChannel 解析扩展至有 privateMessage 的动作；archive 仅群聊系统消息文案补充
6. REST：GET /memories（QueryDto：level/projectId/taskId/keyword/page/pageSize）+ DELETE /memories/:id（软删 deletedAt），AdminGuard；服务端复用 MemoryService

## Scope IN
- server：memories 表（Prisma + 迁移）+ MemoryModule（MemoryService/Controller/DTO）+ 平台 MCP memory_save/memory_search + accept 私信触发 + GLOBAL_SYSTEM_INSTRUCTIONS 扩展
- web：app/(main)/memories/page.tsx 记忆管理页面 + NAV_ITEMS/PAGE_TITLE 导航注册
- 单测：platform-mcp.service.spec / tasks.service.spec / worker-dispatcher.spec / memories.controller.spec / memories.service.spec 扩展

## Scope OUT (Must NOT have)
- 记忆编辑（PATCH /memories/:id）、记忆详情页（后续迭代）
- 记忆自动提取（平台不做 LLM 摘要/提取——用户确认混合机制，Agent 主动总结）
- 权限矩阵扩展（不新增 memories 权限资源；管理端点 AdminGuard）
- opencode 内置 memory 工具改造；worker 侧代码改动（工具经既有 MCP 注入链下发）
- 全文检索/向量化检索

## Open questions
无（落点与触发机制已确认；页面配置管理为用户追加需求；其余为已宣布默认）

## Approval gate
status: approved
<!-- 用户已确认 v2 方案（含页面配置管理）。计划已写入 .omo/plans/memory-management.md -->
<!-- Metis gap analysis 完成（bg_f9e313f6）：M1 被动提示语义 / M2 project 级校验规则 / M3 global 仅主 Agent / m5 导航权限过滤 已合并 -->
<!-- 待办：用户选择「立即执行（$start-work）」或「先跑高精度评审（momus + oracle）」 -->
