# Agent 协作平台：PRD + 原型页面交付

## TL;DR

> **Quick Summary**: 为基于 opencode 的多 Agent 协作平台（任务群聊 + @触发 + 产出物归档 + Agent 配置）交付**产品型 PRD**（md-docs markdown 文档）与 **8 个静态原型页面**（md-docs React 组件），统一用 md-docs 渲染预览。本迭代**不做**可运行代码/后端/数据库/技术设计。
>
> **Deliverables**:
> - PRD 文档 6 篇（01 背景目标 / 02 用户场景 / 03 功能需求-任务群聊 / 04 功能需求-Agent产出物 / 05 非功能验收 / 06 交互页面设计）+ _meta.md
> - 原型页面 8 个（登录 / 项目列表 / 任务创建 / 任务看板 / 群聊 / 私聊 / 任务详情+文档库 / Agent 配置）
> - 原型共享 UI 组件库 + 设计规范
> - md-docs 可运行的文档站（dev + build 验证通过）
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: T1（脚手架）→ T2/T3（共享组件/PRD 总纲）→ T8-T11（原型）→ T13（构建验证）→ F1-F4（评审）

---

## Context

### Original Request
用户想构建一个基于 opencode 的 Agent 控制平台：提交任务时可选多个 agent（产品经理/架构师/开发者/测试等），平台创建群聊，可私聊或群聊 @ 触发；每个 agent 有输入/输出，产出物归档为任务全局文档（文本/文档/文件，版本历史）；每个 agent 可配置提示词/技能/工具/权限。

**本迭代范围（用户最终确认）**：只要 **① 产品型 PRD ② 8 个原型页面**，md-docs 统一交付。**不做可运行项目/后端/技术设计**——架构/数据模型/API 留待完整平台阶段。

### Interview Summary
**Key Discussions**:
- 部署形态（完整平台愿景）：团队 Web 服务、多用户、MySQL、Next.js 全栈 —— 写入 PRD 作为平台愿景
- 触发模型：群聊消息仅 @ 指定 agent 时其才收到；agent 可互相 @、支持 @all（显式寻址防失控）
- Session 模型：每 agent 每任务一个 opencode session；群聊@与私聊共用；@触发时注入群聊历史+任务文档
- 产出物协议：JSON Schema 结构化输出；文本直接归档、文档经 opencode API 拉取；任务全局文档带版本
- Agent 角色：预置模板 + 克隆修改 + 完全自定义
- 任务生命周期：轻量状态机（进行中/待验收/已完成/已归档）
- 认证：内置账号体系；组织模型：仅项目；文件产出：本地文件系统 + 元数据

**Research Findings**:
- opencode 1.18.14 支持 `opencode serve` + `@opencode-ai/sdk` 编程式驱动；每 agent = 一个 session；`json_schema` 结构化输出、`noReply` 上下文注入、SSE 事件流、权限请求端点 —— 这些是 PRD 技术愿景的支撑依据
- 平台模式参考：Coze 空间资源库（共享文档对所有 agent 可见）、AutoGen GroupChat（群聊仲裁）、LangGraph Store（状态持久化）
- md-docs 0.2.0 已安装：`docs/<project>/` 下 markdown 自动渲染、`prototypes/<name>/index.tsx` 自动注册；共享 UI 经 `@md-docs/prototypes/_shared/ui` 引入；参考 `/data/git-project/md-docs/docs/demo-app`

### Metis Review
**Identified Gaps** (addressed):
- 环境：aiagents 目录为空（greenfield）、非 git 仓库 → 脚手架任务（T1）
- 本机无 MySQL → 本迭代无数据库实现（PRD 中标注为平台愿景）
- TDD 策略与静态原型范围矛盾 → 测试策略改为 md-docs build + agent QA 走查
- 原型页面清单需锁定 → 8 个页面明确分组（T8-T11）
- 文档结构需锁定 → 6 篇 PRD 文档明确命名（T3-T7、T12）

---

## Work Objectives

### Core Objective
交付「基于 opencode 的多 Agent 协作平台」的产品型 PRD 与 8 个静态原型页面，用 md-docs 统一渲染，作为后续完整平台开发的蓝图。

### Concrete Deliverables
- `docs/agent-platform/` 项目目录（md-docs 约定）：`_meta.md` + 6 篇 PRD markdown（01~06）
- `docs/agent-platform/prototypes/` 下 8 个原型组件 + 共享 UI 组件库
- md-docs dev 服务可运行、build 构建通过

### Definition of Done
- [ ] `md-docs build --out-dir /tmp/site` 退出码 0
- [ ] curl `http://localhost:5177/` 返回 200；内容注入与原型注册均可见
- [ ] 8 个原型页面在浏览器无 console 错误，关键元素存在（playwright 验证）

### Must Have
- 6 篇 PRD 文档齐全（每篇含产品视角关键章节，技术仅作愿景概述）
- 8 个原型页面齐全，风格统一（共享 UI 组件），覆盖完整用户流程
- PRD 与原型页面内容一致（功能命名、流程对应）
- 全部使用 md-docs 约定（docs 目录结构、frontmatter、prototypes 注册）

### Must NOT Have (Guardrails)
- **不做任何可运行代码**：无后端、无 API、无数据库、无 Next.js 应用脚手架（原型的 React 组件仅作静态展示）
- **不做技术设计文档**：架构/ER 图/API 接口定义等留待完整平台阶段（PRD 中仅出现技术愿景性描述）
- **原型页面不接任何真实数据/逻辑**：纯静态渲染设计稿，mock 数据硬编码在组件内
- **不实现**：SSO、多租户、仓库操作/PR 合并、部署/CI、对象存储（PRD 边界章节标注为后续迭代）
- **不引入**：Vitest/Playwright 测试框架（无运行时代码可测；验证用 agent QA）
- **不写**：非 md-docs 交付物（如 Word/飞书 PRD）

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: NO（greenfield，无测试框架）
- **Automated tests**: None（本迭代无运行时代码）
- **Framework**: N/A
- **验证方式**：md-docs dev/build 命令 + curl 断言 + playwright 浏览器走查（agent QA）

### QA Policy
每个任务 MUST 包含 agent 执行验证（见 TODO 模板），证据存 `.omo/evidence/task-{N}-{slug}.{ext}`。

- **文档任务**：curl `http://localhost:5177/@id/__x00__virtual:md-docs-content` 检查文档注入 + grep 章节存在性
- **原型任务**：playwright 访问 `http://localhost:5177/#/p/agent-platform/protos/<id>`，断言关键元素 + 截图
- **构建验证**：`md-docs build --out-dir /tmp/site` + curl 静态产物

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately - 基础 + 规范，并行 4):
├── T1: 项目脚手架 + md-docs 验证 [quick]
├── T2: 原型设计规范 + 共享 UI 组件 [visual-engineering]
├── T3: PRD 总纲 + 背景目标 [writing]
└── T4: PRD 用户与场景 [writing]

Wave 2 (After Wave 1 - 内容主体，MAX PARALLEL 7):
├── T5: PRD 功能需求：任务与群聊协作 [writing]
├── T6: PRD 功能需求：Agent 管理与产出物 [writing]
├── T7: PRD 非功能需求 + 验收边界 [writing]
├── T8: 原型：登录 + 项目列表 [visual-engineering]
├── T9: 原型：任务创建 + 任务看板 [visual-engineering]
├── T10: 原型：群聊 + 私聊 [visual-engineering]
└── T11: 原型：任务详情+文档库 + Agent 配置 [visual-engineering]

Wave 3 (After Wave 2 - 收尾整合，2):
├── T12: PRD 交互与页面设计说明 [writing]
└── T13: md-docs 构建 + 全量验证 [visual-engineering]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code/content quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high + playwright)
└── F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T1 → T2/T3 → T10 → T13 → F1-F4 → user okay
Max Concurrent: 7 (Wave 2)
```

### Dependency Matrix
- **T1**: - 阻塞 T2-T13（脚手架前置）
- **T2**: T1 - 阻塞 T8-T11（共享组件前置）
- **T3**: T1 - 阻塞 T5-T7、T12（PRD 结构前置）
- **T4**: T1 - 无下游阻塞（独立章节）
- **T5/T6/T7**: T3 - T12
- **T8-T11**: T2 - T12、T13
- **T12**: T5/T6/T7/T8-T11 - T13
- **T13**: 全部 - F1-F4

### Agent Dispatch Summary
- **Wave 1**: T1 → `quick`; T2 → `visual-engineering`; T3/T4 → `writing`
- **Wave 2**: T5-T7 → `writing`; T8-T11 → `visual-engineering`
- **Wave 3**: T12 → `writing`; T13 → `visual-engineering`
- **FINAL**: F1 → `oracle`; F2 → `unspecified-high`; F3 → `unspecified-high`(+playwright); F4 → `deep`

---

## TODOs

- [x] 1. 项目脚手架与 md-docs 验证

  **What to do**:
  - 确认 `/data/git-project/aiagents` 现状（空目录）
  - 创建 `docs/agent-platform/` 目录结构与 `docs/README.md`（站点首页说明）
  - 创建 `docs/agent-platform/_meta.md`（项目元信息：name=Agent 协作平台 PRD，description=基于 opencode 的多 Agent 协作平台需求与原型，order=1）
  - 启动 `md-docs --port 5177 --no-open` 验证服务可运行；确认 `curl http://localhost:5177/` 返回 200
  - 参考 md-docs 技能规范 `/data/git-project/keta-skills/skills/md-docs/SKILL.md` 与示例项目 `/data/git-project/md-docs/docs/demo-app`

  **Must NOT do**:
  - 不要 `git init`（用户未要求版本管理，避免范围外动作）
  - 不要创建任何后端/前端应用脚手架
  - 不要安装任何 npm 包（md-docs 已全局可用）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 目录结构创建 + 命令验证，无复杂逻辑
  - **Skills**: [`md-docs`]
    - `md-docs`: 项目约定的核心工具，必须按其规范建目录与验证

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: Tasks 2-13
  - **Blocked By**: None (can start immediately)

  **References**:
  **Pattern References**:
  - `/data/git-project/md-docs/docs/demo-app/` - 示例项目目录结构（_meta.md、文档、prototypes 组织方式）
  - `/data/git-project/keta-skills/skills/md-docs/SKILL.md` - md-docs 完整规范（docs 目录约定、URL hash 路由、QA 验证步骤）
  **External References**:
  - md-docs 范式文档 `/data/git-project/md-docs/docs/guide/usage.md` - 完整约定（frontmatter、原型注册、共享 UI）

  **Acceptance Criteria**:
  - [ ] `docs/agent-platform/_meta.md` 存在且含 name/description/order 字段
  - [ ] `docs/README.md` 存在（站点首页说明）
  - [ ] `md-docs --port 5177 --no-open` 启动后 `curl http://localhost:5177/` 返回 200

  **QA Scenarios**:
  ```
  Scenario: md-docs 服务可启动且可访问
    Tool: Bash (curl)
    Preconditions: 已创建 docs/agent-platform/_meta.md 与 docs/README.md
    Steps:
      1. 后台启动 `md-docs --port 5177 --no-open`（nohup，记录 PID）
      2. `curl -s -o /dev/null -w "%{http_code}" http://localhost:5177/`
    Expected Result: 返回 200
    Failure Indicators: 非 200、进程立即退出（docs 目录缺失/端口占用）
    Evidence: .omo/evidence/task-1-md-docs-server.txt

  Scenario: 文档内容注入可见
    Tool: Bash (curl + grep)
    Preconditions: 服务运行中
    Steps:
      1. `curl -s http://localhost:5177/@id/__x00__virtual:md-docs-content | grep -o "docs/agent-platform" | head -1`
    Expected Result: 输出 `docs/agent-platform`（说明项目被识别）
    Failure Indicators: 无匹配（目录结构错误）
    Evidence: .omo/evidence/task-1-content-inject.txt
  ```

  **Commit**: NO（greenfield，用户未要求 git）

- [x] 2. 原型设计规范与共享 UI 组件库

  **What to do**:
  - 阅读 md-docs 共享 UI 模块（`@md-docs/prototypes/_shared/ui`，确认可用的 Button/StatusBadge 等）
  - 在 `docs/agent-platform/prototypes/_shared/` 下创建共享组件（注意：此目录不放 `index.tsx`，避免被注册为原型）：
    - `components.tsx` 或分文件：`AgentAvatar`（agent 头像+角色色块）、`AgentBadge`（角色标签：产品/架构/开发/测试）、`ChatBubble`（消息气泡，区分用户/agent/系统消息）、`MessageInput`（含 @ 提示的输入框样式）、`StatusBadge`（任务状态）、`EmptyState`、`Sidebar`（任务导航侧栏样式）、`TopBar`
  - 建立统一视觉规范：角色配色（产品=蓝、架构=紫、开发=绿、测试=橙）、状态配色（进行中/待验收/已完成/已归档）、圆角/间距/字体尺寸约定（可在 `_shared/styles.ts` 或 CSS 变量中定义）
  - 确保所有后续原型从 `_shared` 引入组件保持风格统一

  **Must NOT do**:
  - 不实现任何交互逻辑（点击跳转、状态变更）——纯展示组件
  - 不引入第三方 UI 库（antd/material），用纯 React + 内联样式/CSS
  - 不创建 `prototypes/_shared/index.tsx`（会被误注册为原型）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI 组件设计，需要视觉一致性与代码质量
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 设计系统/组件规范建立

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4)
  - **Blocks**: Tasks 8-11（原型页面依赖共享组件）
  - **Blocked By**: Task 1（需 docs 目录存在）

  **References**:
  **Pattern References**:
  - `/data/git-project/md-docs/docs/demo-app/prototypes/` - 示例原型写法（PrototypeDef 导出格式、PrototypeRenderProps 用法）
  - md-docs 技能规范 `@md-docs/prototypes/_shared/ui` 说明（共享模块用 `@md-docs/...` 别名）
  **External References**:
  - md-docs 技能 `SKILL.md` 原型约定章节：`meta.id` 唯一、`device` 字段、URL `#/p/<project>/protos/<id>`

  **Acceptance Criteria**:
  - [ ] `docs/agent-platform/prototypes/_shared/` 下存在共享组件文件（AgentAvatar/AgentBadge/ChatBubble/MessageInput/StatusBadge/Sidebar/TopBar 等，组件名可按需调整但功能覆盖上述清单）
  - [ ] 组件无 console 错误（在任意一个占位原型中引入后 playwright 验证）
  - [ ] 视觉规范文档或常量定义存在（角色配色/状态配色/间距字体）

  **QA Scenarios**:
  ```
  Scenario: 共享组件可被原型引用且渲染无错误
    Tool: Playwright
    Preconditions: md-docs 服务运行中；临时在 _shared 旁创建冒烟原型 smoke-test/index.tsx 引用各共享组件
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/smoke-test
      2. 检查页面 console 无 error（page.on('console') 捕获）
      3. 断言 AgentAvatar、ChatBubble、StatusBadge 等元素渲染（data-testid 或文本）
    Expected Result: 所有共享组件渲染成功，无 console error
    Failure Indicators: React 渲染错误、组件缺失导出
    Evidence: .omo/evidence/task-2-shared-components.png
  ```

  **Commit**: NO

- [x] 3. PRD 总纲与背景目标

  **What to do**:
  - 创建 `docs/agent-platform/01-背景与目标.md`，产品型 PRD 章节：
    - 产品背景：当前 AI 编码工具（opencode 等）是"单会话持续沟通"模式，多角色协作（需求/设计/开发/测试）难以在一个会话中结构化组织
    - 产品定位：基于 opencode 的多 Agent 协作控制平台（任务群聊 + 角色化 Agent + 产出物归档）
    - 产品目标：让用户像组织项目团队一样组织 AI Agent，覆盖需求分析/设计/测试/开发/部署各阶段
    - 非目标（明确不做）：不做模型训练/微调、不做通用聊天工具、不替代 opencode 本身
    - 目标用户：软件团队（产品经理/架构师/开发者/测试）、使用 opencode 的工程师
  - 确保文档使用 frontmatter（title/order/kind），`order: 1`
  - 保持产品视角，技术细节仅作愿景概述（可提及 opencode serve/SDK 作为技术底座，但不展开架构设计）

  **Must NOT do**:
  - 不写架构图/ER 图/API 接口（技术设计留待完整平台阶段）
  - 不写代码实现细节

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: 产品文档撰写，需要清晰表达
  - **Skills**: []（无特殊技能要求）

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4)
  - **Blocks**: Tasks 5, 6, 7（功能需求章节依赖总纲确立的结构）
  - **Blocked By**: Task 1

  **References**:
  **Pattern References**:
  - `.omo/drafts/agent-platform.md` - 全部需求确认记录（背景/目标/决策，唯一需求真相源）
  - `/data/git-project/md-docs/docs/demo-app/` 文档 frontmatter 写法（title/order/kind/parent）
  **External References**:
  - md-docs 技能规范 frontmatter 章节

  **Acceptance Criteria**:
  - [ ] `docs/agent-platform/01-背景与目标.md` 存在，含 frontmatter（title/order=1/kind）
  - [ ] 包含章节：产品背景、产品定位、产品目标、非目标、目标用户
  - [ ] curl 内容注入检查可见该文档 key

  **QA Scenarios**:
  ```
  Scenario: PRD 首篇文档渲染
    Tool: Bash (curl + grep)
    Preconditions: md-docs 服务运行中
    Steps:
      1. `curl -s http://localhost:5177/@id/__x00__virtual:md-docs-content | grep -c "01-背景与目标"`
      2. grep 断言文档包含 "产品背景" 与 "非目标" 标题
    Expected Result: 计数 ≥ 1；两个章节标题均存在
    Failure Indicators: key 缺失或章节缺失
    Evidence: .omo/evidence/task-3-prd-intro.txt
  ```

  **Commit**: NO

- [x] 4. PRD 用户与场景

  **What to do**:
  - 创建 `docs/agent-platform/02-用户与场景.md`（order: 2）：
    - 用户角色：平台管理员、项目成员（产品经理/架构师/开发者/测试）、AI Agent 角色列表
    - 核心用户故事（As a ... I want to ... So that ...）覆盖：
      - 提交任务并选择多个 agent 组成"虚拟团队"
      - 在群聊中 @ 指定 agent 获取响应
      - 私聊单个 agent 讨论细节
      - 查看 agent 的产出物（结论/文档/文件）
      - 配置 agent 的提示词/技能/工具/权限
      - 验收任务产出并归档
    - 典型使用场景（端到端叙述）：如"新功能开发"场景——产品经理出需求 → 架构师设计 → 开发者实现 → 测试验证，各环节通过群聊协作与产出物衔接

  **Must NOT do**:
  - 不定义数据库/API 细节
  - 用户故事不超出 draft 中确认的需求范围（@触发、同 session、产出物协议等）

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3)
  - **Blocks**: None（独立章节）
  - **Blocked By**: Task 1

  **References**:
  **Pattern References**:
  - `.omo/drafts/agent-platform.md` - 用户故事依据（需求 2/3/5、触发模式决策、角色体系决策）
  - `docs/agent-platform/01-背景与目标.md` - 目标用户章节（保持一致性，先等 T3 完成则读之；并行时可参考 draft）

  **Acceptance Criteria**:
  - [ ] `docs/agent-platform/02-用户与场景.md` 存在（frontmatter order: 2）
  - [ ] 包含：用户角色清单、≥6 条用户故事、≥1 个端到端场景叙述
  - [ ] 场景描述与 @触发模型/产出物协议一致

  **QA Scenarios**:
  ```
  Scenario: 用户场景文档渲染与完整性
    Tool: Bash (curl + grep)
    Preconditions: md-docs 服务运行中
    Steps:
      1. `curl -s http://localhost:5177/@id/__x00__virtual:md-docs-content | grep -c "02-用户与场景"`
      2. grep 断言文档含 "用户故事" 与 "典型使用场景"
    Expected Result: 计数 ≥ 1；两个标题存在
    Failure Indicators: 文档缺失或章节缺失
    Evidence: .omo/evidence/task-4-user-scenarios.txt
  ```

  **Commit**: NO

- [x] 5. PRD 功能需求：任务与群聊协作

  **What to do**:
  - 创建 `docs/agent-platform/03-功能需求-任务与群聊协作.md`（order: 3）：
    - 任务管理：创建任务（标题/描述/优先级）、选择 agent 组成虚拟团队、任务生命周期状态机（进行中/待验收/已完成/已归档）、任务验收流程（用户确认产出后标记完成）
    - 群聊协作：群聊消息模型（用户消息/agent 回复/系统消息）、@触发机制（仅 @ 的 agent 收到）、@all、agent 间互相 @、私聊与群聊关系（同一 session）
    - 消息上下文：@触发时注入群聊历史 + 任务文档库内容（可提及 token 分层管理为后续迭代）
    - 实时性：agent 会话过程可实时查看（点击 agent 查看其 opencode 会话流），agent 内部处理不广播到群聊
  - 使用功能点（FR-xx）+ 描述 + 优先级（P0/P1/P2）的形式，便于验收
  - 与 draft 的决策保持一致（@触发模型、轻量状态机、产出物不入对话）

  **Must NOT do**:
  - 不写架构/数据模型/API（技术设计留待完整平台阶段）
  - 不引入 draft 未确认的功能（如阶段门禁、审批流）

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8, 9, 10, 11)
  - **Blocks**: Task 12（交互设计文档依赖功能定义）
  - **Blocked By**: Task 3

  **References**:
  **Pattern References**:
  - `.omo/drafts/agent-platform.md` - 功能需求依据（需求 1/2/3、触发模式、状态机、群聊存储决策）
  - `docs/agent-platform/01-背景与目标.md` - 保持产品定位一致

  **Acceptance Criteria**:
  - [ ] 文档存在（frontmatter order: 3）
  - [ ] 包含：任务管理功能点、群聊协作功能点、@触发机制说明、状态机定义（4 状态）
  - [ ] 每个功能点含描述与优先级

  **QA Scenarios**:
  ```
  Scenario: 功能需求文档渲染与关键内容
    Tool: Bash (curl + grep)
    Preconditions: md-docs 服务运行中
    Steps:
      1. curl 内容注入检查包含 "03-功能需求-任务与群聊协作"
      2. grep 断言含 "@触发"、"状态机"、"待验收"
    Expected Result: 全部断言通过
    Evidence: .omo/evidence/task-5-prd-collab.txt
  ```

  **Commit**: NO

- [x] 6. PRD 功能需求：Agent 管理与产出物

  **What to do**:
  - 创建 `docs/agent-platform/04-功能需求-Agent与产出物.md`（order: 4）：
    - Agent 管理：预置角色模板（产品经理/架构师/开发者/测试）、模板克隆与自定义、Agent 配置项（提示词/技能/工具/权限范围）、每个 agent 一个独立会话（上下文管理）
    - 产出物协议：Agent 按规范返回结构化 JSON；产出物类型（结论文本/文档/文件）；文本直接归档、文档经平台拉取；产出物作为任务全局文档（所有 agent 可见）；版本历史（append 版本）
    - 任务文档库：文档列表/查看/版本；Agent 在 @触发时读取文档库内容作为上下文
    - 完整平台的技术底座愿景（概述级）：opencode serve + SDK 驱动、json_schema 结构化输出、权限请求人机协同——作为背景说明，不展开设计
  - 用功能点（FR-xx）+ 描述 + 优先级形式

  **Must NOT do**:
  - 不写具体的 JSON Schema 实现、API 契约（设计阶段产物，PRD 只描述规则）
  - 不写数据库表结构

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 7, 8, 9, 10, 11)
  - **Blocks**: Task 12
  - **Blocked By**: Task 3

  **References**:
  **Pattern References**:
  - `.omo/drafts/agent-platform.md` - 产出物协议决策、Agent 角色体系决策、权限配置需求（需求 6）、文档库需求（需求 5）
  - `docs/agent-platform/01-背景与目标.md` - 定位一致

  **Acceptance Criteria**:
  - [ ] 文档存在（frontmatter order: 4）
  - [ ] 包含：Agent 配置项清单（提示词/技能/工具/权限）、产出物协议规则、版本历史机制、文档库说明
  - [ ] 技术底座仅愿景级描述（不出现 API 端点/表结构/代码）

  **QA Scenarios**:
  ```
  Scenario: Agent 与产出物文档渲染与关键内容
    Tool: Bash (curl + grep)
    Preconditions: md-docs 服务运行中
    Steps:
      1. curl 内容注入检查包含 "04-功能需求-Agent与产出物"
      2. grep 断言含 "产出物"、"提示词"、"权限"、"版本"
    Expected Result: 全部断言通过；且确认文档内无 "CREATE TABLE" 或 "api/v1" 等技术设计内容
    Evidence: .omo/evidence/task-6-prd-agent.txt
  ```

  **Commit**: NO

- [x] 7. PRD 非功能需求与验收边界

  **What to do**:
  - 创建 `docs/agent-platform/05-非功能与验收边界.md`（order: 5）：
    - 非功能需求：性能（消息/响应延迟目标）、安全（认证/权限/产出物访问控制）、可用性、可扩展性（多任务并发、水平扩展预留）、可维护性
    - 技术约束：基于 opencode（版本、serve 地址可配置）、Node/TS 技术栈、MySQL 存储（本机验证环境可先用 SQLite）、Next.js 前端——作为平台愿景约束
    - 验收边界（本迭代 vs 完整平台）：本迭代交付 PRD+原型；完整平台功能清单（任务/群聊/产出物/Agent 配置等）与后续迭代项（仓库操作/PR 合并、部署 CI、SSO、多租户、对象存储、SSE 实时推送、token 压缩）
    - 风险与开放问题：opencode serve 并发稳定性、token 成本、agent 死循环、结构化输出失败率

  **Must NOT do**:
  - 不写技术实现方案（性能指标只给目标值）

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 8, 9, 10, 11)
  - **Blocks**: Task 12
  - **Blocked By**: Task 3

  **References**:
  **Pattern References**:
  - `.omo/drafts/agent-platform.md` - Scope Boundaries（MVP 功能 vs 后续迭代）、研究中的平台模式教训（token 爆炸、状态持久化、错误边界）

  **Acceptance Criteria**:
  - [ ] 文档存在（frontmatter order: 5）
  - [ ] 包含：非功能需求清单、技术约束、本迭代 vs 完整平台边界表、风险清单
  - [ ] 后续迭代项与 draft EXCLUDE 一致

  **QA Scenarios**:
  ```
  Scenario: 非功能与边界文档渲染与关键内容
    Tool: Bash (curl + grep)
    Preconditions: md-docs 服务运行中
    Steps:
      1. curl 内容注入检查包含 "05-非功能与验收边界"
      2. grep 断言含 "非功能需求"、"后续迭代"、"SSO"（或等价后续迭代项）
    Expected Result: 全部断言通过
    Evidence: .omo/evidence/task-7-prd-nfr.txt
  ```

  **Commit**: NO

- [x] 8. 原型：登录 + 项目列表

  **What to do**:
  - 创建 `docs/agent-platform/prototypes/login/index.tsx`：
    - 登录页：品牌区（产品名/Logo 占位）+ 登录表单（账号/密码 + 登录按钮）+ 注册入口；移动/桌面适配（device: both）
  - 创建 `docs/agent-platform/prototypes/project-list/index.tsx`：
    - 项目列表页：侧边栏（导航：项目/任务/Agent 管理）+ 项目卡片列表（项目名/描述/任务数/成员）+ 新建项目按钮
  - 复用 `_shared` 组件（Sidebar/TopBar/StatusBadge 等）；mock 数据硬编码（2-3 个示例项目）
  - 每个原型导出默认 PrototypeDef（meta.id 唯一、name、device）

  **Must NOT do**:
  - 不实现登录逻辑/路由跳转（静态展示）
  - 不接后端数据

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 页面视觉设计 + React 组件实现
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: 页面布局与视觉规范

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 7, 9, 10, 11)
  - **Blocks**: Task 12、13
  - **Blocked By**: Task 2（共享组件）

  **References**:
  **Pattern References**:
  - `docs/agent-platform/prototypes/_shared/` - 共享组件（Task 2 产出）
  - `/data/git-project/md-docs/docs/demo-app/prototypes/` - 原型写法示例（PrototypeDef/PrototypeRenderProps）
  - `docs/agent-platform/03-功能需求-任务与群聊协作.md` 与 `04-功能需求-Agent与产出物.md` - 功能定义对齐（任务/项目概念）
  **External References**:
  - md-docs 技能规范：原型注册约定（meta.id、device）、URL `#/p/agent-platform/protos/<id>`

  **Acceptance Criteria**:
  - [ ] `prototypes/login/index.tsx` 与 `prototypes/project-list/index.tsx` 存在且导出 PrototypeDef
  - [ ] playwright 访问两个原型 URL 无 console error，关键元素存在（登录表单按钮、项目卡片）

  **QA Scenarios**:
  ```
  Scenario: 登录页渲染
    Tool: Playwright
    Preconditions: md-docs 服务运行中
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/login
      2. page.on('console') 捕获 error，断言 0 个
      3. 断言存在账号输入框（selector: input[placeholder*="账号"] 或 data-testid="username"）、登录按钮（text=登录）
    Expected Result: 无 console error；登录表单元素存在
    Failure Indicators: React 渲染错误、元素缺失
    Evidence: .omo/evidence/task-8-login.png

  Scenario: 项目列表页渲染
    Tool: Playwright
    Preconditions: md-docs 服务运行中
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/project-list
      2. 断言存在 ≥2 个项目卡片（data-testid="project-card" 或类名 .project-card 计数）
      3. 断言存在 "新建项目" 按钮
    Expected Result: 项目卡片 ≥2、新建按钮存在、无 console error
    Evidence: .omo/evidence/task-8-project-list.png
  ```

  **Commit**: NO

- [x] 9. 原型：任务创建 + 任务看板

  **What to do**:
  - 创建 `docs/agent-platform/prototypes/task-create/index.tsx`：
    - 任务创建页：任务表单（标题/描述/优先级）+ Agent 选择区（可勾选多个 agent 角色：产品经理/架构师/开发者/测试，带角色色块头像）+ 创建按钮；展示已选 agent 列表
  - 创建 `docs/agent-platform/prototypes/task-board/index.tsx`：
    - 任务看板页：任务列表/卡片（任务标题、状态徽章、参与 agent 头像、产出物数量）+ 状态筛选（全部/进行中/待验收/已完成/已归档）+ 新建任务入口
  - 复用 `_shared` 组件；mock 数据硬编码（3-4 个任务示例，覆盖各状态）
  - 与 PRD 功能定义对齐（任务状态机 4 状态、agent 角色清单）

  **Must NOT do**:
  - 不实现勾选联动逻辑（静态展示已选状态即可）
  - 不实现看板拖拽/筛选逻辑

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 7, 8, 10, 11)
  - **Blocks**: Task 12、13
  - **Blocked By**: Task 2

  **References**:
  **Pattern References**:
  - `docs/agent-platform/prototypes/_shared/` - 共享组件
  - `docs/agent-platform/03-功能需求-任务与群聊协作.md` - 任务状态机、agent 选择需求
  - `/data/git-project/md-docs/docs/demo-app/prototypes/` - 原型写法示例

  **Acceptance Criteria**:
  - [ ] 两个原型文件存在且导出 PrototypeDef
  - [ ] playwright 验证无 console 错误；任务创建页含 agent 选择区；看板含 4 状态筛选与任务卡片

  **QA Scenarios**:
  ```
  Scenario: 任务创建页渲染
    Tool: Playwright
    Preconditions: md-docs 服务运行中
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/task-create
      2. 断言存在任务标题输入框（data-testid="task-title"）、≥4 个 agent 选项（data-testid="agent-option" 计数 ≥4）
      3. 断言存在创建按钮（text=创建任务）
    Expected Result: 输入框/agent 选项/创建按钮均存在，无 console error
    Evidence: .omo/evidence/task-9-task-create.png

  Scenario: 任务看板渲染
    Tool: Playwright
    Preconditions: md-docs 服务运行中
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/task-board
      2. 断言状态筛选含 4 种状态文本（进行中/待验收/已完成/已归档）
      3. 断言任务卡片 ≥3（data-testid="task-card"）
    Expected Result: 状态筛选 4 项、卡片 ≥3、无 console error
    Evidence: .omo/evidence/task-9-task-board.png
  ```

  **Commit**: NO

- [x] 10. 原型：群聊 + 私聊

  **What to do**:
  - 创建 `docs/agent-platform/prototypes/group-chat/index.tsx`（本迭代最核心页面）：
    - 群聊视图：左侧任务导航/成员列表（agent 头像+角色，可点击进入私聊）+ 中间消息区（用户消息/agent 回复/系统消息气泡，区分样式；agent 消息带角色色块头像；系统消息显示"xx 加入了任务"等）+ 底部输入区（含 @ 提示：输入 @ 弹出 agent 选择、@all 选项）+ 右侧或顶部任务信息面板（任务状态、产出物入口、查看 agent 会话入口）
    - 消息流 mock：展示用户 @产品经理 → 产品经理回复 → 开发者 @架构师 的连贯示例
  - 创建 `docs/agent-platform/prototypes/dm-chat/index.tsx`：
    - 私聊视图：与单个 agent 的对话（同一 agent 色块头像、消息气泡）+ 顶部 agent 信息（角色/状态）+ 查看该 agent 历史会话入口（点击可"实时查看"的示意入口）+ 输入区（无需 @）
  - 复用 `_shared` 的 ChatBubble/AgentAvatar/MessageInput 等；device: both（移动端紧凑布局）
  - 与 PRD @触发模型一致（群聊仅 @ 才触发；私聊直连 agent）

  **Must NOT do**:
  - 不实现 @ 弹出层交互逻辑（展示 @ 提示 UI 样式即可）
  - 不接真实消息数据

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 7, 8, 9, 11)
  - **Blocks**: Task 12、13
  - **Blocked By**: Task 2

  **References**:
  **Pattern References**:
  - `docs/agent-platform/prototypes/_shared/` - ChatBubble/AgentAvatar/MessageInput 共享组件
  - `docs/agent-platform/03-功能需求-任务与群聊协作.md` - @触发机制、消息模型、实时查看会话需求
  - `docs/agent-platform/02-用户与场景.md` - 群聊/私聊用户故事

  **Acceptance Criteria**:
  - [ ] 两个原型文件存在且导出 PrototypeDef
  - [ ] playwright 验证：群聊页含消息区/输入区/@ 提示元素/成员列表；私聊页含对话区与 agent 信息
  - [ ] mock 消息体现 @触发流程（用户@agent → agent 回复）

  **QA Scenarios**:
  ```
  Scenario: 群聊视图渲染（核心）
    Tool: Playwright
    Preconditions: md-docs 服务运行中
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/group-chat
      2. 断言消息区存在 ≥3 条消息气泡（data-testid="chat-bubble" 计数）
      3. 断言输入区存在（data-testid="message-input"）且含 @ 提示（text 含 "@"）
      4. 断言成员列表含 ≥4 个 agent（data-testid="member-item"）
      5. 断言 mock 消息中至少一条用户消息含 @某agent（grep data-testid="chat-bubble" 文本含 "@产品经理"）
    Expected Result: 全部断言通过，无 console error
    Failure Indicators: 消息区/输入区/成员缺失、@提示缺失
    Evidence: .omo/evidence/task-10-group-chat.png

  Scenario: 私聊视图渲染
    Tool: Playwright
    Preconditions: md-docs 服务运行中
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/dm-chat
      2. 断言对话区存在消息气泡（data-testid="chat-bubble" ≥2）
      3. 断言顶部 agent 信息存在（data-testid="dm-agent-info" 或角色文本）
      4. 断言"查看历史会话"入口存在（text 含 "会话"）
    Expected Result: 全部断言通过，无 console error
    Evidence: .omo/evidence/task-10-dm-chat.png
  ```

  **Commit**: NO

- [x] 11. 原型：任务详情+文档库 + Agent 配置

  **What to do**:
  - 创建 `docs/agent-platform/prototypes/task-detail/index.tsx`：
    - 任务详情页：任务信息头部（标题/状态徽章/优先级/参与 agent 头像）+ Tab 区（群聊/产出物/文档库）+ 文档库视图：产出物列表（类型标签：结论文本/文档/文件、版本号 v1/v2、作者 agent、时间）+ 文档查看面板（内容预览 + 版本切换示意）
    - mock：2-3 个产出物（含一个多版本示例）
  - 创建 `docs/agent-platform/prototypes/agent-config/index.tsx`：
    - Agent 配置页：Agent 列表（角色模板：产品经理/架构师/开发者/测试 + 自定义）+ 配置面板（提示词编辑器 textarea、技能列表勾选、工具权限开关或权限矩阵、权限范围配置）+ 模板克隆入口
  - 复用 `_shared` 组件；与 PRD 产出物协议/Agent 配置需求对齐

  **Must NOT do**:
  - 不实现 Tab 切换/版本切换交互逻辑（静态展示所有 tab 内容或默认 tab）
  - 不实现配置保存逻辑

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 7, 8, 9, 10)
  - **Blocks**: Task 12、13
  - **Blocked By**: Task 2

  **References**:
  **Pattern References**:
  - `docs/agent-platform/prototypes/_shared/` - 共享组件
  - `docs/agent-platform/04-功能需求-Agent与产出物.md` - 产出物类型/版本、Agent 配置项
  - `docs/agent-platform/03-功能需求-任务与群聊协作.md` - 任务状态、文档库

  **Acceptance Criteria**:
  - [ ] 两个原型文件存在且导出 PrototypeDef
  - [ ] playwright 验证：任务详情页含产出物列表（含版本标记）；Agent 配置页含提示词编辑区与权限配置区

  **QA Scenarios**:
  ```
  Scenario: 任务详情+文档库渲染
    Tool: Playwright
    Preconditions: md-docs 服务运行中
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/task-detail
      2. 断言产出物列表 ≥2（data-testid="artifact-item"）
      3. 断言至少一个产出物含版本号 v1/v2（grep artifact-item 文本）
      4. 断言文档查看面板存在（data-testid="artifact-viewer"）
    Expected Result: 全部断言通过，无 console error
    Evidence: .omo/evidence/task-11-task-detail.png

  Scenario: Agent 配置页渲染
    Tool: Playwright
    Preconditions: md-docs 服务运行中
    Steps:
      1. 访问 http://localhost:5177/#/p/agent-platform/protos/agent-config
      2. 断言 Agent 列表 ≥4 个角色（data-testid="agent-list-item"）
      3. 断言提示词编辑区存在（textarea 或 data-testid="prompt-editor"）
      4. 断言权限配置区存在（data-testid="permission-config" 或含"权限"文本）
    Expected Result: 全部断言通过，无 console error
    Evidence: .omo/evidence/task-11-agent-config.png
  ```

  **Commit**: NO

- [x] 12. PRD 交互与页面设计说明

  **What to do**:
  - 创建 `docs/agent-platform/06-交互与页面设计.md`（order: 6）：
    - 页面清单与流程：8 个页面（登录/项目列表/任务创建/任务看板/群聊/私聊/任务详情+文档库/Agent 配置）逐一说明用途、入口、关键交互、对应原型链接（`@prototype[id]` 内联或 `prototype` 代码块嵌入原型预览）
    - 核心交互说明：@触发流程（输入 @ → 选 agent → 发送 → 仅该 agent 收到）、agent 会话实时查看、产出物提交与归档、任务验收流程
    - 页面流转关系（可用 mermaid 流程图：登录 → 项目列表 → 任务创建 → 群聊/看板 → 任务详情 → 验收）
  - 复用 PRD 前序章节与原型命名，保证一致性

  **Must NOT do**:
  - 不写实现代码

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (with Task 13)
  - **Blocks**: Task 13
  - **Blocked By**: Tasks 5, 6, 7, 8, 9, 10, 11（需功能定义与原型完成）

  **References**:
  **Pattern References**:
  - `docs/agent-platform/01~05 各章节` - 功能/场景定义
  - `docs/agent-platform/prototypes/` 8 个原型 - 页面实际形态
  - md-docs 技能规范 `@prototype[id]` / `prototype` 代码块内嵌用法

  **Acceptance Criteria**:
  - [ ] 文档存在（frontmatter order: 6）
  - [ ] 覆盖 8 个页面说明 + 核心交互（@触发/会话查看/产出物/验收）+ 页面流转图
  - [ ] 至少 1 处内嵌原型预览（@prototype 或 prototype 块），URL 有效

  **QA Scenarios**:
  ```
  Scenario: 交互文档渲染与原型内嵌
    Tool: Bash (curl + grep) + Playwright
    Preconditions: md-docs 服务运行中；8 个原型已完成
    Steps:
      1. curl 内容注入检查包含 "06-交互与页面设计"
      2. grep 断言文档含 "@触发" 与 "任务验收"
      3. 浏览器访问文档 URL，断言原型预览区渲染（若用 @prototype 内嵌则出现原型 UI 元素）
    Expected Result: 断言通过，内嵌原型正常渲染
    Failure Indicators: 文档缺失、内嵌原型引用错误（404）
    Evidence: .omo/evidence/task-12-interaction.txt + .png
  ```

  **Commit**: NO

- [x] 13. md-docs 构建与全量验证

  **What to do**:
  - 运行 `md-docs build --out-dir /tmp/site`，确认退出码 0、产物存在（index.html + assets/）
  - 全量检查：
    - curl 内容注入包含 6 篇 PRD 文档 key（01~06）+ _meta 生效
    - curl 原型注册包含 8 个原型 import 映射
    - playwright 走查 8 个原型 URL 无 console error
    - 检查 _shared 未被注册为原型（不应出现在 protos 列表）
    - 检查文档与原型命名一致性（页面名 ↔ 文档"页面清单"）
  - 修复发现的问题（如 frontmatter 缺失、原型注册失败、命名不一致），复验直到全部通过

  **Must NOT do**:
  - 不新增任何功能内容（只做验证与修复）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 涉及原型渲染验证与修复
  - **Skills**: [`md-docs`]
    - `md-docs`: 构建与验证规范

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (with Task 12)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 1-12

  **References**:
  **Pattern References**:
  - md-docs 技能 `SKILL.md` QA 验证章节（服务启动/内容注入/原型编译/构建产物检查）

  **Acceptance Criteria**:
  - [ ] `md-docs build --out-dir /tmp/site` 退出码 0
  - [ ] 内容注入包含全部 6 篇文档 key；原型注册包含 8 个原型且不含 _shared
  - [ ] 8 个原型 playwright 走查无 console error
  - [ ] 修复的问题全部闭环（若发现）

  **QA Scenarios**:
  ```
  Scenario: 构建通过
    Tool: Bash
    Preconditions: 全部文档与原型已完成
    Steps:
      1. `md-docs build --out-dir /tmp/site 2>&1; echo "EXIT:$?"`
      2. `ls /tmp/site/index.html`
    Expected Result: EXIT:0；index.html 存在
    Failure Indicators: 非 0 退出码、产物缺失
    Evidence: .omo/evidence/task-13-build.txt

  Scenario: 全量原型走查
    Tool: Playwright
    Preconditions: md-docs dev 服务运行中
    Steps:
      1. 依次访问 8 个原型 URL（login/project-list/task-create/task-board/group-chat/dm-chat/task-detail/agent-config）
      2. 每个页面捕获 console error，断言 0 个
      3. 断言每个页面关键元素存在（各页 data-testid）
    Expected Result: 8/8 页面无 console error 且关键元素齐全
    Failure Indicators: 任一页面 console error 或元素缺失
    Evidence: .omo/evidence/task-13-walkthrough.txt（记录每页结果）
  ```

  **Commit**: NO

---

## Final Verification Wave

^- [x] F1. **Plan Compliance Audit** — `oracle`
  逐项核对：6 篇 PRD 文档存在且含关键章节；8 个原型注册并可渲染；Must NOT Have 无一出现（无后端代码/无技术设计/原型无真实逻辑）。`md-docs build` 复验。证据文件存在。
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

^- [x] F2. **Content Quality Review** — `unspecified-high`
  检查 PRD 文档：结构完整、术语一致（任务/群聊/@触发/产出物/Agent 配置）、与原型命名一致、无 AI 套话空话。检查原型：风格统一、无死链引用、无 console 错误、className 合理。检查共享组件复用充分（无重复样式代码）。
  Output: `Docs [N clean/N issues] | Prototypes [N clean/N issues] | VERDICT`

^- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright`)
  从零启动 `md-docs`，逐一访问 8 个原型 URL，验证关键元素与交互反馈（点击/输入响应），检查 6 篇文档渲染（标题/表格/流程图正常）。验证原型间导航一致性。截图存档 `.omo/evidence/final-qa/`。
  Output: `Prototypes [8/8 pass] | Docs [8/8 pass] | VERDICT`

^- [x] F4. **Scope Fidelity Check** — `deep`
  对照计划逐任务检查实际产物：每篇 PRD 与原型是否按计划交付、内容是否与 interview 记录一致（@触发模型、session 模型、产出物协议、Agent 配置、状态机）；有无超出范围的产物（后端代码、技术设计、测试框架）；PRD 与原型是否互相呼应。
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

> 本迭代为纯文档/原型交付，目录非 git 仓库（greenfield）。如用户后续要求版本管理再行 init/commit。当前阶段不创建 git commit。

---

## Success Criteria

### Verification Commands
```bash
# 1. md-docs dev 服务启动（在 /data/git-project/aiagents）
md-docs --port 5177 --no-open
# Expected: "文档源: /data/git-project/aiagents/docs" + Local 地址

# 2. 内容注入检查
curl http://localhost:5177/@id/__x00__virtual:md-docs-content
# Expected: 包含 docs/agent-platform/ 下所有 markdown key

# 3. 原型注册检查
curl http://localhost:5177/@id/__x00__virtual:md-docs-protos
# Expected: 包含 8 个原型 import 映射（login/project-list/task-create/task-board/group-chat/dm-chat/task-detail/agent-config）

# 4. 构建验证
md-docs build --out-dir /tmp/site
# Expected: 退出码 0，输出 /tmp/site/index.html + assets/

# 5. 浏览器验证（playwright）
# 访问 http://localhost:5177/#/p/agent-platform/protos/<id> 逐个验证
```

### Final Checklist
- [ ] 6 篇 PRD 文档 + _meta.md 齐全
- [ ] 8 个原型页面 + 共享 UI 组件齐全
- [ ] md-docs dev 启动、内容注入、原型注册、build 全通过
- [ ] 原型浏览器走查 8/8 无 console 错误
- [ ] 所有 Must NOT Have 均未出现
