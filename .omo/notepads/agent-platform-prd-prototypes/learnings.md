## Task 1: 项目脚手架与 md-docs 验证（2026-08-06）
- _meta.md 格式（参照 demo-app）：
  ```
  ---
  name: Agent 协作平台 PRD
  description: 基于 opencode 的多 Agent 协作平台需求与原型
  order: 1
  ---
  ```
- md-docs content 验证端点返回 JS module，key 形如 `"/docs/agent-platform/_meta.md"`（带前导 `/`）；grep 模式应为 `'"/docs/agent-platform/'`
- 项目识别判定：content 端点出现 `docs/agent-platform` 下的 key 即被识别；首页 / 返回 200 不代表项目列表渲染成功，需核对 content 端点
- 原型验证端点（后续任务参考）：`/@id/__x00__virtual:md-docs-protos`
# Agent 协作平台 PRD 迭代学习记录

## T3 PRD 总纲与背景目标（2026-08-06）

- **交付**：`docs/agent-platform/01-背景与目标.md`，frontmatter 格式 `title/order/kind/description`（参照 demo-app），order=1、kind=PRD。
- **内容结构**：产品背景 / 产品定位 / 产品目标 / 非目标 / 目标用户 五个章节，全产品视角，无架构/API/代码。
- **技术底座表述**：仅愿景级一句带过（"opencode 编程式驱动能力（opencode serve 与 SDK）"），不展开设计，符合 T3 约束。
- **需求真相源**：全部内容来自计划文件 Context 章节（Interview Summary），未引入未确认需求（阶段门禁/审批流等明确排除）。
- **验证方式**：`curl http://localhost:5177/@id/__x00__virtual:md-docs-content | grep "01-背景与目标"` + 本地 grep 章节存在性，5/5 PASS。证据存 `.omo/evidence/task-3-prd-intro.txt`。
- **注意**：md-docs 服务对新增 markdown 热加载即时生效，无需重启即可在内容注入端点看到新 key。

## T4 PRD 用户与场景（2026-08-06）

- **交付**：`docs/agent-platform/02-用户与场景.md`，frontmatter `title/order/kind/description`，order=2、kind=需求。
- **结构**：① 用户角色（平台管理员 / 项目成员四分工 / AI Agent 角色表）→ ② 核心用户故事（US-01~08，标准 As a/I want to/So that 格式）→ ③ 端到端场景「新功能开发」（6 步骤小标题：建队→需求→设计→实现→测试→验收归档）。
- **需求边界**：8 条用户故事对应已确认需求六方面 + 2 条衍生（实时查看会话 US-07、上下文注入 US-08），均不超出 Interview Summary；无数据库/API/JSON Schema 实现细节。
- **一致性锚点**：文档内显式写入「仅被 @ 的 Agent 收到」「私聊与群聊共用同一 session」「产出物带版本、任务全局文档」「内部过程不广播，群聊只显示最终回复，点击 Agent 实时查看会话」四句关键约束，供后续 T5/T6/T10 复用对齐。
- **验证方式**：内容注入端点 grep `"/docs/agent-platform/02-用户与场景.md"` 命中；本地 grep 断言用户故事数与章节存在。证据存 `.omo/evidence/task-4-user-scenarios.txt`。
- **复用点**：US 编号（US-01~08）与场景步骤可作为 T5 功能点（FR-xx）与 T10 原型 mock 消息流（用户@产品经理→产品经理回复→开发者@架构师）的直接依据。

## T2 原型设计规范与共享 UI 组件库（2026-08-06）

- **交付**：`docs/agent-platform/prototypes/_shared/styles.ts`（设计 token：roles 四角色色/statusColors 四状态色/space/radius/fontSize/neutral/fontFamily/shadow/sidebarTheme）+ `components.tsx`（8 个纯展示组件：AgentAvatar/AgentBadge/ChatBubble/MessageInput/StatusBadge/Sidebar/TopBar/EmptyState，全 TS 类型、关键元素带 data-testid）。
- **角色配色**：产品=蓝 #3B82F6 / 架构=紫 #8B5CF6 / 开发=绿 #10B981 / 测试=橙 #F59E0B；状态配色：进行中=蓝 / 待验收=琥珀 / 已完成=绿 / 已归档=灰（均收敛 styles.ts）。
- **⚠️ 共享组件相对导入层级（易错点）**：原型在 `prototypes/<name>/index.tsx`，_shared 是同级兄弟目录，**引用只需一级 `../_shared/components`**。任务描述示例 `../../_shared/components` 实际多了一层，直接照抄会报 `Failed to resolve import`（vite 会解析到 agent-platform/_shared，不存在）。只有原型放 `prototypes/<name>/sub/index.tsx` 才需两级。
- **验证方式**：`curl http://localhost:5177/@id/__x00__virtual:md-docs-protos` 确认 smoke-test 注册 → `curl /@fs/<abs>/smoke-test/index.tsx` 返回 200 即编译通过（500 则 vite 报错，错误 HTML 内含 `const error={message...}` 可解析）。证据存 `.omo/evidence/task-2-shared-components.txt`。
- **其他关键结论**：① `_shared/` 内不要建 index.tsx，否则被 collectProtos 误注册为原型；components.tsx/styles.ts 命名安全。② 冒烟 smoke-test 原型验证后已删除，md-docs watcher 自动从 `md-docs-protos` 移除注册（`export default {}`）。③ `@md-docs/...` 别名只指向 md-docs 包内自带共享 UI（src/prototypes/_shared/ui），不是本项目 _shared，项目组件必须用相对导入。④ dev 服务 fs.allow 含 docsRoot 与 cwd，`/@fs/绝对路径` 可访问；/tmp 下文件 403。
- **T8~T11 复用**：原型文件统一 `import { ... } from "../_shared/components"`；ChatBubble props 为 `{ text, type?: 'user'|'agent'|'system', author?, role?, time? }`，Sidebar props 为 `{ projectName?, active?: 'tasks'|'agents', onNavClick? }`，MessageInput 接受 `mentionable?: RoleKey[]`。

## T8 登录 + 项目列表原型（2026-08-06）

- **交付**：`prototypes/login/index.tsx`（device: both，品牌区+账号/密码+登录按钮+注册入口，testid: username/password/login-button/register-link）+ `prototypes/project-list/index.tsx`（device: both，Sidebar+TopBar+3 张项目卡片+新建按钮，testid: project-card/create-project-button）。均复用 `../_shared/components` 与 `../_shared/styles`。
- **PrototypeDef 格式**（参照 demo-app）：`import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types"`，组件函数收 `{ device, deviceWidth }`，`deviceWidth` 直接作外层 `width`（both 模式才有值）；默认导出 `{ meta: { id, name, group, description, device }, Component }`。
- **device: "both" 适配**：`isMobile = device === "mobile"`，登录页移动端把品牌区折叠为顶部横条（左右分栏→上下堆叠）；项目列表移动端把 Sidebar 换为 64px 窄图标栏（纯 inline 样式，未改 _shared 组件）。
- **响应式布局要点**：外层容器 `minHeight:"100%"` + `width: deviceWidth`；网格用 `repeat(auto-fill,minmax(300px,1fr))` 桌面 / `1fr` 移动；头像堆叠用 `marginLeft: idx===0 ? 0 : -space.sm-2`。
- **验证**：`/@id/__x00__virtual:md-docs-protos` 注册两个新 key（watcher 热加载，无需重启）；playwright（headless shell 1208）断言两页 console 无 error、全部 testid 命中、project-card=3，全 PASS。截图 `task-8-login.png` / `task-8-project-list.png`。
- **注意**：`import type { RoleKey, StatusKey } from "../_shared/styles"` 可同时取类型与 token（styles.ts 统一导出，无 index.tsx）。表单输入用原生 input + inline 样式，纯静态无 onChange。

## T5 PRD 功能需求：任务与群聊协作（2026-08-06）

- **交付**：`docs/agent-platform/03-功能需求-任务与群聊协作.md`，frontmatter `title/order/kind/description`，order=3、kind=功能需求。
- **结构**：四个功能域（任务管理 / 群聊协作 / 消息上下文 / 实时性）→ 16 个功能点（FR-01~FR-16），每项含「FR-xx 编号 + 名称 + 描述 + 优先级（P0/P1/P2）+ 对应 US 编号」。优先级分布：13 P0 / 2 P1 / 1 P2。
- **FR 清单速记**：FR-01 任务创建 / FR-02 虚拟团队组建 / FR-03 四状态状态机（进行中-待验收-已完成-已归档）/ FR-04 验收流程 / FR-05 任务归档(P1) / FR-06 任务群聊 / FR-07 三类消息模型 / FR-08 定向@触发 / FR-09 @all / FR-10 Agent 间互@(P1) / FR-11 私聊与群聊共用 session / FR-12 上下文自动注入 / FR-13 token 分层管理(P2 后续迭代) / FR-14 实时查看会话 / FR-15 内部过程不广播 / FR-16 群聊消息持久化。
- **与 02 篇呼应**：US-01(FR-01/02/06) / US-02(FR-07/08/09/10) / US-03(FR-07/11) / US-06(FR-03/04/05) / US-07(FR-07/14/15) / US-08(FR-12/13/16)，16 个 FR 全部带对应 US 标注。
- **产品语言转换要点**：①「群聊消息存平台数据库」→ 产品表述「FR-16 群聊消息持久化」（不写 DB/API）；②「token 分层管理」需在正文明确出现 token 一词并标注后续迭代，但只写策略方向（按相关性裁剪/分轮整理），不写压缩实现；③ 验收流程不含阶段门禁/审批流，验收由成员作出，Agent 不参与判定。
- **验证方式**：内容注入端点 grep 命中 key + 本地断言（FR 数量 16 / 优先级分布 13:2:1 / 对应 US 数 16 / 必覆盖关键词）。证据存 `.omo/evidence/task-5-prd-collab.txt`。
- **复用点**：FR 编号与四状态机可直接作为 T10 原型状态标签与 T6 后续章节的引用锚点；FR-07 三类消息模型（用户/Agent 回复/系统）对齐 T2 共享组件 ChatBubble 的 type 枚举。

## T6 PRD 功能需求：Agent 管理与产出物（2026-08-06）

- **交付**：`docs/agent-platform/04-功能需求-Agent与产出物.md`，frontmatter `title/order/kind/description`，order=4、kind=需求。
- **结构**：① Agent 管理（FR-30 预置模板 / FR-31 模板克隆 / FR-32 完全自定义 / FR-33~36 配置项：提示词/技能/工具/权限 / FR-37 每 Agent 每任务独立会话）→ ② 产出物协议（FR-38 结构化输出 / FR-39~41 三类产出物：文本直接归档、文档经平台拉取 / FR-42 任务全局文档 / FR-43 版本历史 append 递增）→ ③ 任务文档库（FR-44 列表 / FR-45 查看与版本切换 / FR-46 @触发时注入上下文）→ ④ 技术底座愿景（一段概述，不展开）。
- **FR 编号衔接策略（关键）**：T5（03 篇）与 T6 并行，03 篇完成时用 FR-01~16。为规避并行竞态，本篇采用**独立区间 FR-30~46**，并在文档开头注明「若合并章节需统一编号可在评审阶段重排」。此策略安全：即使并行写作者用掉 01~29 也不冲突。
- **与 02 篇呼应**：FR-37 对应 US-03/07（群聊@与私聊共用同一 session、内部过程不广播只显示最终回复）；FR-42/43 对应 US-04（产出物全局文档+版本）；FR-30~36 对应 US-05（配置四项：提示词/技能/工具/权限）。术语沿用「session / 全局文档 / 版本 / 权限范围」。
- **技术底座表述**：仅一段愿景概述提及 opencode serve+SDK、json_schema 结构化输出、权限请求人机协同，与 T3/T5 的「愿景级一句带过」约束一致。
- **验证方式**：content 注入端点 grep 命中 04 key；关键词断言 9/9 PASS；技术设计排除断言（CREATE TABLE / api/v1 / GET / / POST / / SELECT / 接口契约 / ```json）全 0；FR 编号连续性核验 FR-30~46 无缺。证据存 `.omo/evidence/task-6-prd-agent.txt`。
- **复用点**：FR-38/39/40/42/43 是 T11 任务详情页（产出物列表+版本切换）的直接依据；FR-33/34/36 对应 T11 Agent 配置页（提示词编辑器/技能勾选/权限配置）；FR-46 支撑 T10 群聊 @ 注入上下文 mock。

## T7 PRD 非功能需求与验收边界（2026-08-06）

- **交付**：`docs/agent-platform/05-非功能与验收边界.md`，frontmatter `title/order/kind/description`，order=5、kind=需求。
- **结构**：① 非功能需求（性能目标值表 / 安全 / 可用性 / 可扩展性 / 可维护性）→ ② 技术约束（平台愿景）→ ③ 验收边界（本迭代交付物 / 完整平台功能清单 / 三列边界表 / 后续迭代清单）→ ④ 风险与开放问题。
- **关键写法**：技术约束明确标注"完整平台阶段的愿景，本迭代不落地任何技术选型"，与 Must NOT Have（不做技术设计）解耦；性能只给目标值不给实现方案（首字响应 ≤5s、消息显示 ≤1s、会话流查看 ≤2s、单任务 4~6 Agent 并行）。
- **边界呈现**：核心用「维度 | 本迭代 | 完整平台 | 后续迭代」三列表，一行一维度（认证/存储/实时推送/上下文管理等），比 3.1/3.2 单独列表更直观，供 T12 交互文档与 F 系列评审复用。
- **研究教训落点**：AutoGen token 爆炸 → token 成本风险行（缓解=按 agent 过滤历史+分层上下文）；LangGraph 状态持久化 → 状态持久化风险行；per-agent 错误边界 → 单 Agent 故障扩散行；框架不以进程退出表达错误 → 错误表达方式行；CrewAI 上下文污染 → 开放问题第 5 条。
- **验证方式**：内容注入端点 grep `05-非功能与验收边界` 命中；本地 grep 断言 4 个二级章节 + 10 个关键内容关键词，5/5 PASS。证据存 `.omo/evidence/task-7-prd-nfr.txt`。
- **复用点**：后续迭代项清单（仓库操作/PR、部署 CI、SSO、多租户、对象存储、SSE、token 压缩）需与 T12 交互文档及 F4 scope fidelity 检查保持一致。

## T11 原型：任务详情+文档库 与 Agent 配置（2026-08-06）

- **交付**：`prototypes/task-detail/index.tsx`（meta.id=task-detail）+ `prototypes/agent-config/index.tsx`（meta.id=agent-config），均 `device: "desktop"`、`satisfies PrototypeDef`，复用 `../_shared/components` 与 `../_shared/styles`。
- **task-detail 结构**：`TaskInfoHeader`（data-testid=task-info-header：T-1042 标题 + StatusBadge 待验收 + 优先级 + 参与 Agent 头像叠放 marginLeft:-6）+ TabBar（data-testid=artifact-tab，群聊/产出物/文档库三 tab 纯展示，文档库 active）+ 文档库视图（左侧 300px 产出物列表：3 个 artifact-item，含「需求文档 v2」多版本示例 versions: [v2, v1]；右侧 ArtifactViewer data-testid=artifact-viewer：类型标签/标题/版本切换示意 pill/正文预览/版本时间线脚注）。
- **产出物协议落地（对齐 PRD 04 FR-39/FR-43）**：三类产出物 `结论文本/文档/文件` 用原型局部 typeTheme 着色（结论文本=紫/文档=蓝/文件=绿，与 roleText 同族）；版本 append 递增，多版本示例「需求文档 v2」versions 数组第一个为当前版本，查看器底部展示 `v2 · 时间 → v1 · 时间` 时间线。
- **agent-config 结构**：Agent 列表（5 个 agent-list-item：4 角色模板 + 1 自定义「发布管家」克隆示例，右侧带启用开关示意）+ ConfigPanel：提示词 textarea（data-testid=prompt-editor，mono 字体、readOnly）+ 技能勾选（data-testid=skill-list，chips 带 ✓ 框）+ 工具配置（PermissionMatrix 工具×读/写/执矩阵开关，示意读取全开、写入仅文档库）+ 权限范围（data-testid=permission-config，可访问资源/可执行操作/写操作确认三行）+ 克隆入口（data-testid=clone-template-button，⧉ 克隆此 Agent）。
- **验证方式**：md-docs-protos 端点 grep 命中两 id + `/@fs/<abs>/prototypes/<name>/index.tsx` 返回 200 编译通过 → python playwright（headless shell 1208）断言 9 个 data-testid 存在 + artifact-item=3/agent-list-item=5 数量 + console 无 error，1440×900 截图。证据存 `.omo/evidence/task-11-task-detail.png` 与 `task-11-agent-config.png`。
- **⚠️ 本模型无法直接查看截图（不支持图片输入）**，依赖 playwright 断言 + 截图文件大小（165/190KB 非空白）判断渲染正常。
- **T12 复用**：task-detail 的 Artifact 类型/ArtifactViewer 版本切换示意、agent-config 的 PermissionMatrix 可拆出复用；若需真实交互（Tab/版本切换）再升级为受控组件。

## T10 群聊 + 私聊原型（2026-08-06）

- **交付**：`docs/agent-platform/prototypes/group-chat/index.tsx`（id=group-chat，device=both）+ `dm-chat/index.tsx`（id=dm-chat，device=both）。均复用 `../_shared/components` 与 `styles.ts` token，未改 _shared。
- **群聊布局**：四段式 — 深色 Sidebar（共享组件）+ 成员列表窄栏（196px，4 个 member-item 带 data-role，点击进入私聊示意）+ 消息区（ChatHeader 含任务名/StatusBadge/头像堆叠 → chat-message-list → mention-hint(@all 提示条) → MessageInput 默认四角色 @chips）+ 右侧 TaskPanel（任务标题/StatusBadge/3 个产出物入口/「查看 Agent 会话」按钮，内嵌"内部过程不广播"说明）。
- **@触发 mock 流程**（与 PRD 03 模型一致）：系统「开发者加入任务」→ 用户「@产品经理 请梳理优先级」→ 产品经理回复「收到@收到…」→ 开发者「@产品经理…@架构师 确认存储方案」→ 系统「架构师加入会话」→ 架构师回复「@开发者 复用配置表加 JSON 字段」→ 用户「@all 周五前输出验收清单」。7 条消息覆盖 system/user/agent 三型 + 单 @/互 @/@all。
- **私聊布局**：Sidebar + AgentInfoBar（dm-agent-info：Avatar lg + 角色名 + AgentBadge + 在线状态点 + "与群聊共用同一 session" 说明）+ 对话区（3 条无 @ 消息）+ 底部「查看历史会话」pill 入口（view-session-link）+ MessageInput `mentionable={[]}`（@chips 数=0，验证简化生效）。
- **device="both" 响应式**：group-chat 的 mobile 分支隐藏 Sidebar/成员栏/TaskPanel，仅保留 ChatHeader+消息+输入；dm-chat 隐藏 Sidebar。判断依据 `device === "mobile"`（PrototypeRenderProps）。
- **验证**：`/@fs/<abs>/.../index.tsx` 编译 200；playwright（chromium headless shell，executable_path 指 headless-shell 二进制）断言 data-testid 存在 + console 无 error；DOM 补充断言 group-chat bubbles=7 types=[system,user,agent,agent,system,agent,user]、members=4、@chips=4；dm-chat bubbles=3、@chips=0。截图 `task-10-group-chat.png` / `task-10-dm-chat.png`（198KB/115KB 非空）。
- **⚠️ 本模型不支持图片输入**：截图无法人工目检，改以 DOM 结构断言兜底（testid 数量 + 气泡类型序列 + chips 数）。
- **playwright python 环境**：`playwright` 模块可 import 但无 `__version__` 属性（新版）；浏览器用 headless shell（非 full chromium），launch 时须传 `executable_path=` headless-shell 二进制路径。

## T9 原型：任务创建 + 任务看板（2026-08-06）

- **交付**：`prototypes/task-create/index.tsx`（表单：task-title 输入 / task-description textarea / priority-select 原生 select；右栏 Agent 选择区 4 个 agent-option[data-role] 静态勾选 → 已选 AgentBadge 列表 → create-task-button）+ `prototypes/task-board/index.tsx`（Sidebar + TopBar 标题「任务看板」+ status-filter 筛选条（全部/进行中/待验收/已完成/已归档，静态激活「全部」）+ 4 张 task-card[data-status] 覆盖 4 种状态，卡片含 StatusBadge / 头像组（重叠 -6px）/ 产出物数量）。
- **meta 规范**：`{ id, name, group, description, device: "desktop" }`，`satisfies PrototypeDef`；id 即 URL hash（`#/p/agent-platform/protos/task-create`）。
- **验证方式**：`curl /@id/__x00__virtual:md-docs-protos | grep task-create|task-board` 确认注册 → `curl /@fs/.../index.tsx` 返回 200 即编译通过（500 则失败）→ playwright（chromium_headless_shell，executable_path 指定）断言各 data-testid 数量 + console 无 error + full_page 截图。12 项断言全 PASS，console errors 0。截图存 `.omo/evidence/task-9-task-create.png` / `task-9-task-board.png`。
- **关键经验**：① headless shell 路径 `~/.cache/ms-playwright/chromium_headless_shell-1208/...`，须显式传 executable_path。② 原生 `<select>` 需 `defaultValue` + width 限定（200px），测试直接按 testid 断言无需交互。③ 头像组重叠用负 margin `marginLeft: idx===0 ? 0 : -6`。④ 网格布局 `repeat(auto-fill, minmax(300px,1fr))` 让 4 卡片自动响应宽度。⑤ 本模型不支持图片输入，截图无法目检 → 依赖 data-testid 计数 + console error 断言兜底。
- **T10/T11 复用**：看板卡片结构（StatusBadge + 头像组 + 产出物数）与筛选条可被任务列表/详情引用；task-create 的 AgentOptionCard（data-role + data-checked）可作为 Agent 选择 UI 的通用范式。

## T12 PRD 交互与页面设计（2026-08-06）

- **交付**：`docs/agent-platform/06-交互与页面设计.md`，frontmatter `title/order/kind/description`，order=6、kind=交互设计。产品型 PRD 收尾篇（共 6 篇）。
- **结构**：① 页面总览（8 页 × 用途/入口/原型 ID/适配形态 表格）→ ② 8 个页面逐一说明（每页：用途/入口/关键交互 + ```prototype 内嵌块，id 与原型 meta.id 一一对应：login/project-list/task-create/task-board/group-chat/dm-chat/task-detail/agent-config）→ ③ 4 条核心交互流程（@ 触发协作 / Agent 会话实时查看 / 产出物提交与归档 / 任务验收流程，均锚定 FR 编号）→ ④ mermaid 页面流转（登录→项目列表→任务创建→群聊/看板→任务详情→验收归档 + 私聊/Agent 配置旁路）→ ⑤ 交互一致性约定表。
- **原型内嵌语法（关键）**：块级 ```prototype 内为 `id: <原型id>` + 可选 `title/device/height`（height 默认 640，建议按原型复杂度给 520~600）；内联引用 `@prototype[id]` 渲染为可点击标签。解析器只识别恰好 3 反引号的 prototype 围栏，展示写法本身须用 4+ 反引号。原型按当前项目解析，跨项目引用会提示「不存在于当前项目」。
- **写作用法**：8 个页面全部用块级内嵌（id 命中 8/8），核心交互流程只做文字描述不嵌原型，避免文档过重；mermaid 用 `flowchart LR` + 双引号包裹含括号/斜杠的节点 label（如 "验收归档<br>已完成 / 已归档"）。
- **一致性锚点**：FR 引用贯穿全文（FR-08 仅被 @ 的 Agent 收到 / FR-09 @all / FR-10 互 @ / FR-11 共用 session / FR-15 不广播 / FR-39~43 三类产出物+版本 / FR-03~05 状态机 4 态+验收+归档），与 03/04 篇逐条对齐。
- **验证方式**：content 注入端点 grep 命中 `"/docs/agent-platform/06-交互与页面设计.md"`；本地断言 8 个 prototype id 各命中 1 次 + 11 个核心关键词 + mermaid 存在；8 个原型 `/@fs/.../index.tsx` 全 HTTP 200（内嵌 URL 有效性）。证据存 `.omo/evidence/task-12-interaction.txt`。
- **复用点**：06 篇的页面流转图与一致性约定表可直接作为评审时产品演示的导航提纲；```prototype 内嵌语法可复用于后续任意带原型的文档章节。

## T13 md-docs 构建与全量验证（2026-08-06）

- **构建**：`md-docs build --out-dir /tmp/site` EXIT:0，产物 `index.html + assets/`（96 文件）。dev 服务 5177 与 build 共用同一套注入插件，行为一致。
- **全量检查通过**：内容注入 6 文档 key + _meta（_meta 带 frontmatter 但**不进入文档树**，文档树仅 6 篇）；原型注册 8 个 id 无 _shared；playwright 走查 8 原型 testid 全命中 + console 0 error；06 篇页面总览表 8 个原型 ID 与 meta.id 一一对应（组件内 mock 数据的内部 id 如 p1/T-1042/req-doc/pm-template 不是 meta.id，勿误判）。
- **⚠️ 关键 bug 修复：中文文档 id 的 hash 路由失效**。md-docs `App.tsx parseHash()` 取 docId 后直接 `findProjectDoc` 匹配，**未 decodeURIComponent**；文档 id 为中文时（文件名去序号推断），点击文档树后 `location.hash` 被浏览器 percent-encode 成 `%E4%BA%A4...`，匹配失败回退默认文档 → 正文不切换（URL 变了但内容不变）。**修复**：给 6 篇文档 frontmatter 增加英文 `id` 字段（scanner.ts `fm.id ?? inferId(rel)` 优先于文件名推断）：01-bg-goals / 02-users-scenarios / 03-req-task-chat / 04-req-agent-artifacts / 05-nonfunc-acceptance / 06-interaction-design。复验：点击切换 4 篇均 PASS，直达 `#/p/agent-platform/docs/interaction-design` PASS。**经验：md-docs 文档 id 尽量用英文（frontmatter id 或纯英文文件名），中文 id 有 hash 路由 bug；不要改工具源码，交付物层加英文 id 即可。**
- **验证端点备忘**：内容注入 `curl http://localhost:5177/@id/__x00__virtual:md-docs-content`（key 形如 `"/docs/agent-platform/01-背景与目标.md"` 带前导 `/`）；原型注册 `curl .../md-docs-protos`（输出 import 语句 `prototypes/<id>/index.tsx`）。浏览器走查：文档树导航是 `<button>` 非 `<a>`，断言正文切换用 body innerText 关键 marker（如「页面总览」）而非 a[href]。
- **证据**：`.omo/evidence/task-13-build.txt`（构建+注入+注册+一致性）、`task-13-walkthrough.txt`（8 原型走查矩阵）。


## 导航变体 B：Command Palette 主导航原型（2026-08-06）

- **交付**：`prototypes/nav-cmdk/index.tsx`（meta.id=nav-cmdk，name=导航变体B-命令面板主导航，device=desktop，`satisfies PrototypeDef`），复用 `../_shared/components`（StatusBadge/AgentAvatar/AgentBadge）与 `../_shared/styles`，**未用 Sidebar**，未改 _shared。
- **范式突破**：完全无侧边栏。页面 = 顶栏（左面包屑 top-breadcrumb「项目名 › 任务名」+ 中 cmdk-trigger 搜索框（含 ⌘K 徽标、width 280）+ 右用户头像）+ 全屏内容区（任务详情 + 文档库，复用 task-detail 布局思路但独立实现，产出物 3 项：需求文档 v2[多版本]/技术方案 v1/实现说明 v1，类型色：结论文本=紫/文档=蓝/文件=绿）。
- **命令面板默认可见**（静态展示"按下 ⌘K 后"状态）：`cmdk-panel` fixed inset 0 + 轻遮罩 rgba(15,23,42,.32)（内容仍可辨）+ 面板 600px 宽、毛玻璃 `backdrop-filter: blur(20px) saturate(1.5)` + rgba(255,255,255,.84) + shadow 大投影 + 圆角 radius.lg；顶部 `cmdk-search`（autoFocus readOnly input value="任务" + 光标闪烁动画）；命令分组「导航（切换项目/任务看板/Agent 管理）」+「操作（新建任务/查看产出物/查看 Agent 会话）」共 6 个 `cmdk-item`，当前项（switch-project）data-active=true 用 #2563EB 实底白字高亮；底部提示条（↑↓ 选择 · ↵ 打开 · ⌘K 唤起）。
- **scoped 动画**：组件内 `<style>` 标签注入 keyframes（navcmdk-pop/navcmdk-fade/navcmdk-blink），命名加 navcmdk 前缀避免污染其他原型（React 内联 `<style>{str}</style>` 合法可用）。
- **验证**：md-docs-protos 端点命中 + `/@fs/.../nav-cmdk/index.tsx` HTTP 200 → playwright（headless shell 1208）断言 5 个 testid 存在 + cmdk-item=6/active=1/artifact-item=3 + 面包屑文本 + 搜索框值 + console 0 error，10/10 PASS。截图 `.omo/evidence/nav-B-cmdk.png`。
- **复用经验**：① 顶栏中间搜索框 + ⌘K 徽标是 Cmd+K 范式关键视觉锚点（trigger 即"可点击唤起"的暗示）；② 命令面板用 fixed inset 0 覆盖整个 iframe 视口（含顶栏），符合真实 Cmd+K 覆盖整页的交互心智；③ 毛玻璃须同时写 backdrop-filter 与 WebkitBackdropFilter；④ 遮罩透明度 .32 在"面板可见 + 主体可读"间平衡最好。

## T14 导航变体 A：Dock / Rail 悬浮导航原型（2026-08-06）

- **交付**：`prototypes/nav-rail/index.tsx`（meta.id=nav-rail，name=导航变体A-Dock悬浮导航，device=desktop，group=导航变体）。核心：**不引入任何 JS 状态**，用内嵌 `<style>{railCss}</style>` 模板字符串 + 类名实现纯 CSS hover 展开（`position:fixed` Dock 条 `width 56→248px` transition + `.rail-dock:hover .rail-panel{opacity:1}`），React inline style 写不了 `:hover`，必须走 style 标签。
- **复用**：ChatBubble/MessageInput/AgentAvatar/StatusBadge/TopBar + styles token（7 条 PRD 03 @触发 mock 消息流原样复用 group-chat 数据）；**刻意不用 Sidebar**（本变体即其替代）。新增色值全部模板插值 token（`${neutral[400]}` 等），仅毛玻璃透明度 rgba 为本地常量。
- **毛玻璃方案（解决深色侧边栏与浅色内容不搭配）**：`background: rgba(255,255,255,.72)` + `backdrop-filter: blur(14px) saturate(1.4)` + 细边框 `rgba(15,23,42,.08)` + 阴影 `0 14px 36px rgba(15,23,42,.14)`；Dock 垂直居中 `left:12px; top:50%; translateY(-50%)`，z-index:50 悬浮不占流，内容区仅 `paddingLeft: RAIL_W+24` 留白避免遮挡（背景仍从屏幕左缘铺满）。
- **当前页高亮**：rail-icon 与 nav-item 均 `data-active`，高亮色取 roles.product.color（#3B82F6，任务指定的"角色色"就是产品角色蓝）；active icon 加 `::before` 左侧 3px 圆角指示条（VS Code Activity Bar 风格，定位 `left:-8px` 超出按钮边界需要 rail-icons 列 `position:relative; z-index:2` 防被 panel 盖住）。
- **⚠️ playwright 时序竞态（本次踩坑）**：`goto(wait_until="networkidle")` 后立即 count testid 会读到 0——md-docs hash 路由切到原型有延迟；首次脚本 count 全 FAIL 但 hover PASS（元素在检查后、hover 前才渲染）。**解法：`page.wait_for_selector('[data-testid="rail-bar"]', timeout=8000)` 轮询就绪后再断言**（与 T11 agent-config 竞态同因，统一教训）。
- **验证**：md-docs-protos 注册 nav-rail + `/@fs/.../index.tsx` HTTP 200（vite 编译通过即无语法错，本机 typescript-language-server 未安装无法 LSP 检查，以编译+playwright 兜底）；playwright 13/13 PASS（rail-bar/rail-icon×4/rail-panel/nav-item×4/active 各 1/chat-bubble×7/message-input/topbar/task-info-panel/hover 展开 opacity 0→1/console 0 error）。截图 `.omo/evidence/nav-A-rail.png`（215KB 非空）。
- **注意**：CSS 模板字符串里写 token 插值 `neutral[400]` 曾漏写 `]` 成 `neutral[400}]` 导致编译失败，@fs 端点会返回 500 + `const error={message` 可解析；写完先 curl @fs 再跑 playwright。

## T15 修复导航变体定位溢出：fixed/视口单位跑出 DeviceFrame（2026-08-06）

- **Bug 根因**：md-docs 原型在固定尺寸的 DeviceFrame 容器内渲染，`position: fixed` 相对**浏览器视口**而非原型容器 → Dock 弹层/命令面板跑出展示区并覆盖整屏其它功能；`100vh/100vw/12vh/74vh` 同理是视口单位。
- **修复模式（两个原型通用）**：
  1. root 容器保证 `height: 100%; position: relative`（absolute 定位锚点，nav-cmdk 原为 `100vh` 改 `100%` 并补 `position: relative`）；
  2. 浮层 `position: fixed` → `position: absolute` + `inset: 0`（nav-cmdk 遮罩本就是 absolute inset:0 不动）；
  3. 视口单位全部改相对容器：`calc(100vw-48px)` → `calc(100% - 48px)`（100% 相对 absolute inset:0 的浮层宽度 = 容器宽）、`min(560px, 74vh)` → `min(560px, 74%)`、`paddingTop: 12vh` → `12%`；
  4. nav-rail 的 Dock 垂直居中 `top:50%; transform: translateY(-50%)` 在 absolute 下同样生效，仅把 `.rail-dock{position:fixed}` 改 absolute。
- **验证（playwright 15/15 PASS）**：8 个既有 testid（rail-bar/rail-icon×4/rail-panel/nav-item×4 + top-breadcrumb/cmdk-trigger/cmdk-panel/cmdk-search/cmdk-item×6）全存在 + console 0 error；**新增边界断言**：用 `getBoundingClientRect` + `offsetParent` 的 rect 比较，断言 dock/panel/搜索框在原型容器内（nav-rail 含 hover 展开后仍在容器内；nav-cmdk 面板中心 x 与容器中心差 ≤12px 即居中）。截图更新 `nav-A-rail.png` / `nav-B-cmdk.png`。
- **⚠️ playwright remove_listener 坑**：传新 lambda 给 `page.remove_listener` 会 KeyError（pyee 按函数对象匹配），移除监听直接用新数组 + goto 前 `clear()`，不要 remove_listener。
- **通用教训**：md-docs 原型内**禁用 fixed 与任何 vh/vw 单位**，一律 absolute + root relative + %；写前 grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 自查，写完 curl `/@fs/.../index.tsx` 200 确认编译。

## T16 导航融合版：Dock + Cmd+K 合二为一原型（2026-08-06）

- **交付**：`prototypes/nav-hybrid/index.tsx`（meta.id=nav-hybrid，name=导航方案-融合版，device=desktop，`satisfies PrototypeDef`）。复用 `../_shared/components`（ChatBubble/MessageInput/AgentAvatar/StatusBadge）与 `../_shared/styles`，未改 _shared / nav-rail / nav-cmdk。
- **三层结构**（T15 教训全落实：root `height:100%; position:relative`，全部浮层 absolute，零 fixed/vh/vw，写前 grep 自查）：① 左侧 Dock 悬浮导航（复用 nav-rail 的 railCss 原样：absolute `left:12px; top:50%; translateY(-50%)` 垂直居中、56→248px hover 展开、4 图标、active 高亮 + ::before 左侧指示条）② 浅色顶栏（复用 nav-cmdk 的 CmdkTopBar：top-breadcrumb 面包屑 + 居中 cmdk-trigger 搜索框含 ⌘K 徽标 + 右用户头像）③ Cmd+K 命令面板（absolute inset:0 + paddingTop:12% 居中、600px 毛玻璃 blur(20px)、cmdk-search + 6 个 cmdk-item、默认可见模拟 ⌘K 按下态）。
- **融合关键设计 —— z-index 分层**：命令面板容器 `z-index:40`（含遮罩 .32），Dock `z-index:50` → **面板弹出时 Dock 仍浮于遮罩之上可 hover 展开**，直观呈现"两者共存不冲突"。真实 ⌘K 心智（面板盖全页）+ Linear 常驻图标栏心智同时成立。这是融合版区别于两个变体单跑的核心点。
- **交互呼应**：命令面板「导航」组图标与 Dock 图标一一对应（切换项目 ▤ / 任务看板 ☰ / Agent 管理 ◉），cmdK-trigger 文案「搜索或输入命令…」，面板底部右侧加融合提示「Dock 常驻 · ⌘K 全览」。
- **内容区**：任务群聊「通知中心迭代」（7 条 PRD 03 @触发消息流 + MessageInput + 右 TaskPanel 产出物 3 项）复用 nav-rail 布局；内容区 `position:absolute; top:60; left:0; right:0; bottom:0` + `paddingLeft: RAIL_W+24` 留白避 Dock，代替 nav-rail 的 flex column 写法（等价且与顶栏 60px 解耦）。
- **验证（playwright 18/18 PASS）**：6 个 testid 存在 + rail-icon=4/nav-item=4/cmdk-item=6/chat-bubble=7 + rail-bar/cmdk-panel/cmdk-trigger boundingBox 均在 `nav-hybrid-root` 容器内 + cmdk-panel 中心 dx=0 居中 + Dock 默认收起（w=1 opacity=0）→ hover 展开（w=192 opacity=1）且展开后仍在容器内 + console 0 error。截图 `.omo/evidence/nav-hybrid.png`。
- **经验**：① 容器内边界断言用 root 元素（自加 `data-testid="nav-hybrid-root"` 作锚点，避免找 DeviceFrame）boundingBox 比较，用 ±1px 容差防亚像素；② Dock 的 hover 态在命令面板遮罩存在时仍可测——因为 Dock z-index 高于遮罩，pointer 事件不被拦截（若反过来遮罩盖住 Dock，hover 将无法触发，融合层叠必须 Dock 在上）；③ f-string 内嵌双引号 data-testid 选择器会 SyntaxError，改为先取 count 变量再 % 拼接。

## T17 共享导航组件提取：nav.tsx（2026-08-06）

- **交付**：`prototypes/_shared/nav.tsx`，导出三个独立可组合组件（未改 components.tsx / styles.ts，未建 `_shared/index.tsx` 防误注册）。从 nav-hybrid 原型提取，视觉与 T16 融合版一致。
- **导出 API（供 7 页面改造任务引用，页面内 `import { NavDock, NavTopBar, CmdKPanel } from "../_shared/nav"`）**：
  1. **NavDock** `{ activeKey?, projectName?="Agent 协作平台", onNavClick?(key), children?, style?, className? }`——Dock 悬浮条，纯 CSS hover 展开 56→248px，导航项 项目▤/任务看板☰/Agent 管理◉/消息中心✉；activeKey 命中项 rail-icon + nav-item 双高亮（#3B82F6 + ::before Activity Bar 指示条）；`children` 渲染在展开面板底部（如成员列表）。testid：`rail-bar`/`rail-icon`(×4, data-nav)/`rail-panel`/`nav-item`(×4)。
  2. **NavTopBar** `{ breadcrumb?: string[], title?="任务看板", subtitle?, userName?="运营者", userRole?="项目管理员", onCmdKClick?, children?, style?, className? }`——浅色顶栏 height 60；左侧 breadcrumb 数组用 › 连接（无 breadcrumb 时回退 title+subtitle 渲染），中 cmdk-trigger（「搜索或输入命令…」+ ⌘K 徽标，width 280），右用户头像；`children` 插在头像右侧。testid：`topbar`/`top-breadcrumb`（或 `top-title`）/`cmdk-trigger`。
  3. **CmdKPanel** `{ open?=true, items?: {group,label,icon,active?}[], onSelect?(label), children?, style?, className? }`——居中毛玻璃 + 遮罩（absolute inset:0），items 默认「导航/操作」两组 6 条（切换项目▤/任务看板☰/Agent 管理◉/新建任务＋/查看产出物▦/查看 Agent 会话◷），按 group 保序分组渲染；open=false 时 return null；`children` 覆盖底部提示条（默认 ↑↓/↵/⌘K + 「Dock 常驻 · ⌘K 全览」）。testid：`cmdk-panel`/`cmdk-search`/`cmdk-item`。
- **关键实现**：三个组件均支持 style/className 透传（沿用 components.tsx 惯例）；导航高亮蓝 #3B82F6 与 styles.roles.product 一致，收敛为具名常量 NAV_ACTIVE/NAV_ACTIVE_DEEP 不散落；box-shadow 用 shadow.md/lg token（dock hover 用 lg）；hover/动画必须走组件内 `<style>` 标签注入 class + scoped keyframes（navshared- 前缀，dockCss/panelCss 各自含 navAnimStyle）；T15 铁律落实——NavDock absolute `left:12px; top:50%; translateY(-50%)`、CmdKPanel absolute inset:0 + paddingTop 12%，零 fixed/100vh/100vw（写后 grep 自查通过）。
- **z-index 分层保留 T16 心智**：CmdKPanel 容器 z-40，NavDock z-50 → 面板弹出时 Dock 仍可 hover 展开。
- **验证**：临时 `prototypes/_navsmoke/index.tsx` 冒烟（NavTopBar breadcrumb + NavDock activeKey="messages" + CmdKPanel 默认 items），playwright 21/21 PASS：6 testid 存在 + rail-icon=4/nav-item=4/cmdk-item=6 + active 各 1 + rail-bar/cmdk-trigger/cmdk-panel boundingBox 均在 `nav-smoke-root` 容器内（±1px）+ cmdk-panel 居中 dx=0 + Dock 56→248 hover 展开 + panel opacity 0→1 + 展开后仍在容器 + console 0 error。截图 `.omo/evidence/nav-shared-smoke.png`（1440×900）。验证后已删除 _navsmoke 目录。
- **⚠️ 经验**：`_shared/nav.tsx` 可被页面以 `../_shared/nav` 相对导入（页面在 prototypes/<name>/，_shared 同级，与 components 导入一致）；md-docs 插件端不排除 `_` 前缀原型目录，临时冒烟原型 `_navsmoke` 会被注册，验证完必须删除。

## T18 agent-config 接入融合导航：Sidebar → NavDock + NavTopBar + CmdKPanel（2026-08-06）

- **交付**：改造 `prototypes/agent-config/index.tsx`（meta.id=agent-config 不变，7 页面导航统一首例）。移除 `_shared/components` 的 `Sidebar/TopBar` 引用，改 `import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav"`，业务组件（AgentAvatar 保留 / PermissionMatrix / ConfigPanel / AgentListItem）与全部业务 testid 原样未动，未改 _shared。
- **改造结构**（T15/T17 全落实）：root `data-testid=agent-config-root` + `height:100%; position:relative; backgroundColor:neutral[50]`（原 100vh→100%）；NavTopBar `title="Agent 配置" subtitle="预置模板 · 自定义 Agent · 配置项"`（**不传 breadcrumb**，有 breadcrumb 时 title 会被覆盖，用 title 模式渲染 `top-title`）；内容区 `position:absolute; top:60; left:0; right:0; bottom:0; overflow:auto; paddingLeft: RAIL_W+24(=80px)` 避让 Dock，内层 `padding:space.xl` + flex（左 320px 列表 + ConfigPanel flex:1）；NavDock `activeKey="agents"`；CmdKPanel `open items={CMDK_ITEMS}`。
- **CmdKPanel items 自定义**：`CmdKItem[]` 类型来自 `../_shared/nav`；导航组图标与 Dock 一一对应（切换项目▤/任务看板☰/Agent 管理◉ active），操作组贴合本页（克隆当前 Agent ⧉/编辑提示词 ✎/调整权限范围 ⚙），替代默认 6 条。
- **⚠️ NavTopBar title 与 breadcrumb 互斥**：`hasBreadcrumb` 优先渲染 breadcrumb，title/subtitle 被忽略；要显示 `top-title`（任务要求 title="Agent 配置"）就只传 title+subtitle，别同时传 breadcrumb。
- **验证（playwright 19/19 PASS）**：业务 6 testid（agent-list-item=5/prompt-editor/permission-config/clone-template-button/skill-list）+ 导航 4 testid（rail-bar/topbar/cmdk-trigger/cmdk-panel，均共享组件自带）+ cmdk-item≥6/rail-icon=4 + Dock active icon=1 且 data-nav=agents + rail-bar/cmdk-panel/cmdk-trigger/topbar boundingBox 均在 agent-config-root 内（±1px）+ console 0 error。截图 `.omo/evidence/agent-config-new.png`（221KB 非空）。源码 grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 仅注释命中。
- **复用经验**：7 页面统一改造范式 = 共享组件零改动 + 页面 root `relative/100%` + 内容区 `absolute top:60 paddingLeft:80` + `CmdKPanel items` 按页定制（操作组贴业务）+ playwright 复用 T14/T16 的 wait_for_selector 轮询与容器内边界断言模板。

## T18 任务看板接入融合导航（2026-08-06）

- **交付**：`prototypes/task-board/index.tsx` 改造——删除深色 Sidebar，接入 `_shared/nav.tsx` 三组件（NavDock/NavTopBar/CmdKPanel），未改 _shared 与其他原型。
- **改造点**：① 页面 root `height:100% + position:relative`（T15 铁律）；② 内容区 `position:absolute; top:60; left:0; right:0; bottom:0; flex column` + `paddingLeft: RAIL_W + space.xl`（56+24=80px）留白避 Dock，保留原 status-filter + task-card 网格；③ NavDock `activeKey="board"`（rail-icon data-active 高亮「任务看板☰」）；④ NavTopBar `title="任务看板"` + subtitle 任务统计；⑤ CmdKPanel `items={cmdkItems}` 默认 open，导航组图标与 Dock 一一对应，当前页「任务看板」项 `active:true` 高亮（呼应 dock 高亮）。
- **NavDock children 用法（新）**：children 渲染在展开面板底部 navdock-extra 槽位，可放页面局部数据——本次放「任务统计」列表（4 状态计数，由 tasks.reduce 生成），与 nav.tsx 注释约定一致。
- **验证（playwright 17/17 PASS）**：6 个导航 testid（rail-bar/topbar/cmdk-trigger/cmdk-panel + status-filter/status-filter-option≥5）+ task-card≥3 且 data-status 覆盖 4 状态 + dock active=board（count=1）+ cmdk-item≥6 且 active=1 + rail-bar/topbar/cmdk-panel boundingBox 均在 `task-board-root` 内（±1px）+ Dock hover 展开（width>100）后仍在容器内 + console 0 error。截图 `.omo/evidence/task-board-new.png`（189KB）。
- **复用经验**：① 7 页面接入融合导航的通用模板即 T18 结构（root relative + NavTopBar 文档流顶部 + absolute 内容区留白 + NavDock absolute + CmdKPanel absolute，z 40/50 分层保留 T16 心智）；② `activeKey` 与 cmdk items 中对应项 `active:true` 需成对设置保持导航语义一致；③ 内容区 top:60 与 NavTopBar height 60 解耦（改 NavTopBar 高度只需同步一处）；④ `onNavClick={() => undefined}` 可让 Dock 按钮可点击但不产生路由（纯展示原型）。

## T18 task-create 融合导航改造（2026-08-06）

- **交付**：`prototypes/task-create/index.tsx` 改造——深色 Sidebar 换为与已确认 nav-hybrid 一致的融合导航，未改 _shared / 其他原型。
- **改造点**：import 从 `../_shared/components` 的 Sidebar/TopBar 改为 `../_shared/nav` 的 NavDock/NavTopBar/CmdKPanel（components 仅保留 AgentAvatar/AgentBadge）。页面结构三层（T15 铁律全落实）：root `data-testid="task-create-root"` `height:100%; position:relative` → NavTopBar `title="创建任务" subtitle="提交需求，组建虚拟 AI 团队"`（文档流顶部，自带 topbar/cmdk-trigger）→ 内容区 `position:absolute; top:60; left:0; right:0; bottom:0; overflow:auto; padding:xl; paddingLeft: RAIL_W+24(=80)`（避让 Dock + 内部可滚动）→ NavDock `activeKey="board" projectName="Agent 协作平台"` → CmdKPanel `items`（默认 6 条 + 「新建任务」设 active=true 高亮，契合本页）。
- **CmdKPanel items 传参**：默认 items 已含「新建任务」，但当前页面语境下应通过 `items` prop 把「新建任务」置 `active: true`（nav-hybrid 中是 switch-project active），视觉更贴合"正处于创建任务"的演示态。
- **保留/新增 testid**：原表单业务 testid 全保留（task-title/task-description/priority-select/agent-option×4[data-role,data-checked]/create-task-button/selected-agents）；导航 testid 由 _shared 组件自带（rail-bar/rail-icon×4/topbar/cmdk-trigger/cmdk-panel/cmdk-item×6），页面无需重造。
- **验证（playwright 21/21 PASS）**：业务 4 testid + agent-option=4（roles 四角全对、checked=2 产品/开发）+ rail-bar/topbar/cmdk-trigger/cmdk-panel 存在 + rail-icon=4/cmdk-item=6 + rail active=1 且 data-nav="board" + topbar title 含「创建任务」+ rail-bar/cmdk-panel/topbar boundingBox 均在 root 容器内（±1px）+ rail-bar computed position==absolute（无 fixed）+ console 0 error。截图 `.omo/evidence/task-create-new.png`（182KB）。
- **经验**：① 内容区避让 Dock 用 `paddingLeft: RAIL_W+24` 局部常量（RAIL_W=56 与 nav.tsx 对齐），overflow:auto 放在 absolute 内容容器上让表单区独立滚动，与顶栏 60px 解耦（复用 T16 写法）；② activeKey 语义：任务创建归属「任务看板」域用 "board"（nav-hybrid 群聊场景才是 "messages"），7 页面改造时按页归属选 project/board/agents/messages 之一；③ grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 自查只应命中注释里的铁律说明，代码零违规。

## T18 业务页融合导航改造第一弹：project-list（2026-08-06）

- **交付**：`prototypes/project-list/index.tsx`（meta.id=project-list 不变，device "both"→"desktop"），**移除 Sidebar/TopBar 引用**，改为复用 `../_shared/nav` 的 NavDock + NavTopBar + CmdKPanel，与用户已确认的 nav-hybrid 方案一致。未改 _shared/nav.tsx / components.tsx / styles.ts / 其他原型。
- **页面结构**：root `height:100%; position:relative; display:flex; flexDirection:column` → NavTopBar（title="项目列表" subtitle="选择项目进入 AI 协作工作区"，文档流顶部 height 60）→ main（flex:1; minHeight:0; overflowY:auto；padding `xl xl xl 80px` 左侧留白避让 Dock）→ NavDock（activeKey="project"，z-50）→ CmdKPanel（默认 open，z-40）。内容区用 flex column 而非 nav-hybrid 的 absolute top:60 写法（等价且无需硬编码 60，Dock 垂直居中相对整 root 含顶栏，与 nav-hybrid 一致）。
- **数据/交互呼应**：3 个 mock 项目原样保留（智能报表模块 p1 / 数据采集平台 p2 / 告警中心 p3），ProjectCard 组件未动；CmdKPanel 传自定义 items——「导航」组（切换项目▤[active=true] / 任务看板☰ / Agent 管理◉）与 Dock 图标一一对应 + 「操作」组（新建项目＋/查看产出物▦/查看 Agent 会话◷），active 高亮「切换项目」呼应当前 project 页（nav-hybrid 原为 switch-project，范式一致）。
- **验证（playwright 19/19 PASS）**：project-card=3（≥2）+ create-project-button=1 + rail-bar/topbar/cmdk-trigger/cmdk-panel 各 1 + rail-icon=4/nav-item=4/cmdk-item=6 + rail-icon[data-nav=project][data-active=true]=1 + cmdk-item[data-active=true]=1 + top-title 含「项目列表」+ 容器内边界断言 4 元素全在 project-list-root 内（±1px，rail-bar x=269 相对 root x=257 偏移 12 即 left:12px 生效）+ Dock hover 56→248 展开 + console 0 error。截图 `.omo/evidence/project-list-new.png`（175KB 非空）。
- **经验**：① 页面自加 `data-testid="project-list-root"` 作容器锚点（沿用 nav-hybrid/T17 冒烟惯例）；② CmdKPanel 的 items 可按页定制（默认 items 是通用「切换项目」，业务页改为「新建项目」更贴页语义，active 项随页面切换）；③ f-string 内嵌 `"[data-testid=...]"` 双引号必 SyntaxError（T16 同坑），验证脚本一律 `"xxx" % var` 拼接；④ device "both"→"desktop"：融合导航为桌面范式，mobile 分支的 64px 深色窄栏已随 Sidebar 一并移除（7 页面后续改造同此原则）。

## T18 dm-chat 融合导航改造：Sidebar → NavDock + NavTopBar + CmdKPanel（2026-08-06）

- **交付**：改造 `prototypes/dm-chat/index.tsx`，移除 `_shared/components` 的 Sidebar 引用，改用 `_shared/nav`（T17 共享组件）三件套：`NavDock activeKey="messages"` + `NavTopBar title="私聊"` + `CmdKPanel`（默认 open，模拟 ⌘K 按下态）。未改 _shared 与其他原型，未引入第三方库。
- **页面结构**（T15 铁律全落实，零 fixed/vh/vw）：root `height:100%; position:relative` → 文档流顶部 `NavTopBar`（height 60）→ 内容区 `position:absolute; top:60; left:0; right:0; bottom:0` + `paddingLeft: 80`（DOCK_PAD 常量 = NavDock 收起 56 + left 12 + 余量，避让悬浮条）→ 内容区 flex column：AgentInfoBar（dm-agent-info，含「与群聊共用同一 session」说明）+ DmMessageList（3 条 mock）+ DmFooter（view-session-link + MessageInput mentionable=[]）。NavDock / CmdKPanel 均为 absolute 浮层，z-50 / z-40 分层保留 T16 心智。
- **device 调整**：`"both"` → `"desktop"`（Dock + 顶栏 + 命令面板为桌面范式，移动端已无意义；与 nav-hybrid 一致）。
- **验证（playwright 21/21 PASS）**：既有 testid 保留（chat-bubble=3 / dm-agent-info / view-session-link / message-input）+ 新增导航 testid（rail-bar / topbar / cmdk-trigger / cmdk-panel / rail-icon=4 / nav-item=4 / cmdk-item=6 / rail+nav active 各 1）+ rail-bar/cmdk-panel/cmdk-trigger boundingBox 均在 `dm-chat-root` 容器内（±1px）+ cmdk-panel 居中 dx=0 + Dock 56→248 hover 展开 + 「与群聊共用同一 session」「查看历史会话」文案 + console 0 error。截图 `.omo/evidence/dm-chat-new.png`（181KB）。
- **复用范式**：7 页面统一改造模板 = root(relative) + NavTopBar(流) + 内容区(absolute top:60 + paddingLeft:80) + NavDock(activeKey 对应页) + CmdKPanel(默认开)；activeKey 用 NAV_ITEMS key（project/board/agents/messages），dm-chat 对应 messages。验证脚本 `.omo/../tmp/opencode/dm-chat-nav-verify.py` 为通用断言模板（testid 保留 + 新增 + 容器内边界 + 居中 + hover 展开 + console）。

## T18 task-detail 融合导航改造：Sidebar → NavDock + NavTopBar + CmdKPanel（2026-08-06）

- **交付**：改造 `prototypes/task-detail/index.tsx`（meta.id=task-detail 不变），移除 `_shared/components` 的 Sidebar/TopBar 引用，改用 `_shared/nav` 三件套：`NavDock activeKey="board"` + `NavTopBar title="任务详情" subtitle="T-1042 · 智能报表模块开发"` + `CmdKPanel`（默认 open，items 走默认 6 条）。未改 _shared 与其他原型，未引入第三方库。
- **页面结构**（T15 铁律全落实，零 fixed/vh/vw——grep 只命中注释铁律说明）：root `data-testid="task-detail-root"` `height:100%; position:relative` → 文档流顶部 NavTopBar → 内容区 `position:absolute; top:60; left:0; right:0; bottom:0; overflow:auto; padding:xl; paddingLeft: CONTENT_PAD_LEFT=RAIL_W+24=80`（避让 Dock + 整区独立滚动）→ 文档库视图 flex row（产出物列表 300px + ArtifactViewer flex:1, 行 flex:1 minHeight:0 让查看器撑满可用高度）→ NavDock z-50 → CmdKPanel z-40。
- **业务 mock 全保留**：TaskInfoHeader（task-info-header）/ TabBar（artifact-tab，文档库 active + 4 计数）/ 3 个 ArtifactItem（需求文档 v2[versions v2→v1 多版本] / 技术方案 v1 / 实现说明 v1，artifact-item[data-artifact-id]/artifact-viewer）；activeKey 选 "board"（任务详情归属任务看板域，nav-hybrid 群聊才用 messages）。
- **验证（playwright 18/18 PASS）**：既有 4 testid（artifact-item=3≥2 / artifact-viewer / task-info-header / artifact-tab）+ 新增导航 4 testid（rail-bar / topbar / cmdk-trigger / cmdk-panel）+ 页面文本含 v1+v2（查看器版本切换 pill）+ rail-bar/topbar/cmdk-trigger/cmdk-panel boundingBox 均在 task-detail-root 内（±1px，rail-bar x 相对 root 偏移 12 即 left:12px 生效）+ cmdk-panel 居中 dx=0 + task-info-header.x ≥ root.x+60（内容避让 Dock 生效）+ console 0 error。截图 `.omo/evidence/task-detail-new.png`（188KB 非空）。
- **经验**：① 文档库 flex row 需 `flex:1; minHeight:0` 才能让 ArtifactViewer（自身 overflow:hidden + 正文 overflow:auto）在内容区绝对定位下撑满高度，外容器 overflow:auto 兜底整页滚动，两者叠加是任务详情页专属形态；② 既有 4 个业务 testid 一个不动、导航 testid 全由 _shared 自带，页面只加 root 锚点，改造零侵入；③ 验证脚本 f-string 内嵌 `[data-testid="..."]` 双引号必 SyntaxError（T16 同坑），count 先取变量再 `"count=%d" % item_cnt` 拼接。

## T18 群聊核心页改造：深色 Sidebar → 融合导航（复用 _shared/nav）（2026-08-06）

- **交付**：改造 `prototypes/group-chat/index.tsx`（meta.id=group-chat 不变，device 保留 both）。**移除 `../_shared/components` 的 Sidebar 引用**，改用 `../_shared/nav` 的 `NavDock` + `NavTopBar` + `CmdKPanel`（T17 API 直接落地），未改 _shared / 其它原型 / 引入第三方库。
- **桌面结构（对齐 T16 nav-hybrid 三层 + 原三栏）**：root `data-testid="group-chat-root"`（height:100% + position:relative）→ `NavTopBar breadcrumb={["Agent 协作平台", "T-1041 通知中心迭代"]}`（文档流顶部 60px）→ 内容区 `position:absolute; top:60; left/right/bottom:0; display:flex; paddingLeft: RAIL_W+24(=80)` 内三栏：`MembersPanel`(196px, 4×member-item) | 消息区（ChatHeader 64px + chat-message-list + mention-hint + MessageInput） | `TaskPanel`(268px, 3×artifact-link + view-session-link)。→ `NavDock activeKey="messages"`（absolute 左缘垂直居中，z-50）→ `CmdKPanel`（open 默认 true，absolute inset:0 z-40，Dock 浮于遮罩上两者共存）。
- **保留项（7 个原 testid 全在）**：chat-message-list / member-item=4 / message-input / task-info-panel / view-session-link / chat-bubble=7 / mention-hint；@触发 mock 消息流 7 条原样（system/user/agent 三型 + 单 @/互 @/@all）+ 产出物 3 项。**新增 testid**：rail-bar（NavDock 自带）/ topbar+cmdk-trigger（NavTopBar 自带）/ cmdk-panel（CmdKPanel 自带）——组件自带，页面零额外 testid 代码。
- **mobile 分支**：06 文档「桌面 / 移动」适配形态需保留 device:"both"；移动分支原样（ChatHeader+MessageList+MentionHint+MessageInput，本就无 Sidebar），仅把注释里的「深色 Sidebar」描述更新。
- **两个 header 并存是已确认方案**：NavTopBar（面包屑带任务编号 T-1041）+ ChatHeader（纯任务标题+StatusBadge+头像堆叠）叠放视觉不冲突，与 T16 nav-hybrid 一致，不要自作主张删 ChatHeader。
- **验证（playwright 20/20 PASS）**：11 个 testid 存在 + chat-bubble=7(≥5) + member-item=4 + dock active（rail-icon/nav-item 各 1，activeKey="messages"）+ cmdk-item=6 + rail-bar/cmdk-trigger/cmdk-panel boundingBox 均在 group-chat-root 内（±1px）+ 计算样式 fixed 元素=0（grep 源码仅注释含 fixed 字样）+ console 0 error。截图 `.omo/evidence/group-chat-new.png`（204KB 非空）。复刻 T14 教训：goto 后必须 `wait_for_selector('[data-testid="rail-bar"]')` 轮询再断言，否则 hash 路由渲染延迟会读到 0。

## T19 CmdKPanel 受控开关：open 默认 false + onClose（2026-08-06）

- **交付**：改造 `prototypes/_shared/nav.tsx`（唯一文件），CmdKPanel 从"默认弹出且无法关闭"升级为受控开关，未改 NavDock/NavTopBar API 与 data-testid，未改其他 _shared 与其他原型。
- **新 API（供 7 页面接线任务引用）**：`CmdKPanel({ open=false, onClose?, items?, onSelect?, children?, style?, className? })`——`open` 默认 **false**（默认关闭，不再默认弹出）；新增 `onClose?: () => void`。**接线范式**：页面 `const [open, setOpen] = useState(false)` → `NavTopBar onCmdKClick={() => setOpen(true)}`（已有 prop 不变）→ `CmdKPanel open={open} onClose={() => setOpen(false)}`。保留 testid：cmdk-panel/cmdk-search/cmdk-item（不变）+ 新增 cmdk-close。
- **关闭三件套**：① 右上 ✕ 按钮（data-testid=`cmdk-close`，搜索行 flex 末尾、ESC 徽标右侧，圆形 26px hover 背景 neutral[100] 走 `.navcmdk-close` class——hover 必须注入 panelCss style 标签，inline style 写不了 :hover）；② 遮罩点击（`.navcmdk-mask` 加 `onClick={onClose}`）；③ Esc 键（`useEffect` 里 `if (!open || !onClose) return` 挂 keydown，`e.key === "Escape"` 触发，清理函数 removeEventListener，deps [open, onClose]——open 才挂、卸载/关闭即清）。
- **⚠️ hooks 规则**：Esc 的 `useEffect` 必须放在 `if (!open) return null` **之前**（组件顶层先调 hook 再条件返回），否则 React 报 Hooks 顺序错。
- **验证（playwright 13/13 PASS）**：临时 `_cmdkprobe` 冒烟（useState 受控 + NavTopBar onCmdKClick + CmdKPanel open/onClose + panel-state 状态文本作 DOM 断言）：初始 cmdk-panel count=0 → 点 trigger 出现（cmdk-item=6）→ 点 cmdk-close 消失 → 重开点遮罩消失 → 重开 Esc 消失 → console 0 error。截图 `.omo/evidence/cmdk-toggle.png`（126KB 非空，打开态）。验证后已删除 _cmdkprobe。
- **经验**：① 原型默认导出必须是 `{ meta, Component } satisfies PrototypeDef`（`export const meta` + `export default function Component` 会因渲染层读 def.id 报 `Cannot read properties of undefined (reading 'id')`，body 空白）；② 遮罩点击用 `.navcmdk-mask` boundingBox 左边缘 (x+10, 中部) 真实鼠标点击，避开居中的 600px 面板与 Dock；③ `import { useEffect } from "react"` 是值导入，需与 `import type { ... }` 分两行。
- **⚠️ 行为变更提醒**：7 个既有页面（project-list/task-create/task-board/group-chat/dm-chat/task-detail/agent-config）目前 `CmdKPanel` **未传 open**，升级后默认 false → 面板默认不再弹出（正是用户诉求）。后续接线任务需给每页补 useState + onCmdKClick + onClose。

## T19 dm-chat 接线 Cmd+K 受控开关（2026-08-06）

- **交付**：改造 `prototypes/dm-chat/index.tsx`（唯一文件），接入 T19 CmdKPanel 新 API（open 默认 false + onClose），未改 _shared/nav.tsx 与其他原型，未引第三方库。
- **接线范式（T19 落地首例）**：`import { useState } from "react"`（值导入与 `import type` 分两行）→ 组件顶层 `const [cmdkOpen, setCmdkOpen] = useState(false)`（默认关闭）→ `NavTopBar title="私聊" subtitle="..." onCmdKClick={() => setCmdkOpen(true)}` → `CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)}`。关闭三件套（✕ / 遮罩 / Esc）由 CmdKPanel 内置，页面零实现。
- **既有 testid 全保留**：dm-agent-info / chat-bubble=3 / view-session-link / message-input 不动；导航 testid（rail-bar / topbar / cmdk-trigger / cmdk-panel）由共享组件自带；页面仅加 dm-chat-root 锚点。顶部模块注释同步更新为受控开关描述。
- **验证（playwright 16/16 PASS）**：初始 cmdk-panel count=0（默认关闭，核心回归）→ 点 trigger 出现（cmdk-item=6 + cmdk-close=1，打开态截图）→ 点 cmdk-close 消失 → 重开点遮罩消失 → 重开 Esc 消失 → 最终再开可重现（非一次性）→ console 0 error。截图 `.omo/evidence/dm-chat-cmdk.png`（164KB 非空）。
- **⚠️ 遮罩点击坐标坑（本页特有）**：`cmdk-panel` 容器 boundingBox 左缘 + 垂直中部 (x+12, y+h/2) 点击会被 **NavDock 拦截**——Dock `left:12px; top:50% translateY(-50%)` 恰好覆盖该点且 z-50 高于遮罩 z-40，onClose 不触发。**解法：点左缘偏上 (x+12, y+h*0.15)**，避开居中 600px 面板与垂直居中的 Dock；T19 _cmdkprobe 无 Dock 所以中部可行，有 Dock 页面须偏上。
- **经验**：① useState 必须组件顶层声明（hooks 规则），本次放在 return 前；② 接线只动页面，_shared 零改动——T19 API 设计（onCmdKClick 已有 prop 不变 + open/onClose 新增）使 7 页面接入成本恒定；③ 编译验证 `curl /@fs/.../index.tsx` 200 + grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 仅注释命中（T15 合规）。

## T19 task-detail 接线 Cmd+K 受控开关（2026-08-06）

- **交付**：改造 `prototypes/task-detail/index.tsx`（唯一文件），按 T19 新 API 接线受控开关，未改 _shared 与其他原型、未引第三方库。
- **接线点（参照 task-board 同款范式）**：① 顶层 `import { useState } from "react"`（值导入，与 `import type { CSSProperties }` 分行，T19 经验③）；② `TaskDetailPage` 顶层 `const [cmdkOpen, setCmdkOpen] = useState(false)`（默认关闭）；③ `NavTopBar title="任务详情" subtitle="T-1042 · 智能报表模块开发" onCmdKClick={() => setCmdkOpen(true)}`；④ `CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)}`（items 走默认 6 条，本页不自定义，与 T18 原状一致）。文件头注释同步改为「CmdKPanel（受控开关）」。业务 mock/testid 全部未动。
- **验证（playwright 17/17 PASS）**：业务 4 testid（artifact-item=3 / artifact-viewer / task-info-header / artifact-tab）+ 导航 4 testid（rail-bar/topbar/cmdk-trigger）+ 初始 cmdk-panel count=0 → 点 trigger 打开（cmdk-panel=1 + cmdk-item=6 + cmdk-close=1）→ ✕ 关闭 → 重开点遮罩（mask 左缘 x+10，避开居中面板与 Dock）关闭 → 重开 Esc 关闭 → console 0 error。截图 `.omo/evidence/task-detail-cmdk.png`（155KB 非空，打开态）。
- **经验**：T19 接线四件套（useState(false) + onCmdKClick + open/onClose）完全可复用 task-board 验证脚本模板（URL/截图路径/testid 列表替换即可），本次复用零改动即 17/17 通过，验证脚本 `/tmp/opencode/task-detail-cmdk-verify.py`。

## T19 task-board 接线 Cmd+K 受控开关（2026-08-06）

- **交付**：改造 `prototypes/task-board/index.tsx`（唯一文件），落实 T19 新 API 接线——Cmd+K 面板从"默认弹出无法关闭"变为"默认关闭、可开可关"，未改 _shared 与其他原型。
- **接线三件套**（T19 范式首个落地页）：① `import { useState } from "react"`（值导入与 `import type` 分两行）；② 组件顶层 `const [cmdkOpen, setCmdkOpen] = useState(false)`（默认关闭）；③ `NavTopBar onCmdKClick={() => setCmdkOpen(true)}`（原 NavTopBar props 不动，仅新增传参）→ `CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={cmdkItems}`（items 自定义保留）。同时更新文件头注释与面板行注释为"受控开关"语义。
- **验证（playwright 16/16 PASS）**：6 个保留 testid（status-filter/task-card/rail-bar/topbar/cmdk-trigger/cmdk-panel）+ task-card=4/status-filter-option=5 → **交互五步**：初始 cmdk-panel count=0 → 点 cmdk-trigger 出现（cmdk-item=6 + cmdk-close=1）→ 点 cmdk-close 消失 → 重开点遮罩（`.navcmdk-mask` boundingBox 左缘 x+10 避开居中面板与 Dock）消失 → 重开 Esc 消失 → 打开态截图 `.omo/evidence/task-board-cmdk.png`（165KB 非空）+ console 0 error。
- **经验**：① T19 接线零成本——页面只需 1 个 useState + 2 个 props，业务 testid 与布局全不动；② 初始态断言 count=0 必须在 `wait_for_selector('[data-testid="rail-bar"]')` 之后（T14 渲染竞态），否则 hash 路由未切完误判；③ 每次关闭后等 400ms 再断言（动画 160ms + React 卸载），遮罩/Esc/✕ 三路径共用此节奏；④ 验证脚本存 `/tmp/opencode/task-board-cmdk-verify.py` 可复用为后续 6 页面（project-list/task-create/group-chat/dm-chat/task-detail/agent-config）的接线验证模板。

## T20 task-create 接线 Cmd+K 受控开关：useState + onCmdKClick + open/onClose（2026-08-06）

- **交付**：改造 `prototypes/task-create/index.tsx`（唯一文件，首个按 T19 新 API 接线的业务页）。`import { useState } from "react"`（值导入与 `import type` 分两行，T19 经验③）→ `TaskCreatePage` 顶层 `const [cmdkOpen, setCmdkOpen] = useState(false)` → `NavTopBar onCmdKClick={() => setCmdkOpen(true)}` → `CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)}`。未改 _shared 与其他原型，未引第三方库。
- **行为变更落实**：面板由"默认弹出"（用户反馈痛点）→ **默认关闭**；打开方式只剩点击顶栏 cmdk-trigger；关闭三件套（✕/遮罩/Esc）由 CmdKPanel 内置 onClose 接管。头部注释同步更新（去掉"默认可见模拟 ⌘K 按下态"），保持文档与实现一致。
- **保留 testid 清单（13 个全命中）**：业务 task-title / task-description / priority-select / agent-option×4 / create-task-button + 导航 rail-bar / topbar / cmdk-trigger + 面板 cmdk-panel（组件自带）。
- **验证（playwright 15/15 PASS）**：初始 cmdk-panel count=0（默认关闭）→ 点 cmdk-trigger 面板出现（cmdk-item=6）→ 点 cmdk-close 消失 → 重开点遮罩（`.navcmdk-mask` boundingBox 左边缘 x+10 避开居中面板与 Dock）消失 → 重开 Esc 消失 → console 0 error。截图 `.omo/evidence/task-create-cmdk.png`（155KB 非空，打开态）。
- **经验**：① T19 接线范式落地只需 3 处改动（useState + onCmdKClick + open/onClose），业务层零侵入；② 验证脚本沿用 T14 的 `wait_for_selector` 轮询 + f-string 用 `%` 拼接 testid 防 SyntaxError；③ 遮罩点击必须取 mask 的左边缘真实坐标，点中心会命中 600px 面板。
- **后续**：T19 记录的行为变更提醒——其余 6 页（project-list / task-board / group-chat / dm-chat / task-detail / agent-config）仍未传 open，需按本页同款 3 步接线，否则升级后默认关闭属预期行为（与用户诉求一致）。

## T20 group-chat 接线 Cmd+K 受控开关（2026-08-06）

- **交付**：改造 `prototypes/group-chat/index.tsx`（唯一文件，核心页同款 T19 接线）。`import { useState } from "react"`（值导入与 `import type` 分两行）→ `GroupChat` 顶层 `const [cmdkOpen, setCmdkOpen] = useState(false)` → `NavTopBar breadcrumb=… onCmdKClick={() => setCmdkOpen(true)}`（多行展开）→ `CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)}`。未改 _shared / 其他原型 / 未引第三方库。
- **⚠️ hooks 顺序（device 分支特例）**：group-chat 是 `device:"both"`，`useState` 必须放在 `if (isMobile) return …` **之前**（组件顶层先调 hook 再条件返回），否则 React Hooks 顺序错——与 T19 nav.tsx 的 `useEffect` 先于 `return null` 同理。
- **保留 testid 全命中（17 项）**：业务 chat-message-list / member-item=4 / message-input / task-info-panel / view-session-link / chat-bubble≥5 + 导航 rail-bar / topbar / cmdk-trigger + 面板 cmdk-panel / cmdk-item=6 / cmdk-close。
- **验证（playwright 17/17 PASS）**：初始 cmdk-panel=0（默认关闭）→ 点 cmdk-trigger 出现（cmdk-item=6）→ ✕ 关闭 → 重开遮罩点击关闭 → 重开 Esc 关闭 → console 0 error；打开态截图 `.omo/evidence/group-chat-cmdk.png`（256KB 非空）。T14 教训复刻：goto 后 `wait_for_selector('[data-testid="rail-bar"]')` 轮询再断言。
- **经验**：① T19 接线范式在核心页落地同样 3 处改动（useState + onCmdKClick + open/onClose），业务组件零侵入，验证脚本复用 T19 冒烟链路（trigger→✕→遮罩→Esc）；② 遮罩点击取 `.navcmdk-panel` boundingBox 左缘 x+10 避开居中面板与 Dock（与 T19 经验②等价）；③ T15 铁律 grep 仅命中注释说明（fixed/100vh/100vw 零代码违规）。

## T20 project-list 接线 Cmd+K 受控开关：open 默认 false + onClose（2026-08-06）

- **交付**：改造 `prototypes/project-list/index.tsx`（唯一文件），落实 T19 新 API 到业务页首例。`import { useState } from "react"`（值导入，与 `import type { CSSProperties }` 分行）+ 组件顶层 `const [cmdkOpen, setCmdkOpen] = useState(false)` → `NavTopBar onCmdKClick={() => setCmdkOpen(true)}`（既有 prop）→ `CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={cmdkItems}`（受控模式）。未改 _shared / 其他原型 / 引入第三方库。同步更新文件顶部注释（「默认可见」→「受控开关」）与 CmdKPanel 处注释。
- **接线范式（7 页面通用）**：`useState(false)` 默认关闭 → 点 ⌘K 触发框打开 → ✕/遮罩/Esc 三件套关闭（onClose 已由 T19 内置）。所有既有 testid（project-card / create-project-button / rail-bar / topbar / cmdk-trigger / cmdk-panel）零改动，全部由共享组件自带。
- **验证（playwright 16/16 PASS）**：既有 5 testid 保留（project-card=3 / create-project-button=1 / rail-bar / topbar / cmdk-trigger）+ 初始 cmdk-panel=0 / cmdk-close=0（默认关闭）+ 点 cmdk-trigger 面板出现（cmdk-item=6 / cmdk-close / cmdk-search）+ 点 cmdk-close 消失 + 重开点 `.navcmdk-mask` 遮罩（boundingBox 左缘 x+10 避开 600px 面板）消失 + 重开 Esc 消失 + console 0 error。截图 `.omo/evidence/project-list-cmdk.png`（184KB，1440×900 打开态）。
- **⚠️ md-docs 冷编译时序坑（新）**：首次访问某原型时 Vite 按需 transform，冷启动第一次跑验证会出现：① 部分静态资源 403（热缓存后消失）；② `count()` 读到 0 但 `click()` 却成功（auto-wait 兜底）→ 断言时序抖动。**解法**：脚本写完后**先跑一遍 warm-up**（同一脚本重跑）再判定结果，热缓存下稳定全绿；或 wait_for_selector 后加 `wait_for_timeout(1000)` 稳定窗口再断言。
- **经验**：① NavTopBar 的 cmdk-trigger 点击不跳路由（纯受控状态，onCmdKClick 只是 setState），无需 onSelect/路由处理；② CmdKPanel 关闭三件套（✕/遮罩/Esc）全由 T19 内置，页面只传 open/onClose 两 prop 即可，业务页零新增关闭逻辑。

## T19 agent-config 接线 Cmd+K 受控开关（2026-08-06）

- **交付**：改造 `prototypes/agent-config/index.tsx`（唯一文件），落实 T19 新 API（与 project-list 同范式）。`import { useState } from "react"`（值导入，与 `import type { CSSProperties }` 分行）+ 组件顶层 `const [cmdkOpen, setCmdkOpen] = useState(false)` → `NavTopBar onCmdKClick={() => setCmdkOpen(true)}`（既有 prop）→ `CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS}`（受控模式）。未改 _shared / 其他原型 / 引入第三方库。同步更新文件顶部注释（「默认可见，模拟 ⌘K 状态」→「受控开关，初始关闭」）与 CmdKPanel 处注释。
- **接线范式（7 页面通用）**：`useState(false)` 默认关闭 → 点 ⌘K 触发框打开 → ✕/遮罩/Esc 三件套关闭（onClose 已由 T19 内置）。所有既有 testid（agent-list-item=5 / prompt-editor / permission-config / clone-template-button / skill-list / rail-bar / topbar / cmdk-trigger / cmdk-panel）零改动，全部由共享组件自带。
- **验证（playwright 16/16 PASS）**：既有 9 testid 保留 + 初始 cmdk-panel=0（默认关闭）+ 点 cmdk-trigger 面板出现（cmdk-item=6）+ 点 cmdk-close（✕）消失 + 重开点 `.navcmdk-mask` 遮罩消失 + 重开 Esc 消失 + console 0 error。截图 `.omo/evidence/agent-config-cmdk.png`（276KB，1440×900 打开态）。
- **⚠️ 遮罩点击三坑**：① mask 是 `position:absolute; inset:0` 全幅，600px 面板（`position:relative` DOM 靠后）叠在其上 → **点 mask 中心会被面板元素拦截**（playwright 报 "intercepts pointer events"），必须点面板外区域；② `page.mouse.click(固定页面坐标)` 不可靠——原型渲染在 DeviceFrame 容器内非视口原点，坐标会偏；**正确解法**：`page.locator(".navcmdk-mask").click(position={"x": 15, "y": 15})`（locator position 参数由 playwright 自动计算真实命中点，命中 mask 左上角面板外区域）。
- **经验**：agent-config 的 CMDK_ITEMS 自定义 6 条（导航 ▤☰◉ + 操作 ⧉✎⚙）在受控模式下原样透传，open/onClose 只控制显隐不影响 items；关闭三件套零页面逻辑，业务页只需 open/onClose 两 prop。

## T19 PRD 01-05 篇嵌入原型块，文档与原型呼应（2026-08-06）

- **交付**：在 01~05 篇语义对应位置插入 ```prototype 内嵌块（引导语 + 块 + 收尾说明），06 篇不动。分布：01 产品定位末尾 group-chat×1；02 场景步骤 1 后 task-create / 步骤 2 后 group-chat / 步骤 6 后 task-detail（各 ×1，title 语义化：任务创建-组建虚拟团队 / 任务群聊（@ 触发协作）/ 任务详情与文档库）；03 任务管理末尾 task-create+task-board、群聊协作末尾 group-chat+dm-chat（各 ×2）；04 Agent 管理末尾 agent-config、任务文档库末尾 task-detail（各 ×1）；05 3.1 交付范围表后 prototype-list + 8 个原型块。
- **⚠️ prototype-list 实现语义（本次踩坑）**：md-docs 的 ```prototype-list 渲染「本文档引用原型（N）」，N 来自**本文档自己**的 parsed.embeds 去重（DocMarkdown.tsx `PrototypeList` 组件），**不是项目全部原型**。05 篇若只放 prototype-list 而本篇无 embed，会显示（0）+ 空链接区。要让总览列出全部 8 个，必须**在本篇同时嵌入 8 个原型块**，list 标签才会显示「本文档引用原型（8）」。技能文档说"按当前项目解析"与实际实现（按本文档引用）有出入。
- **原型块语法**：3 反引号围栏 ` ```prototype `，内部 `id: <meta.id>` 必填 + 可选 `title/device/height`（height 默认 640，建议 560）；缺 id 会被原样保留为代码块（便于排查）。parser.ts 只识别恰好 3 反引号，4+ 反引号保留为展示示例。
- **内嵌渲染 DOM**：PrototypeEmbed 渲染 `div.my-4.overflow-hidden.rounded-lg.border.border-slate-200.bg-white.shadow-sm` 容器（含标题/PC-移动切换/全屏/跳转 4 元素）+ `<def.Component>` 直接渲染（**无 iframe**，原型 testid 直接在文档 DOM 中可断言）；auto 缩放 scale=min(1, 容器宽/1280)。
- **验证（playwright 29/29 PASS）**：5 篇直达 URL `#/p/agent-platform/docs/<英文id>`，断言 ① 内嵌容器计数精确（1/3/4/2/8）② 每个原型标题文本在 body ③ 每原型特有 testid 命中（group-chat→chat-message-list、task-create→task-title、task-board→status-filter、dm-chat→dm-agent-info、task-detail→artifact-viewer、agent-config→prompt-editor、login→username、project-list→project-card）④ 05 篇 list 标签含 8 ⑤ console/pageerror=0。截图 `.omo/evidence/prd-prototypes-embedded.png`（275KB 非空，01 篇含 group-chat 内嵌）。
- **通用经验**：① 文档内嵌原型用 `wait_for_selector("div.my-4.overflow-hidden.rounded-lg")` 轮询就绪（hash 路由有延迟，T14 同坑）；② 同一原型多次嵌入（03 篇 task-create 在 02/03 篇各出现）标题需差异化避免混淆；③ 引导语保持"界面效果见下方原型预览：」句式 + 块后一句收尾呼应 FR/步骤编号，段落衔接自然。

## T21 修复嵌入原型高度过小：minHeight:720（2026-08-06）

- **Bug 根因**：md-docs PrototypeEmbed 用 ResizeObserver 测 protoRef 内容高度（rawHeight），父容器 height:auto 时原型 root `height:100%` 无法解析（父无确定高度），内部 `position:absolute`（top:60/bottom:0）内容区不撑开 → rawHeight≈195，scaledHeight≈134，嵌入区"只有两个手指宽"。修复前实测 6 篇文档嵌入区均为 ~134px。
- **修复方案**（原型层，不动 md-docs 源码）：给 8 个业务原型 root 容器 style 加 `minHeight: 720`（保留 `height:"100%"` + `position:relative`）：project-list / task-create / task-board / group-chat（desktop root + mobile 分支两处）/ dm-chat / task-detail / agent-config / login（root 原是 `minHeight:"100%"` → 改 `minHeight:720`）+ nav-hybrid（可选，一并加保持一致）。
- **修复方案**（文档层）：6 篇 PRD 全部 ```prototype 块 `height: 520/560/600` → `height: 720`（26 处），让 maxHeight 不截断、完整显示（effectiveHeight = min(rawHeight, maxHeight)，rawHeight=720 与 maxHeight=720 齐平）。
- **为什么 DeviceFrame 不受影响**：独立原型视图容器固定 800px 高，root `height:100%` 解析为 800 > minHeight 720 → minHeight 不触发；只有嵌入（父 auto）时 minHeight 生效撑开。桌面 1280px 容器内 scale≈0.686（878/1280），scaledHeight = 720×0.686 ≈ 494px。
- **验证（playwright 8/8 PASS）**：6 篇文档直达 URL 断言 `div.absolute.top-0.overflow-y-auto`（protoRef）getBoundingClientRect height：修复前 134px → 修复后 **494px**（≥400 达标），scrollHeight=720 确认 minHeight 生效；独立视图 /protos/group-chat（root 800px、chat-bubble=7、rail-bar/cmdk-trigger）与 /protos/task-board（root 800px、task-card=4、status-filter）完整不受影响。截图 `.omo/evidence/embed-height-fixed.png`（237KB，req-task-chat 文档嵌入态）。
- **通用经验**：① 嵌入高度问题的本质是"height:100% + absolute 布局在 auto 高度父容器中塌缩"，根因在原型 root 而非 md-docs；minHeight 是零侵入修复（不影响 DeviceFrame）；② 文档 prototype 块 height 参数是 maxHeight 而非固定高度，内容不足自适应、超出内部滚动；③ 验证嵌入高度直接量 protoRef（className 含 `absolute top-0 overflow-y-auto`）的 boundingBox，holder 容器（protoRef.parentElement）高度一致（±1px）。

## 02篇按新增需求更新：文档上传/待开始/主 agent/Loading与错误反馈/默认模型（2026-08-06）

- **交付**：`docs/agent-platform/02-用户与场景.md`（唯一文件，未动 01/03/04/05/06 篇）。新增 4 条用户故事 US-09~12（编号接 US-08）：US-09 上传任务背景文档（创建任务时上传资料入任务文档库供 Agent 查看）/ US-10 待开始与人工启动（创建后「待开始」→ 成员确认团队手动触发；未选 agent 先选；多 agent 指定主 Agent 负责人，启动消息发给主 Agent；简单任务单开发 agent 免主 Agent）/ US-11 Loading 与错误反馈（处理中 Loading；模型繁忙/余额不足/超时错误反馈入消息，可重试）/ US-12 配置默认模型（创建/编辑 agent 可选默认模型，列表来自 opencode）。
- **场景补充（保持 6 步骤骨架，插入式不重排）**：步骤 1 加入上传需求文档背景资料 + 创建后待开始；新增「步骤 1.5 确认 Agent 团队，触发开始」（小陈核对待开始任务、指定产品经理为主 Agent、点「开始任务」→ 进行中、启动消息发主 Agent）；步骤 2 加入 Loading 提示 + 一次「模型繁忙」错误重试；场景要点小结新增「启动可控」条。
- **术语统一**：待开始 / 主 Agent / 文档上传（含"上传需求文档、上传背景资料"近义表述）/ Loading / 错误反馈 / 默认模型，与用户需求措辞逐词对齐。
- **⚠️ 与 03/04 篇 FR 的呼应边界**：任务要求"与 03/04 篇新增 FR 呼应"但 MUST NOT DO 禁止改 03/04 篇——02 篇只做用户故事与场景层面的自洽描述（状态机扩展「待开始」仅在 02 篇叙述，不虚构 03/04 篇尚无的 FR 编号；已有 FR 引用体系不动），FR 层同步留待评审阶段。
- **验证方式（7/7 PASS）**：`curl http://localhost:5177/@id/__x00__virtual:md-docs-content | grep '"/docs/agent-platform/02-用户与场景.md"'` 命中（md-docs 热加载即时生效）；本地 grep 断言 US-01~12 连续（12 个）、US-09~12 各 1 次、待开始 8 / 主 agent 5（grep -i，正文用「主 Agent」）/ 文档上传语义 3 / 错误反馈 5 / 默认模型 3 / Loading 4 / 重试 4 / 步骤 1.5 出现 2 / As a·I want to·So that 行 36。证据存 `.omo/evidence/update-02-users.txt`。
- **经验**：① 断言"主 agent"小写关键词时正文可用「主 Agent」（中文语境大写），验证用 `grep -ci` 不区分大小写即可；② US 编号断言正则要写 `US-[0-9][0-9]*`，`US-0[0-9]` 匹配不到 US-10/11/12（两位数编号第二位非 0）；③ 文档中新增小节的插入式更新比全局重排风险低，保持既有 6 步骤编号骨架、以「1.5」插入过渡，避免破坏 06 篇交互文档对该场景的引用结构。

## T22 04 篇新增默认模型与主 agent 定位（2026-08-06）

- **交付**：更新 `docs/agent-platform/04-功能需求-Agent与产出物.md`（唯一文件，01/02/03/05/06 未动），按用户新增需求扩展 Agent 管理部分。
- **改动点**：① FR-30 预置角色模板补"默认模型"并新增「模板|定位|默认模型建议」表（产品经理=通用对话模型/架构师=推理模型/开发者=代码能力突出的通用模型/测试=推理模型，产品视角不写型号）；② 新增主 agent 衔接段——预置模板中产品经理（或自定义的项目经理）可作为任务主 agent（负责人），定义详见 03 篇，本篇只说明定位（普通 Agent 一员，配置统一维护）；③ FR-31 克隆副本调整项补"默认模型"；④ 1.2 配置项四项→五项，FR-36 后新增 **FR-47 默认模型配置（P0）**：创建/编辑 Agent 可设默认模型，模型列表由底层引擎（opencode）接口动态获取，标注技术愿景级不展开 API；⑤ 原型收尾说明同步"四块→五块，FR-33~36、FR-47 对应"。
- **验证**：content 注入端点命中 04 key；本地 grep 关键词 默认模型=7/模型列表=1/opencode=2/主 agent=1 全 PASS；FR 编号连续性核验 `seq 30 47` 无缺；模型建议表 4 行就位。证据存 `.omo/evidence/update-04-agent.txt`。
- **经验**：① 配置项清单这类"N 项"表述是联动改点，全文 grep `四项|四块` 逐一更新（本次 3 处：FR-30 描述/1.2 开头/原型收尾，另 1 处"预置模板、克隆与自定义、四项配置"引导语）；② 主 agent 概念由 03 篇定义、04 篇只做定位衔接，跨篇引用用"详见 03 篇"锚定避免重复定义；③ 模型建议表保持产品视角：用能力类描述（通用对话/推理）而非具体型号，符合 T3 起"技术底座愿景级不展开"约束。

## 更新 03 篇：任务管理与群聊协作新增需求（2026-08-06）

- **交付**：`docs/agent-platform/03-功能需求-任务与群聊协作.md` 按用户新增需求更新（仅改 03 篇，01/02/04/05/06 不动）。证据 `.omo/evidence/update-03-collab.txt`。
- **FR 增量（01→21，编号连续无缺号）**：FR-17 任务背景文档上传（P0，创建时上传多文件入文档库、参与 Agent 可见、@ 触发随 FR-12 注入）/ FR-18 任务启动流程（P0，创建后进「待开始」人工点「开始任务」；未选 Agent 先弹选择；启动时群聊系统消息 + 私信主 Agent；简单任务单开发 Agent 即可）/ FR-19 主 Agent 指定（P0，多选 Agent 须指定主 Agent，默认产品经理可改，作任务负责人）/ FR-20 Agent 处理 Loading 状态（P0，@ 后群聊气泡「思考中…/操作中…」指示器 + 成员面板/私聊「处理中」）/ FR-21 Agent 错误反馈（P0，模型繁忙/余额不足/超时以消息形式返回，群聊与私聊均可见，任务不阻塞可重发）。
- **状态机升级**：FR-03 由 4 状态改 5 状态——**待开始（新默认，创建后进入）→ 进行中（点击开始触发）→ 待验收 → 已完成 → 已归档**；「进行中」进入方式由「创建后默认进入」改为「成员点击「开始任务」触发（见 FR-18）」；看板段落同步改「五状态状态机」。
- **FR-03 表格改动注意**：保留原「进入方式」第三列，仅改首行（待开始）与第二行（进行中）进入方式，避免丢列。
- **新 FR 物理位置**：FR-17/18/19 插在任务管理域 FR-05 之后、原型预览之前（按主题聚类，编号不必与物理顺序同序，只需无缺号）；FR-20/21 插在实时性域 FR-16 之后。
- **编号策略**：新增 5 个 FR 全 P0，编号按任务指定 17/18/19/20/21；对应 US 用「US-01（补充）/US-07（补充）」标注既有故事延伸。
- **实时性导语衔接**：实时性章首段补一句「处理期间以 Loading 状态提示进展（FR-20），异常时以消息形式反馈（FR-21）」，让新增 FR 与既有导语呼应。
- **验证**：内容注入端点 grep 03 key = 1（热加载即时生效）；本地 grep FR 数 21 / 关键词 5 项（待开始/主 Agent/文档上传/Loading/错误反馈）全命中。注意 06 篇仍写四状态与「任务创建后进入进行中」，本次明确不改 06 篇，后续评审若需对齐再统一。

## agent-config 新增默认模型配置区（FR-47）（2026-08-06）

- **交付**：改造 `prototypes/agent-config/index.tsx`（唯一文件），配置面板四块 → **五块**（①提示词 ②默认模型 ③技能 ④工具 ⑤权限范围），对齐 PRD 04 篇 FR-47 与 T22 的「配置项五项」。未改 _shared / 其他原型 / 未引第三方库。
- **数据层**：`AgentInfo` 新增 `defaultModel: string` 字段；新增 `modelPool`（4 项产品视角模型：通用对话模型/推理模型/代码模型/快速模型）+ `modelNotes`（每模型一句说明）。模板建议映射：产品经理=通用对话模型 / 架构师=推理模型 / 开发者=代码模型 / 测试=推理模型；自定义「发布管家」（克隆自开发者）继承代码模型。
- **配置区结构**（插在 prompt-editor 之后、skill-list 之前）：`data-testid="model-config"` 容器（标题「默认模型」+ FR-47 标注）→ 内容卡（左：◉ 强调色图标 + 「当前」+ 模型名 + 说明；右：原生 `select` data-testid=`model-select`，defaultValue=agent.defaultModel 静态选中，4 个 option，width 176）→ 底部 `data-testid="model-source-hint"` 提示行「↗ 模型列表来自 opencode 接口动态获取」。
- **列表项联动展示**：`AgentListItem` 在 skills chips 之后新增「默认模型 <theme 色 pill>」徽标（theme.color/bg/border 取角色色，自定义取灰），5 个列表项各显示自己的建议模型。
- **验证（playwright 21/21 PASS，首跑即全绿）**：model-config=1 / model-select=1 且 option=4（≥3）/ model-source-hint=1 且文案含 opencode+动态获取 / input_value=通用对话模型（产品经理默认）/ agent-list-item=5（≥4）/ 全部列表项含「默认模型」徽标 / prompt-editor+skill-list+permission-config+clone-template-button+rail-bar+topbar+cmdk-trigger 全保留 / cmdk-panel 初始关闭（T20 受控开关未回归）/ console 0 error。截图 `.omo/evidence/agent-config-model.png`（226KB 非空）。@fs 编译 200 + grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 仅注释命中（T15 合规）。
- **经验**：① 配置面板"N 块"表述是联动改点——本次改原型注释（四类配置项→五类）与块编号 ②③④→③④⑤，与 T22 的 04 篇「四块→五块」文档改动保持一致性；② 原生 select 静态选中用 `defaultValue`（非受控，纯展示不联动，符合 MUST NOT「不要求联动」）；③ model-source-hint 用独立 testid 承载来源标注文案，与 FR-47 标题行标注解耦，方便断言；④ 验证脚本 `/tmp/opencode/agent-config-model-verify.py` 复用 T14 wait_for_selector + T20 冷编译 warm-up 教训。

## task-board 状态机 5 态：待开始 + 开始任务交互（2026-08-06）

- **交付**：`prototypes/task-board/index.tsx`（唯一文件，未改 _shared / 其他原型 / 引入第三方库）。状态机 4 态 → 5 态（PRD 03 FR-03 已更新）：**待开始 → 进行中 → 待验收 → 已完成 → 已归档**，对齐 FR-18（任务启动流程）/ FR-19（主 Agent 指定）。
- **改动点**：① 页面内本地定义 `type BoardStatus = StatusKey | "待开始"` + `WAITING_STATUS`（灰蓝 #475569 系：color #475569 / bg #F8FAFC / border #CBD5E1，与已归档灰 #64748B 区分）+ `WaitingBadge` 组件（仿 StatusBadge 视觉，保留 data-testid=status-badge + data-status=待开始）；统一出口 `renderStatusBadge(status)`：「待开始」走本地 WaitingBadge，其余走共享 StatusBadge——TaskCard 头部与 NavDock 状态统计两处共用。② filters 5→6 项（全部/待开始/进行中/待验收/已完成/已归档，待开始在最前）；statusStats 初始值补 `"待开始": 0`，类型 `Record<StatusKey>` → `Record<BoardStatus>`。③ mock 新增 T-1044「通知中心迭代」（待开始，members 产品/架构/开发 3 Agent——呼应多 Agent 需指定主 Agent 场景），任务总数 4→5，5 状态全覆盖。④ TaskCard 内 `useState(hintOpen)`（仅待开始卡片渲染 start-task-button + 点击展开 start-task-hint：开始前检查——未选 Agent 先弹选择 / 多 Agent 指定主 Agent（默认产品经理）），再点收起。
- **⚠️ 为什么不动 _shared（最小改动评估）**：StatusBadge 的 `status: StatusKey` 类型不含「待开始」，方案 b（扩 styles.ts 的 StatusKey/statusColors + 同步 StatusBadge）会改动共享层、波及全部 7 页面复用面；方案 a（页面内本地 WaitingBadge + 统一渲染出口）零侵入 _shared，仅页面内 ~40 行，是任务要求的"优先不动 _shared"路线。WaitingBadge 保留 status-badge testid 使断言（badge[data-status=待开始]=2：卡片 1 + Dock 统计 1）与其他状态一致。
- **验证（playwright 12/12 PASS）**：源码 grep 无 fixed/100vh/100vw 代码（仅注释铁律说明）；status-filter-option=6 且顺序精确 ['all','待开始','进行中','待验收','已完成','已归档']；task-card=5 ≥4 且待开始=1；status-badge[data-status=待开始]=2；start-task-button=1；hint 初始隐藏 → 点击出现（含"未选择 Agent / 主 Agent"文案）→ 再点收起 → 打开态截图 `.omo/evidence/task-board-waiting.png`（178KB 非空）；console/pageerror 0。脚本 `/tmp/opencode/task-board-waiting-verify.py`。
- **经验**：① 「N 态状态机 + N+1 个筛选项」联动改点清单 = filters 数组 / statusStats 初始值 / reduce 类型泛型 / 徽章渲染出口 / 文件头注释，5 处缺一不可；② 新增状态若走页面内本地徽章，必须提供统一渲染出口（renderStatusBadge）避免 TaskCard 与 NavDock 两处各写一份分支；③ hint 交互用 TaskCard 内局部 useState 即可（纯展示原型，无需提升状态到页面）。

## T23 task-create 新需求落地：文档上传 + 主 Agent + 待开始提示（2026-08-06）

- **交付**：改造 `prototypes/task-create/index.tsx`（唯一文件，未改 _shared / 其他原型，未引第三方库）。对应 PRD 03 篇新增 FR-17（背景文档上传）/ FR-18（创建后待开始）/ FR-19（主 Agent）。
- **文档上传区（FR-17）**：TaskForm 内任务描述之后、优先级之前插入 `data-testid="doc-upload"` —— 上传按钮 `doc-upload-btn`（`1.5px dashed neutral[300]` 虚线框 + neutral[50] 底 + ↑ 图标 + 「点击或拖拽上传背景文档」+ 支持格式说明）+ 3 个 `doc-file` 文件行（需求说明书.pdf 2.4MB / 历史工单数据.csv 1.2MB / 接口文档.docx 868KB，各含 34px 类型色块扩展名图标 + 文件名 + 大小 + ✕ 移除按钮示意）。**文件类型语义色**（pdf 红 #EF4444 / csv 绿 #10B981 / docx 蓝 #3B82F6）本地收敛为 `docTypeColors` 常量并注释"独立于角色/状态色避免语义混淆"——不改 _shared 前提下的页面内 token 扩展范式。
- **主 Agent（FR-19）**：`AgentOption` 加 `main?: boolean`，product 项 main=true；`AgentOptionCard` 加 `main` prop，角色名行右侧渲染 `data-testid="main-agent-tag"` 徽章（roles.product.color 角色蓝 #3B82F6 实底白字 pill、★ 主 Agent，fontSize.xs lineHeight 16px）。单选场景（main 缺失）自然不渲染徽章，静态 mock 即体现"多选带主标签 / 单选无标签"。AgentSelectPanel 副文案改为「勾选参与任务的角色，可多选。多选时需指定 **主 Agent** 作为任务负责人；简单任务可单选一个 Agent。」（任务要求说明文字逐字覆盖）。
- **待开始提示（FR-18）**：① 创建按钮下新增 `data-testid="create-hint"` 琥珀提示条（⏱ 任务进入「待开始」状态，确认团队后点击「开始任务」正式启动）——「待开始」为新状态未入 _shared statusColors，页面内定义 `pendingColor/pendingBg/pendingBorder` 局部常量（琥珀同族 #D97706/#FFFBEB/#FDE68A）并注释原因；② TaskForm 底部原 i 提示条文案「创建后任务将进入「进行中」」同步改为「任务创建后进入「待开始」状态…」——与新状态机（FR-03 五态）保持一致，避免文档/实现语义冲突。
- **验证（playwright 17/17 PASS）**：doc-upload=1 / doc-upload-btn=1 / doc-file=3（≥2）/ agent-option=4 / main-agent-tag=1 且落在 `[data-role="product"]` 卡片内 / create-hint=1 含「待开始」+「点击开始」/ 既有 4 testid（task-title/task-description/priority-select/create-task-button）全保留 / 主 Agent 说明文字命中 / console 0 error。`curl /@fs/.../task-create/index.tsx` 200；grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 仅命中注释铁律说明（T15 合规）。截图 `.omo/evidence/task-create-upload.png`（175KB 非空）。脚本 `/tmp/opencode/task-create-upload-verify.py`。
- **⚠️ JSX 断言坑**：`多选时需指定{" "}<span>主 Agent</span>{" "}作为任务负责人` 中 `{" "}` 在 span 边界渲染为空格，innerText 得到「指定 主 Agent 作为」——**含跨 span 的文案断言不要写整句连续字符串**，拆关键词（"主 Agent" + "作为任务负责人"）分别 in 判断，首次整句断言 FAIL（16/17）即此因。
- **经验**：① 新增状态「待开始」不在 _shared statusColors 四色内，遵循"扩展 token"原则在页面局部定义具名常量并注释"未入 _shared 原因"，比直接散落 hex 更可维护；② 文件类型图标用 34px 色块+扩展名文字即可表达语义，无需引入图标库（MUST NOT DO 约束内）；③ 静态原型里"多选/单选差异"用数据驱动（main 可选字段）表达，不写条件渲染逻辑分支。

## 更新 03 篇：消息模型扩展 + Loading/错误反馈细化（2026-08-06）

- **交付**：`docs/agent-platform/03-功能需求-任务与群聊协作.md`（唯一文件，01/02/04/05/06 不动）。按 opencode 真实消息机制研究（12 Part + 3 层错误 + SSE 事件）细化三处 FR。证据 `.omo/evidence/update-03-msgtypes.txt`。
- **FR-07 消息内容类型（Part）**：三类消息分类（用户/Agent 回复/系统）保留不变，新增小节一张表——展示型 5 类：正文 text（直接展示，synthetic/ignored 隐藏）/ 思考 reasoning（默认折叠不进群聊）/ 工具调用 tool（操作卡片三态：进行中/完成/失败，失败对接 FR-21 工具级）/ 文件 file（附件展示入文档库）/ 中断 aborted（「已中断」）；过滤型 4 类：step-start/step-finish、patch、snapshot、compaction 不直接渲染。每行标注「基于 opencode 消息机制的技术愿景」，产品视角不写 API 端点。
- **FR-20 Loading 两阶段**：思考中（对应 reasoning 片段进行中）/ 操作中（对应 tool 调用进行中）指示器表；群聊仅显示阶段指示器，详细过程走 FR-14 实时查看，FR-15 不广播约束不变；技术愿景标注"处理中≈底层会话忙碌状态"。
- **FR-21 三层错误模型**：①工具级=操作卡片内内联失败原因可自动重试；②消息级=8 种错误表（认证失败/模型服务错误[APIError 容器]/输出超长/用户中断/结构化失败/上下文超限/内容过滤/未知错误）×展示方式×是否可重试；③重试级=显示 attempt N + 等待时间。场景映射表：模型繁忙/限流/超时→可自动重试；余额不足→不自动重试需补充额度；用户中断→「已中断」非错误不计数不重试。
- **产品视角转化要点**：opencode 8 种判别（ProviderAuthError/UnknownError/MessageOutputLengthError/MessageAbortedError/StructuredOutputError/ContextOverflowError/ContentFilterError/APIError）→ 中文 8 种错误类型表，APIError 展开为「模型服务错误」并单列场景映射表；「是否可重试」列分三档（是-自动重试 / 否-需成员处理 / 视场景而定），直接回答"哪些错误显示为可重试、哪些需用户处理（如充值）"。
- **验证**：content 注入端点 grep 03 key=1（热加载即时生效）；本地 grep 关键词 10 项全命中（Part=2/reasoning=1/工具调用=3/余额不足=3/模型繁忙=4/重试=15/中断=4/技术愿景=3/八种=1/三层=2）；FR 编号 01~21 无缺号。
- **经验**：① 跨段引用锚点写法「对应消息内容类型中的思考片段进行中（见 FR-07）」保持 FR 体系自洽；② 错误表 8 行与场景映射表 5 行职责分离——错误表回答"是什么/能否重试"，映射表回答"具体场景下平台做什么/成员看到什么"，两层别合并成一长表；③ 新增小节均以「基于 opencode 消息机制的技术愿景」开头标注，满足"产品视角描述不写 API 细节"约束，也方便评审时定位哪些内容来自技术研究。

## T20 dm-chat 消息类型扩展：thinking/tool/error/loading（2026-08-06）

- **交付**：改造 `prototypes/dm-chat/index.tsx`（meta.id=dm-chat 不变），在保留原 3 条文本消息基础上扩展消息流，新增 4 个**页面内局部组件**（未改 _shared/components、_shared/nav、_shared/styles）：`MsgThinking`（msg-thinking）、`MsgTool`（msg-tool）、`MsgError`（msg-error）、`LoadingIndicator`（loading-indicator），对齐 opencode 真实消息体系（ReasoningPart / ToolPart 两态 / AssistantMessage.error / RetryPart）。
- **消息类型映射（产品 → opencode）**：thinking=ReasoningPart（灰斜体可折叠）；tool=ToolPart 生命周期（running→success 徽标）；error=AssistantMessage.error（模型繁忙=APIError isRetryable:true 琥珀可重试 / 余额不足=insufficient_quota isRetryable:false 红 + 升级引导按钮 msg-error-action）；loading=重试/处理中三点跳动画。mock 消息流：原 3 条 → 用户追问分组折叠 → thinking → tool(查询代码 running) → thinking → tool(分析日志 success) → agent 回复 → error(模型繁忙重试) → loading → agent 回复 → thinking → error(余额不足 fatal+升级配额)。
- **新增组件视觉约定（与 group-chat 后续改造共用规范）**：思考=灰斜体（neutral[500] italic + 左侧 2px 竖线，折叠 pill 头带 ◌ + ▸/▾）；工具=白卡 + 状态徽标（运行中=琥珀 spinner 动画 / 成功=绿 ✓，detail 用 fontFamily.mono 单行 ellipsis）；错误=琥珀（retry，复用 statusColors["待验收"]）/ 红（fatal，局部 errColors 常量 #DC2626/#FEF2F2/#FECACA）+ ⚠ 图标 + action pill（实底白字）；loading=白 pill 三点跳动动画。所有新组件左侧带 AgentAvatar sm（与 ChatBubble agent 侧视觉对齐）。
- **实现要点**：① 动画不能 inline style → 组件内 `<style>{dmAnimCss}</style>` 注入 keyframes（dm-spin / dm-dot），类名 `dm-` 前缀防污染（T16 经验复用）；② MsgThinking 用 useState 管理折叠（默认展开 data-open=true，点击 button 切换 aria-expanded，playwright 断言 data-open 翻转）；③ 错误语义色 errColors 为页面内局部常量（红系 styles.ts 无 token，琥珀复用 statusColors["待验收"] 同族色），不扩散到共享 token；④ 消息数据改为 union 类型 `DmMessage`（kind: text|thinking|tool|error|loading），DmMessageList 用 switch 分发渲染。
- **验证（playwright 32/32 PASS）**：新增 8 项（msg-thinking/msg-tool[running+success 两态]/msg-error[retry+fatal 两态]/loading-indicator/msg-error-action 升级引导/思考折叠交互）+ 既有 12 项 testid 全保留（chat-bubble=6≥3/dm-agent-info/view-session-link/message-input/rail-bar/topbar/cmdk-trigger/cmdk-panel=0 受控关闭/rail-icon=4/nav-item=4/active=1）+ 文案抽查（模型繁忙/余额不足/思考内容/工具名）+ 4 元素容器内边界 + console 0 error。截图 `.omo/evidence/dm-chat-types.png`（156KB 非空）。grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 仅注释命中。验证脚本 `/tmp/opencode/dm-chat-types-verify.py`。
- **⚠️ 经验**：① group-chat 同批扩展尚未完成，本次独立实现并沉淀「思考灰斜体/工具卡片带状态/错误红琥珀/loading 动画」视觉规范，后续 group-chat 扩展直接复用本页组件写法；② dm-chat 是 device:desktop + CmdKPanel 受控关闭（T19 已改默认 false），验证断言 `cmdk-panel` count=0 确认受控逻辑未被破坏；③ msg-tool/msg-error/msg-thinking 均带 agent 头像，形成"私聊 1 对 1 过程可见"的视觉锚点，与群聊"过程不广播"形成对照（FR-14/FR-15 语义）。

## group-chat 消息类型扩展：thinking/tool/error/aborted/loading（2026-08-06）

- **交付**：`prototypes/group-chat/index.tsx` 消息模型从 3 型扩展为覆盖 opencode 真实机制，原 7 条 @触发消息流与全部既有 data-testid 保留。
- **消息模型 union**：`MockMsg` 改为 discriminated union——基础三型（user/agent/system 走 ChatBubble）+ 5 类新消息：`thinking`(state: pending|done) / `tool`(status: running|success|failed, 含 input/output) / `error`(kind: retry|quota) / `aborted` / `loading`。MessageList 用 switch 分支渲染，default 走 ChatBubble。
- **新增局部组件（不改 _shared）**：MsgThinking（灰色虚线卡，pending=三连点 loading「思考中…」/ done=默认收起「已思考 · 点击展开」+ useState 可折叠展开）/ MsgTool（白卡：工具名 + ⚙/✕ 图标 + 状态 pill + 输入 mono 字体 + 输出；failed 时红边框 + ToolStateError 标注）/ MsgError（琥珀=模型繁忙 retry「RetryPart · attempt n/3」+ 重试中动画；红=余额不足 quota + 「查看升级方案 →」按钮，对应 APIError isRetryable:true/false）/ MsgAborted（灰 pill「▮▮ 已中断」+ 说明，MessageAbortedError ≠ 错误）/ LoadingIndicator（`data-testid=loading-indicator` 三连点 + label，模拟 session.status busy）。
- **语义色收敛**：错误色（琥珀 #B45309/#FFFBEB/#FDE68A、红 #B91C1C/#FEF2F2/#FECACA）与工具状态色收敛为页面内具名常量 errorTheme/toolStatus，不散落 magic number，也未改 _shared/styles（MUST DO 约束）。
- **scoped CSS 动画**：`<style>` 注入 `groupchat-` 前缀 keyframes（groupchat-bounce 三连点 / groupchat-pulse 成员面板"处理中"呼吸点），React 内联 style 标签合法（T17 nav.tsx 同款）。
- **⚠️ playwright 交互顺序坑**：CmdKPanel 受控打开后其 absolute inset:0 遮罩（z-40）会拦截对下方消息区元素的点击——先测消息区交互（thinking 折叠展开），再测 cmdk-trigger 开/关，否则 thinking 点击被遮罩 intercept。
- **⚠️ CmdKPanel 默认关闭是预期**：group-chat 的 `open={cmdkOpen}` 默认 false（T20 受控，learnings T16 层叠心智），`cmdk-panel` testid 默认 count=0，断言应为「默认 0 → 点 cmdk-trigger → 1」而非直接断言存在。
- **验证（playwright 36/36 PASS）**：msg-thinking=2（pending+done 各 1）/ msg-tool=3（running+success+failed 各 1，failed 含 ToolStateError 文案）/ msg-error=2（retry 含 attempt、quota 含升级按钮）/ msg-aborted=1 / loading-indicator=5（消息区 1 + 工具/错误/思考内联 4）/ chat-bubble=10（原 7 + 场景二 user×2 + agent×1）/ 既有 10 个 testid 全保留 / root position=relative / console 0 error / thinking 收起→点击展开交互 PASS。截图 `.omo/evidence/group-chat-types.png`（216KB 非空）。
- **复用经验**：① 群聊 mock 中 Agent 内部过程（thinking→tool→reply）作为「查看 Agent 会话」的可视化铺垫，符合 FR-14/FR-15（内部过程不广播、点击可查）；② 错误语义严格对齐 opencode 3 层错误模型：工具级 ToolStateError（tool 卡片内联红态）/ 消息级 error（retry/quota 两类）/ 重试级 RetryPart（attempt 提示）。

## T19 opencode v2 调研与架构决策（2026-08-06）

- **交付**：`docs/agent-platform/07-opencode-v2-调研与架构决策.md`，frontmatter `title/order/kind/description` + `id=opencode-v2-research`（英文 id 惯例延续），order=7、kind=技术调研。PRD 系列第 7 篇，技术基线文档。
- **结构**：① 决策（平台基于 opencode 2.x 实现，锁版本 + 定期同步）→ ② v2 定位与动机（引擎重写非功能迭代，三大痛点：热重载/单体臃肿/会话持久化，仅 3 个有意破坏变更）→ ③ v2 核心变更表（8 行：热重载/多包拆分/嵌入 SDK/Location/durable session/Effect/插件 v2/Question·Permission）→ ④ v2 API 与 v1 差异表（/api 前缀、location-scoped、PromptInput 替代 parts、GET /api/model、已移除端点）→ ⑤ 平台架构落地（Worker 概念=每任务组一个 opencode2 实例、agent 创建走 ctx.agent.transform/State.Transformable、多任务组=多 Location 图、消息模型=12 种 Part + 3 层错误）→ ⑥ 生态实测（cli@beta=0.0.0-beta-202608060524 每日发布 / sdk-next 未发布 / sdk v1=1.18.14）→ ⑦ 定期同步策略表 → ⑧ 风险与缓解表（beta 数据 wipe / 契约未冻结 / Desktop 捆绑 v1 / sharing·cluster 未实现）。
- **调研事实必须全部有出处**：所有结论来自两路调研（v2 源码结构 + 官方动机），文档不引入未确认信息；直接引用官方关键句（"In-process is only transport" / "Durable admission precedes execution" / "A caller cannot swap context..."）并标注说话人（Dax）。
- **技术调研篇与产品 PRD 篇的写法差异**：产品篇（01-06）禁写 API/代码细节，调研篇（07）可写具体技术名词（Location.Ref、PromptInput、HttpApi、Effect）但仍是调研级表述，不展开端点实现细节。
- **验证方式**：content 注入端点 grep `07-opencode-v2` 命中；本地关键词断言 7/7（Location/sdk-next/热重载/State.Transformable/beta/定期同步/opencode2）。证据存 `.omo/evidence/update-07-v2.md`。
- **复用点**：07 篇是完整平台开发的技术基线，后续技术设计（08 篇起）的 SDK 封装、Worker 调度、agent 插件注册均以本文档为锚点；风险表与 05 篇风险章节衔接。

## U07 OpenCodeDriver 抽象层落地（2026-08-06）

- **决策修订**：07 篇第 1 章原「基于 v2 实现」调整为落地化「v1 SDK 起步 + OpenCodeDriver 抽象 + v2 稳定后换 driver」；v2 方向不变，落地时点从开发基线改为迁移目标。与用户确认一致。
- **Driver 接口**：6 方法（createSession/sendMessage/listModels/getMessages/resolveRole/abortSession）；`resolveRole` 是版本差异最集中点（v1 system 注入 / v2 插件注册 agent + switchAgent），显式提为方法便于逐角色迁移。
- **双实现对比核心差异**：v1 路径无 /api 前缀 + parts 消息结构 + system 注入；v2 统一 /api + PromptInput{text,files,agents} + ctx.agent.transform 注册 + location-scoped + GET /api/model。
- **角色语义升级**：v1「提示词即角色」→ v2「agent 即角色」（可带技能/工具/权限，对齐 04 篇 FR-33~36）。
- **隔离演进**：v1 每任务组一个 server 进程 → v2 多 Location 图（Session 绑定创建时 Location，不能靠传 path 偷换上下文）；平台自担调度与隔离，呼应第 8 章 sharing/cluster 风险缓解。
- **v1 实测锚点（2026-08-06）**：@opencode-ai/sdk@1.18.14 安装/ESM 导入/创建会话/列 agent(16)/system 注入发消息/取消息历史 全链路通过，作为 V1Driver 事实依据。
- **迁移清单**：只动 V2Driver（加 /api 前缀、body 改 PromptInput、resolveRole 改插件注册、绑定 Location、模型切 GET /api/model）；业务层（任务/群聊/产出物/状态机）零改动，总量约 10-15%。
- **验证**：本地 grep 9/9 关键词 PASS；curl 5177 content 端点命中 07 key；md-docs build 退出码 0。证据 `.omo/evidence/update-07-driver.md`。

## U07b Worker 进程管理：v1 内嵌 vs 独立进程澄清（2026-08-06）

- **交付**：07 篇追加第 10 章（10.1~10.5），1-9 章未动。核心澄清用户误区：「集成 SDK 后平台是不是就是 worker、能否重启自己」。
- **核心事实（源码证据 /tmp/opencode-repo）**：`createOpencodeServer` = `launch("opencode", ["serve", ...], {env: {..., OPENCODE_CONFIG_CONTENT: JSON.stringify(config)}})` spawn 独立子进程（server.ts:22-100），返回 `{url, close()}`，close() 杀子进程 → 平台是父进程/管理者，不是 worker；「重启自己」= 杀子进程 + 重新 spawn。`createOpencode` 是 server+client 组合封装（index.ts:8-24），本质仍是 spawn，「进程内」是误读——v1 无完整 Scope 模型，进程内才真的无法销毁重建。`createOpencodeClient` 纯 HTTP 客户端（client.ts:33），不管理进程。v1 skill 启动时一次性 discoverSkills（InstanceState.make，skill/index.ts:173,259,273），无 watch 热加载。
- **v1 推荐**：每任务组 `createOpencodeServer` spawn 子进程，skill/tool 变更 = 写文件 → close() → 重 spawn → 启动发现；代价仅该任务组会话中断（隔离收益）。
- **v2 演进**：OpenCode.create() 用 Effect Scope，Scope 关闭即释放；ctx.skill/tool/agent.transform 运行时热更新免重启；OpenCodeDriver 接口不变，V2Driver 实现更优。
- **验证**：curl 5177 content 端点命中 opencode-v2-research=1；grep 7/7（createOpencodeServer=10/spawn=16/子进程=18/管理者=4/close()=10/Effect Scope=3/transform=11）；md-docs build 退出码 0。证据 `.omo/evidence/update-07-worker.md`。
- **经验**：① 澄清类章节要先破除命名误导（createOpencode 名字像进程内，源码实为组合封装+spawn）；② 表格中「进程内」风险要落到「v1 无 Scope 模型」这一根因，否则读者会以为只是重启成本问题；③ 与既有章节呼应（第 5 章 Worker 概念 / 第 9 章 OpenCodeDriver），结论收敛到 driver 封装层。

## T19 07 篇新增第 11 章分布式 Worker 架构（2026-08-06）

- **交付**：`docs/agent-platform/07-opencode-v2-调研与架构决策.md` 新增第 11 章（11.1 总体形态 / 11.2 Worker 注册协议 / 11.3 控制协议 / 11.4 生命周期管理 / 11.5 v2 迁移只动 Worker 侧 / 11.6 Worker 内部结构 / 11.7 与既有决策呼应），并修正与分布式冲突的第 5/9/10 章。只改 07 篇，01-06 篇与原型未动，frontmatter 未动。
- **核心架构决策（用户已确认）**：控制面（平台服务端：Web UI/任务/群聊/产出物/Agent 配置 + Worker 注册表/调度器/生命周期管理）与数据面（分布式 Worker 节点池）分离；worker 通过配置 `{serverUrl, workerId, 能力声明}` 主动 outbound 连接注册（`POST /api/workers/register` + 心跳 + `GET /api/workers` 可见），服务端管理生命周期与任务下发；v2 改造只动 worker 侧。
- **关键设计映射**：控制协议 = OpenCodeDriver 的**远程化**（WorkerRuntime 内部把 Driver 方法暴露为 worker HTTP 端点，进程内调用→HTTP 调用 + SSE 事件流）；服务端→worker：`POST /worker/{id}/instances`、`/sessions`、`/sessions/{sid}/prompt`、`/abort`、`DELETE /instances/{gid}`、`GET /models`；worker→服务端（SSE）：`instance.created / session.updated / message.part.delta / agent.status / task.completed / worker.heartbeat`。
- **冲突修正模式（可复用）**：不改原逻辑，用「> 引用块 + 加注」衔接——第 5 章 Worker 概念改"节点内实例+任务组隔离由节点承载"并注"完整形态见第 11 章"；第 9 章 9.1/9.2 开头加"分布式语境修正"（Driver→WorkerRuntime，接口定义不变）；第 10 章标题改"（单机形态）"+ 10.1~10.5 各节加"（单机形态；分布式演进见第 11 章）"。
- **v2 迁移面收敛**（用户核心诉求）：控制面零改动（注册表/调度器/生命周期/任务/群聊/归档/Agent 配置不变）；Worker 对外 HTTP 接口不变（协议层 v1/v2 无感知）；只动 WorkerRuntime 一层（V1Runtime spawn 子进程 → V2Runtime `OpenCode.create()` Effect Scope + `ctx.agent.transform` 热更新）。
- **Worker 节点三组件**：WorkerServer（HTTP 对外，协议层不变）/ WorkerRuntime（抽象，v2 只动这层）/ TaskGroupRegistry（gid→实例映射，支撑亲和与销毁）。
- **验证方式**：curl 注入端点命中 07 key + grep 断言（控制面/数据面/注册/心跳/WorkerRuntime/任务下发/分布式/11.5 全命中）+ 章节结构 grep（## 11 + 11.1~11.7）+ `npx md-docs build` EXIT:0。证据存 `.omo/evidence/update-07-distributed.md`。

## T19 07 篇立场统一：服务端（控制面）+ worker（数据面）模式（2026-08-06）

- **任务**：`docs/agent-platform/07-opencode-v2-调研与架构决策.md` 全文统一为「控制面管 worker、worker 节点承载 opencode」立场，删除一切"服务端/平台自己起 opencode 进程"表述。
- **改动面**：① 第 10 章整章重写（标题「Worker 进程管理：v1 内嵌 vs 独立进程（单机形态）」→「Worker 节点内部运行时（V1Runtime / V2Runtime）」），主语全部改为 worker 节点；② 9.1/9.2 引用块强化（V1Driver/V2Driver 在 worker 节点内部 = 11.6 WorkerRuntime，平台进程从不直接起/直连 opencode）；③ 9.5「平台为每个任务组启动独立 v1 server」→「每个任务组由 worker 节点承载一个 opencode 实例（节点内 spawn）」，注完整形态见第 11 章；④ 第 11 章引言与末段衔接修正。
- **保留的技术事实（主语改 worker 节点）**：createOpencodeServer spawn 语义 + server.ts 源码证据（launch + OPENCODE_CONFIG_CONTENT）、v1 三种承载方式对比（createOpencodeServer / createOpencode / createOpencodeClient）、skill/tool 变更流程（写 SKILL.md → 重启该节点实例）、v2 Effect Scope + ctx.agent.transform 热更新、v1/v2 运行单元对比表。
- **验证**：curl 注入命中 07 key；grep 正向（worker 节点 34 / 控制面 31 / V1Runtime 6 / V2Runtime 6 / Effect Scope 9）；grep 反断言（平台为每个任务组启动|平台进程是父|平台 spawn|平台按任务组|服务端 spawn|平台进程（管理者）等）= 0；md-docs build 退出码 0。证据存 `.omo/evidence/update-07-server-worker.md`。
- **经验**：① 立场统一类任务核心是「主语归位」——技术事实（spawn 语义、v1/v2 差异、变更流程）全保留，只把主语从「平台/服务端」换成「worker 节点」，正文引用的章节呼应（11.3/11.6/10.5 结论第 4 条）随之自洽；② 反断言 grep 用 `|` 连接多短语一次扫出残留，是立场一致性检查的最快手段；③ 重写整章时保留章节编号与结论条数（10.5 仍 4 条），避免下游章节（11.5「与第 10 章 10.5 结论第 4 条骨架一致」）引用失效。

## T19 Worker 管理原型：节点列表 + 安装向导（2026-08-06）

- **交付**：`prototypes/worker-list/index.tsx`（meta.id=worker-list）+ `prototypes/worker-install/index.tsx`（meta.id=worker-install），均 device=desktop、`satisfies PrototypeDef`，复用 `../_shared/nav`（NavDock/NavTopBar/CmdKPanel）+ `../_shared/styles` token，未改 _shared / 其他原型。
- **worker-list 结构**：状态统计条（data-testid=worker-stats，grid auto-fit minmax(180px,1fr)，4 张统计卡：在线/离线/维护中/总数，在线卡带 workerpulse-ring 呼吸动画）→「新增 Worker」按钮（add-worker-button）→ Worker 卡片网格（auto-fill minmax(300px,1fr)，4 张 worker-card，data-worker-id + data-status）。卡片字段严格对齐 07 篇 11.2/11.4：头部 workerId（mono 字体）+ WorkerStatusBadge（worker-status[data-status]，在线=绿#059669/维护=琥珀#D97706/离线=红#DC2626，色值与 statusColors 同族，页面局部常量因 _shared 不可改）→ 版本徽章（worker-version[data-v2]，v2.0.0-beta.1 用紫#7C3AED+「⬢ · V2Runtime」标注 / v1.18.14 灰）→ 能力区（worker-capability：并发上限 + skill/tool 数，两格 neutral[50] 底）→ 负载（worker-load：任务组数 + CPU 进度条，色随档位低绿#10B981/中琥珀#D97706/高红#DC2626）→ 心跳（worker-heartbeat[data-online]：脉冲点 + 相对时间 + 右侧 ♥ 活跃/失联）→ 操作（worker-actions：查看详情/重启/下线三按钮，离线/维护中 disabled 灰化，对应 11.4 POST /stop 优雅、/kill 强制与下线）。底部 worker-pool-hint 说明心跳超时标记离线 + 任务组重调度。
- **worker-install 结构**：NavTopBar 用 **breadcrumb 模式**（`["Worker 节点管理","新增 Worker"]`，此时 title/subtitle 被覆盖渲染 top-breadcrumb，T18 经验反向应用）；向导卡片（maxWidth 720 居中，install-wizard）三段式步骤编号（①②③ 圆形序号）：① 基础配置（install-config：server-url-input / worker-id-input + ↻ 重新生成按钮 / capability-config 并发上限 select + opencode 版本 select）② 安装方式 Tab（install-method-tab ×2 data-method=curl|docker data-active，pill 切换容器 neutral[100] 底、选中白底 shadow.sm）③ 命令展示（CommandBlock：install-command 深色 #0F172A mono 底 + $ 前缀 + copy-command-button ⧉ 复制）。底部 install-footer：install-confirm-button 完成安装 / install-cancel-button 取消 + 「注册即入池 · 无需重启控制面（11.4 水平扩容）」提示。
- **受控联动（本任务亮点）**：install 页用 useState 管理 method/serverUrl/workerId/concurrency/opencodeVersion，命令字符串动态拼接——切 docker tab 后 install-command 显示 `docker run -d --name opencode-worker-<id> -e SERVER_URL=... -e WORKER_ID=... -e CONCURRENCY=... -e OPENCODE_VERSION=... -p 18080:18080 ketaops/opencode-worker:latest`；fill worker-id-input 后命令同步含新 id。虽为纯展示原型（不真执行安装/复制），但受控联动让向导"看起来是真的"，比静态字符串更有说服力。
- **验证（playwright 20/20 PASS）**：worker-card=4（≥3）/worker-status=4 覆盖三态/worker-load=4/worker-heartbeat=4/worker-version data-v2 含 true+false（v1/v2 混合）/add-worker-button/worker-stats/worker-pool-hint + install-method-tab=2 覆盖 curl+docker/install-command/copy-command-button/server-url-input/worker-id-input/install-confirm-button/install-steps + tab 切换后命令含 docker run + workerId 编辑后命令联动 + console 0 error。截图 `.omo/evidence/worker-list.png`（172KB）/ `worker-install.png`（183KB）非空。
- **经验**：① 新语义色（worker 在线绿/维护琥珀/离线红、v2 紫）在 _shared 不改的前提下以页面局部常量收敛，色值与 styles.statusColors/roles 同族保证视觉一致，注释注明来源；② CSS 动画 scoped 前缀 workerpulse- 沿用 T14/T17 防污染惯例；③ `<style>` 注入 keyframes + inline animation 引用（pulseCss 挂在 root 组件内）在 React 内合法；④ select/input 受控表单在原型里完全可用（useState + value/onChange），playwright fill 后命令联动可断言，是"纯展示 vs 可演示"的中间档；⑤ breadcrumb 与 title 互斥（T18 经验），install 页刻意用 breadcrumb 展示两级导航心智。

## T21 worker-install 命令展示区浅色主题修复（2026-08-06）

- **交付**：`prototypes/worker-install/index.tsx` 的 `CommandBlock` 组件配色由深色底改浅色主题（用户反馈：深色 #0F172A 与页面浅色主题不协调）。
- **改动点（全部收敛到 `_shared/styles.ts` token，零魔法色值）**：
  - 容器：`backgroundColor: neutral[100]`（#F1F5F9）+ `border: 1px solid neutral[200]`（替换原 `rgba(255,255,255,.08)` 白半透明边框），保留 `shadow.md`。
  - 命令文字：`color: neutral[800]`（替换原 #E2E8F0 白字），保留 `fontFamily.mono` + pre-wrap + break-all。
  - `$` 提示符：`color: roleText.developer`（#059669 深绿，替换原深底亮绿 #34D399 —— 浅底上保持终端绿色语义且可读）。
  - 复制按钮：`backgroundColor: neutral[50]` + `color: neutral[600]` + `border: neutral[200]`（与页面「重新生成」按钮风格一致，替换原白半透明底/白字）。
  - data-testid（install-command / copy-command-button）与命令联动逻辑未动。
- **全页深色元素排查**：仅 CommandBlock 是深色；步骤编号（①②③）与 InstallSteps 圆圈均已是 `#EFF6FF/#2563EB` 浅蓝主题，无需改。
- **验证**：playwright（chromium_headless_shell-1208）断言 install-command 计算样式 `backgroundColor = rgb(241,245,249)`（=neutral[100]，luminance 244 非深色）、复制按钮 rgb(248,250,252)/rgb(71,85,105)、0 console error、无 fixed/vh/vw，全 PASS。截图 `.omo/evidence/worker-install-light.png`。
- **⚠️ playwright 环境**：系统 python3（3.10.12）已带 playwright（`/home/keta/.local/lib/python3.10/site-packages`，无 `__version__` 属性但可正常 import/launch），chromium 用 `executable_path=/home/keta/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`。

## Skills/Tools 管理 + 工具注册原型：平台 skill/tool 协议落地（2026-08-06）

- **交付**：`prototypes/skills-tools-manage/index.tsx`（meta.id=skills-tools-manage）+ `prototypes/tool-register/index.tsx`（meta.id=tool-register），均 device=desktop、`satisfies PrototypeDef`，复用 `../_shared/nav`（NavDock/NavTopBar/CmdKPanel）+ `../_shared/components`（AgentBadge）+ `../_shared/styles` token，未改 _shared / 其他原型 / 未引第三方库。
- **skills-tools-manage 结构**：root `data-testid=skills-tools-manage-root`（height:100% + minHeight:720 + relative）→ NavTopBar `title="技能与工具" subtitle="平台 Skills / Tools 统一管理，绑定角色后分发到 worker 节点"`（title 模式非 breadcrumb）→ main（flex:1 overflow auto + paddingLeft RAIL_W+24=80 避让 Dock）内 maxWidth 1080 容器：① 工具条（manage-toolbar）：双 Tab（manage-tab ×2 data-kind=skill|tool data-active 受控 useState 切换，tab 内计数 pill 用 mono）+ 搜索框（search-input 受控 value 但不过滤，避免破坏数量断言）+ 右上 upload-skill-button ⧉ 上传技能 / register-tool-button ✚ 注册工具（蓝实底白字）② 列表卡（manage-list 白底）：列表头（当前 Tab 语义说明 + 07 篇引用：v1 编译 .opencode 目录 / v2 transform 注入）→ skill-item 行卡片 ×5（code-review 代码审查[dev 内置启用]/requirement-analysis 需求分析[product 内置]/test-case-gen 测试用例生成[tester 上传]/git-ops git 操作[dev+architect 内置]/doc-gen 文档生成[product 上传 停用]）或 tool-item 行卡片 ×5（jira-query 依赖 jcli ⚠️ / git-pr 依赖 git ✅ / slack-notify 依赖 curl ✅ / code-format 无依赖内置 ✅ / deploy-run 依赖 jcli ⚠️ 停用）③ 底部 manage-hint（v1 写文件+重启实例 / v2 transform 热更新）。行卡片布局：左 icon 色块（roleText[首角色]+14 底）+ 名称 + VersionPill（mono 小 pill）→ 描述 ellipsis → 中 AgentBadge 组 → 右来源 badge（skill-source 内置蓝/上传紫）/ 依赖状态 badge（tool-dep-status ok=依赖已安装✅绿 missing=依赖缺失⚠️琥珀）/ 启用状态 badge（skill-status|tool-status 启用绿/停用灰）/ 操作（编辑 + 停用|启用，danger 红字）。NavDock activeKey="agents" + children 扩展槽放「技能 5 / 工具 5 / 依赖缺失 2」统计；CmdKPanel 受控关闭（T20）。
- **tool-register 结构**：root `data-testid=tool-register-root`（height:100% + minHeight:720 + relative）→ NavTopBar **breadcrumb 模式** `["技能与工具","注册工具"]` → main 内 maxWidth 760 居中注册卡（tool-register-card）：① 基础信息（tool-basic-section，StepNum ①）：tool-name-input（受控默认 jira-query，mono）+ 版本 select + tool-desc-input（受控 textarea）+ 绑定角色多选（role-bind ×4 data-bound，产品/开发/测试 ✓ 选中、架构师 ○ 未选，选中用 roleText[r]+14 底 + ✓）+ 输入输出 Schema（tool-schema：左右两张 mono 小卡简化 JSON {query/limit} → {issues/total}）② **依赖管理区（dependency-section，本页核心，StepNum ②）**：三态图例条（已安装✅ / 未安装⚠️ / 安装中◐）+ 核心提示 dependency-hint「本地不存在时，worker 节点按安装命令自动下载依赖」→ dependency-list 内 dependency-item ×3（jcli[missing 版本≥1.0.0 安装命令预填 curl -fsSL https://example.com/install-jcli.sh | bash]/git[installed ≥2.30]/curl[installed ≥7.60]），每行：左 bin 名（mono 600）+ DepStateBadge（dep-state data-status 三态）+ 版本要求 → 中 install-command-input（data-bin，受控；已安装 readOnly 置灰 neutral[100] 底 + placeholder「已安装，无需安装命令」；未安装白底可编辑）+ sourceNote → 右 check-dependency-button ◷ 检测（描边白）/ install-dependency-button ⬇ 安装（未安装蓝实底 / 已安装灰化 disabled 视觉）→ 底部「＋ 新增依赖」虚线行。底部 tool-register-footer：register-tool-button ✚ 注册工具（蓝实底）+ register-cancel-button 取消 +「manifest 注册后编译 v1 / v2 分发（07 篇 10.3）」提示。NavDock activeKey="agents"；CmdKPanel 受控关闭。
- **07 篇融合点**：工具依赖 = worker 节点侧二进制（11.6 Worker 节点三组件），注册时配置安装命令 → 本地不存在时 worker 按命令自动下载（呼应 10.3 依赖就位环节 + 11.2 能力声明含可用 skill/tool 清单）；v1 分发编译 .opencode 目录 / v2 transform 注入；jcli 作真实示例（本机 v1.0.1，mock 安装脚本 URL 用 example.com 不落地真实命令）。
- **页面内语义色扩展范式（再次落地）**：来源（内置蓝/上传紫）、启用（绿/灰）、依赖状态（✅绿/⚠️琥珀/◐蓝 installing）三组均未入 _shared statusColors——遵循"扩展 token"页面内定义具名常量并注释「语义独立于任务四态」原因；PillBadge 本地组件仿 StatusBadge 视觉（mark + label + theme）。
- **验证（playwright 38/38 PASS，首跑即全绿）**：manage 页 19 项（manage-tab≥2 / skill-item≥3 默认 Tab / tool-item≥3 Tab 切换后 / tool-dep-status≥5 且 missing≥1「依赖缺失 ⚠️」/ skill-source+skill-status≥5 / search-input+upload-skill-button+register-tool-button / 容器内边界 rail-bar+topbar+cmdk-trigger ±1px / cmdk 默认关闭→trigger 打开 / console 0 error）+ register 页 19 项（dependency-section / dependency-item=3（≥2）/ install-command-input=3 / check+install 按钮≥1 / tool-name-input+tool-desc-input+register-tool-button / dep-missing=1 jcli + dep-installed=2 git+curl / hint 文案含「自动下载依赖」+「worker 节点」/ jcli 命令预填 install-jcli.sh / role-bind≥4 / tool-schema / 边界 / cmdk 默认关闭 / console 0 error）。截图 `.omo/evidence/skills-tools-manage.png`（239KB）/ `tool-register.png`（160KB）非空。
- **经验**：① Tab 受控切换（useState）是管理页标准交互，但搜索框只受控不过滤——避免输入破坏数量断言；② 行卡片信息密度高时用「左 icon 色块 + 中 名称/版本/描述（flex:1 minWidth:0 ellipsis）+ 右 badges/操作」，宽度有限时 flexShrink:0 兜底；③ 依赖安装命令输入用 mono + 浅色（T21 教训：命令区禁黑底），已安装行 readOnly + neutral[100] 置灰 + placeholder 说明，未安装行白底可编辑——"可配置"与"已就绪"状态一眼可辨；④ 三态图例条（✅/⚠️/◐）把"安装中"状态能力与 mock 数据（仅两态）解耦，纯静态原型也能完整表达状态机；⑤ 验证脚本 `/tmp/opencode/skills-tools-verify.py` 复用 T14 wait_for_selector 轮询 + 容器内边界模板，tab 切换断言先 click 再 wait_for_selector 目标列表 testid。

## MCP 管理原型：mcp-list 列表页 + mcp-register 注册页（2026-08-06）

- **交付**：`prototypes/mcp-list/index.tsx`（meta.id=mcp-list，name=「MCP 服务器」，device=desktop）+ `prototypes/mcp-register/index.tsx`（meta.id=mcp-register，name=「注册 MCP」，device=desktop），均复用 `../_shared/nav`（NavDock/NavTopBar/CmdKPanel）+ `../_shared/styles` token，未改 _shared / 其他原型 / 未引第三方库。MCP 服务器与 skills/tools 并列由平台管理并注册到 opencode（07 篇 4 章 ConfigMCP + 11 章 worker 启动语境）。
- **mcp-list 结构**（对齐 worker-list 列表页范式）：NavTopBar title="MCP 服务器" + 统计条（mcp-stats：已连接/未连接/连接中/总数，绿/琥珀/蓝/蓝）+ 操作行「注册 MCP」按钮（register-mcp-button）+ 4 张 `mcp-item` 卡片网格（filesystem Local✅已连接 / git Local✅已连接 / jira Remote⚠️未连接 / search Remote◐连接中，`data-status` + `data-type` 双属性）。每卡：mcp-name（mono）/ mcp-status（三态徽章 ✅/⚠️/◐，连接中 ◐ 加 mcpspin 旋转动画）/ mcp-type（Local=蓝 #2563EB / Remote=紫 #7C3AED，与 worker v2 badge 紫系同族）/ mcp-config（配置摘要浅色块，T21：neutral[100] 底 + neutral[800] 字；Local 前缀 $ 蓝、Remote 前缀 ↗ 紫）/ mcp-tools（工具数 + "tools 可用 · 经 opencode 权限控制"）/ mcp-actions（连接/断开按钮 mcp-connect-toggle 按状态渲染：connected→断开、disconnected→连接、connecting→disabled；+ 编辑 + 删除红系）。
- **mcp-register 结构**（对齐 tool-register 表单范式）：① 基础信息（mcp-name-input + 类型选择 mcp-type-option 两个 Tab：Local 本地 ▣ / Remote 远程 ↗，受控 useState 切换，外容器 data-testid=mcp-type-select）；② 连接配置按类型切换——Local：mcp-command-input + mcp-command-array（命令空格拆分 chips 展示 command[]）+ mcp-cwd-input + 超时 select（defaultValue 非 selected 防 React warning）+ mcp-env-input（key=value 简化）；Remote：mcp-url-input + mcp-headers-input + mcp-oauth-toggle（受控开关，滑块 animation）；③ 依赖检测区 `mcp-dependency`（仅 Local 渲染，对齐 tool-register 依赖管理）：mcp-dependency-item=2（npx ✅ 已安装 / bun ⚠️ 未安装带安装命令 `curl -fsSL https://bun.sh/install | bash`，mcp-dep-state 两态 + 检测/安装按钮）。底部 register-mcp-button + register-cancel-button + 提示「注册后由 worker 节点按配置启动 MCP 服务器」。
- **验证（playwright 34/34 PASS）**：mcp-list 17 项（mcp-item=4≥3 / register-mcp-button / mcp-status=4 三态覆盖 / mcp-type=4 双类型覆盖 / mcp-config / mcp-tools / mcp-stats / connect-toggle 三态语义：connected 断开·disconnected 连接·connecting 禁用 / rail-bar / topbar / cmdk-panel 初始关闭→点 trigger 打开→✕ 关闭 / fixed 元素=0）+ mcp-register 16 项（mcp-name-input / mcp-type-option=2 / 默认 local 时 command 存在 + dependency 存在 / dependency-item=2 两态 / 未安装依赖带安装命令 / register-mcp-button / 切 remote→url 出现 + dependency 消失 + oauth-toggle / 切回 local→dependency 恢复 / rail-bar / cmdk-panel 初始关闭 / fixed 元素=0）+ console/pageerror=0。截图 `.omo/evidence/mcp-list.png`（173KB）/ `mcp-register.png`（163KB）非空。源码 grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 仅注释铁律说明（T15 合规）。脚本 `/tmp/opencode/mcp-verify.py`。
- **经验**：① 连接状态三态（connected/disconnected/connecting）与 worker 三态同构，用 connect-toggle 按钮按状态渲染"连接/断开/连接中禁用"表达 v2 connect/disconnect 生命周期，比静态徽章更有操作语义；② 类型 Local/Remote 用 Tab（worker-install method tab 范式）+ 受控切换配置区，remote 时依赖区条件不渲染（远程无本地二进制依赖），天然满足"mcp-dependency 存在"断言（默认 local）；③ `<select>` 静态默认项必须用 `defaultValue` 而非 `<option selected>`——后者 React 会打 console warning（虽不计数 error 但污染日志）；④ Remote 类型用紫系（#7C3AED，与 worker v2 badge 同族）与 Local 蓝系区分，形成"本地=平台内蓝 / 远程=外部紫"的视觉编码，后续 MCP 相关原型可复用。

## T22 tool-register 增加「执行方式」区（2026-08-06）

- **交付**：改造 `prototypes/tool-register/index.tsx`（meta.id=tool-register 不变），在「基础信息」与「依赖管理」之间插入 `execution-section`（执行方式 ②，依赖管理 ③），未改 _shared 与其他原型，未引入第三方库。
- **结构**：说明条（⚙ schema 是接口声明「模型知道怎么调」vs 执行方式是实际干活的部分「真正执行逻辑」——只有 schema 没有执行逻辑的工具无法工作）→ 执行类型 tab（`execution-type-list`，4 个 `execution-type` 按钮 data-exec-type=code/cli/http/template，受控切换，仿 install-method-tab 的 grid 2 列 + 图标/标题/描述 + active 白卡高亮）→ 受控联动配置面板（`execution-config-panel` data-exec-type 透传，按 execType 条件渲染 2a~2d）。
- **4 种执行形态**：① 平台代码（`handler-code-editor`，readOnly textarea 浅色 neutral[100] 底展示 HANDLER_CODE_EXAMPLE 伪 TS 代码）② CLI 封装（`cli-command-template` 受控输入 `jcli issue get {{issueKey}} --limit {{limit}}` + `cliOutput` select JSON/文本解析）③ HTTP 回调（`http-callback-url` + `httpMethod` POST/GET/PUT + 🔐 认证说明条）④ 内置模板（`template-select` 下拉 handlerTemplates 3 项：Git 状态检查/文档生成/工单同步 + 描述卡）。
- **CLI 与依赖区联动（关键设计）**：`cliMissingDeps = deps.filter(d => d.status === "missing")`，CLI 类型下渲染 `cli-dependency-hint`（琥珀 #FFFBEB/#FDE68A/#D97706 提示条）——「依赖 **jcli** 尚未安装 —— 执行时 worker 先按安装命令 `curl -fsSL ...install-jcli.sh | bash` 下载依赖，再运行工具（与下方依赖管理区呼应）」，与 dependency-section 的 missing 状态语义对齐。
- **T21 落实**：命令/代码展示区全部浅色（neutral[100] 底 + neutral[800] 字），handler-code-editor 在 inputStyle 上覆盖 `backgroundColor: neutral[100]`，无黑底。
- **验证（playwright 28/28 PASS）**：execution-section 1 + execution-type=4 且 key 全覆盖 + 默认 code 显示 handler-code-editor + 切 CLI 显示 cli-command-template 且 cli-dependency-hint 出现 + 切 HTTP 显示 http-callback-url 且 CLI 面板隐藏 + 切 template 显示 template-select(≥2 option) + 切回 code 恢复 + 8 个旧 testid 全保留（dependency-item/install-command-input/按钮各 3）+ root computed position=relative & height=800px（无 vh）+ console 0 error。截图 `.omo/evidence/tool-register-execution.png`（full_page 非空）。
- **经验**：① 执行形态 tab 直接复用 install-method-tab 的 grid 2 列模板（worker-install 与 tool-register 同属平台注册类页面，范式一致）；② 依赖联动提示用「取 deps 中 missing 项 + 引用其 installCommand」数据驱动而非硬编码 jcli，未来依赖状态变化提示自动跟随；③ 受控 select 的 value 类型用 as 断言（`e.target.value as "json" | "text"`）避免 TS 宽类型报错；④ 4 个条件渲染块用 2a~2d 编号注释 + 头部注释文档同步，维护者可直接定位对应形态。

## skills-tools-manage 三 Tab 扩展：技能/工具/MCP 统一管理 + jcli 语义修正（2026-08-06）

- **交付**：改造 `prototypes/skills-tools-manage/index.tsx`（meta.id 不变，唯一文件），双 Tab（技能/工具）→ **三 Tab（技能/工具/MCP）** 统一管理页，未改 _shared / 其他原型（mcp-list/mcp-register/tool-register 保留独立）/ 未引第三方库。
- **jcli 语义修正（任务核心）**：jcli = **Jenkins CLI**（本机 9 个 jcli 技能：jcli-build/jcli-job/jcli-pipeline…），原 `jira-query` 误用 jcli 已移除 → 工具 Tab 改为 5 个：`jenkins-build`（触发 Jenkins Job 构建，deps jcli ⚠️ 未装）/ `jenkins-job-list`（查询任务列表，deps jcli ⚠️）/ `git-pr`（git ✅）/ `slack-notify`（curl ✅）/ `code-format`（无依赖 ✅），dep 两态（missing≥1 + ok≥1）齐备；jira 归位到 MCP Tab（Remote jira 未连接），工具名/描述/图标同步更新，注释写明修正原因。
- **MCP Tab（新增）**：4 个 mcp-item 行卡片（filesystem Local✅已连接 / git Local✅ / jira Remote⚠️未连接 / search Remote◐连接中），字段：mono 服务器名 + 版本 pill / McpTypeBadge（Local 本地蓝 #2563EB / Remote 远程紫 #7C3AED）/ McpStatusBadge（三态 ✅/⚠️/◐，◐ 带 scoped `stmmcpspin` 旋转动画）/ 可用工具数块（mcp-tools，mono 数字 + tools）/ 操作（mcp-connect-toggle 按状态渲染 连接/断开/连接中 disabled + 编辑）。MCP 语义色与 mcp-list 原型同族，页面内扩展 token 注释「07 篇 4 章 ConfigMCP」。
- **操作按钮随 Tab 切换（新行为）**：skill → upload-skill-button ⧉（描边白）、tool → register-tool-button ✚（蓝实底）、mcp → register-mcp-button ＋（蓝实底，data-testid 新增）；每 Tab 只显示对应按钮，playwright 断言其余两个 count=0。
- **结构改动面**：`TabKey = "skill"|"tool"|"mcp"` 类型、tabs 数组 3 项（计数 pill 含 MCP 4）、`listMeta` Record 三态列表头说明（mcp 分支「Local 由 worker 节点按配置启动二进制 / Remote 直连远程服务」）、列表渲染三分支、NavDock children 统计加「MCP 4」行、manage-hint 文案改「skill/tool/MCP 变更生效路径」、CMDK_ITEMS 操作组加「注册 MCP ＋」。skill/tool 行卡片（SkillItemRow/ToolItemRow）零改动仅数据更新，既有 testid 全保留。
- **验证（playwright 33/33 PASS，warm-up 后正式跑全绿）**：manage-tab=3 且 data-kind 顺序 [skill,tool,mcp] / 默认 skill active / skill-item≥3 + skill-source+skill-status≥3 / upload-skill-button=1 且 tool+mcp tab 为 0 / tool-item≥3 含 jenkins-build+jenkins-job-list 且无 jira-query / tool-dep missing≥1 + ok≥1 / register-tool-button=1 且 skill+mcp tab 为 0 / mcp-item≥3 四服务器 / mcp-status 三态全覆盖 / mcp-type local+remote / mcp-tools≥3 / mcp-connect-toggle≥3 / register-mcp-button=1 且 skill+tool tab 为 0 / 回 skill 无回归 / root position=relative / fixed 元素=0 / cmdk-panel 初始关闭（T20）/ console+pageerror 0。截图 `.omo/evidence/skills-tools-mcp-manage.png`（189KB 非空，MCP Tab 打开态）。脚本 `/tmp/opencode/skills-tools-mcp-verify.py`。
- **经验**：① 管理页 Tab 扩展是「受控 key 联合 + 列表头/按钮/列表体三分支」的机械改点，按钮区按 tab 条件渲染即可满足「随 Tab 切换显示对应入口」；② jcli 语义修正只需动 tools mock 数据与顶部注释（jcli=Jenkins CLI + 9 个 jcli 技能），依赖区 tool-register 原型同批已对齐；③ MCP 语义色/组件（TypeBadge/StatusBadge/ConnectButton）从 mcp-list 概念迁移到本页时按「页面内扩展 token + scoped 动画前缀」惯例局部重实现，不跨原型 import，符合「mcp-list 保留独立」约束；④ 行卡片宽度有限时 mcp 行省略 config 摘要（mcp-list 卡片有），用「权限 {name}_*」副文案保留权限语义，字段聚焦任务要求的四要素（名称/类型/连接状态/工具数）。

## tool-register 增加「MCP 接入」第 5 种执行方式（2026-08-06）

- **交付**：改造 `prototypes/tool-register/index.tsx`（meta.id=tool-register 不变），执行方式 4 种 → **5 种**（code/cli/http/template/mcp），吸收 mcp-register 的 Local/Remote 配置能力并入本页（用户方案 B：MCP 是工具的一种来源类型，非独立能力）。未改 _shared / 其他原型 / 未引第三方库。
- **结构**：execTypes 数组加 `{ key:"mcp", label:"MCP 接入", icon:"▣", desc:"连接 MCP server · 工具注册为 <server>_<tool>" }`；配置面板新增 2e 分支——① `mcp-type-select` 容器（`mcp-type-option` ×2 data-type=local|remote 受控切换，复用 execution-type tab 的 grid 2 列范式）② Local：`mcp-command-input` + `mcp-cwd-input` + `mcp-env-input`（简化 key=value）③ Remote：`mcp-url-input` + `mcp-headers-input` + `mcp-oauth-toggle`（受控开关滑块）④ Local 专属 `mcp-dependency` 依赖检测区（npx ✅ 已安装 / bun ⚠️ 未安装带安装命令 `curl -fsSL https://bun.sh/install | bash`）⑤ 底部命名空间提示「{server}_{tool} 进入 opencode 工具命名空间」。
- **testid 前缀隔离决策（关键）**：MCP 依赖行复用 DependencyRow 的视觉（浅色 T21）但 **testid 全用 mcp- 前缀**（mcp-dependency-item / mcp-dep-state / mcp-dependency-install-command / mcp-check-dependency-button / mcp-install-dependency-button），与依赖管理区（dependency-item 等）计数解耦——否则 dependency-item 断言 3 会被 MCP 面板的 2 行污染。复用现有 depStateColors（三态）即可，无需新色。
- **状态集**：页面新增 9 个受控 state（mcpType/mcpCommand/mcpCwd/mcpEnv/mcpUrl/mcpHeaders/mcpOauth/mcpInstallCommands）；mcp 依赖数据独立 `mcpDeps`（复用 Dependency 接口）不并入 deps，避免 CLI 依赖联动（cliMissingDeps filter missing）误把 bun 算进 CLI 提示。
- **验证（playwright 46/46 PASS，首跑即全绿）**：execution-type=5 且 key 全覆盖 / 默认 code 显示 handler-code-editor / 切 mcp → config-panel data-exec-type=mcp + mcp-type-select + 默认 local 显示 command+cwd+env+dependency（url 不显示）/ mcp-dependency-item=2 两态 npx+bun / bun 命令预填 bun.sh / 命名空间提示含 {server}_{tool}+opencode / 切 remote → url+headers+oauth 出现、command+dependency 隐藏 / oauth 点击翻转 / 切回 local 恢复 / 原有 4 类型逐个可切（code/cli+cli-dependency-hint/http/template）/ 既有 9 testid 全保留（dependency-item=3 等）/ root position=relative + fixed 元素=0 / console+pageerror 0。截图 `.omo/evidence/tool-register-mcp.png`（full_page 非空）。脚本 `/tmp/opencode/tool-register-mcp-verify.py`。
- **经验**：① 执行方式 tab 从 4→5 是机械改点（ExecType 联合 + execTypes 数组 + 条件渲染分支 + 头部注释 + meta description 五处），grid 2 列下第 5 项单独一行可接受；② 「并入 mcp-register 能力」的正确姿势是**复制配置区到面板内 2e 分支 + 独立 state**，而非 import mcp-register 组件（跨原型 import 违反惯例，且 mcp-register 保留独立）；③ Remote 无本地二进制依赖 → mcp-dependency 条件只挂 local 分支，天然满足「remote 时隐藏」断言；④ 依赖区与执行面板的 testid 前缀隔离是此类嵌套表单的通用防混淆范式。

## skills-tools-manage 重构：三 Tab → 二 Tab（工具按来源分组：内置 · 自定义 · MCP）（2026-08-06）

- **交付**：改造 `prototypes/skills-tools-manage/index.tsx`（meta.id 不变，唯一文件），三 Tab（技能/工具/MCP）→ **二 Tab（技能/工具）**，MCP 并入工具 Tab 作为「MCP 工具」分组（用户方案 B：MCP 是工具的一种来源类型，非独立能力）。未改 _shared / 其他原型 / 未引第三方库。
- **工具 Tab 按来源三分组**（分组头 `GroupHeader`，testid=builtin-group/custom-group/mcp-group，色条图标+分组名+说明+计数 pill）：
  - **内置工具**（builtin-group，蓝系）：平台预置开箱即用——git-status / code-format / secret-scan，行内「开箱即用」徽章（tool-ready，蓝 #2563EB）。
  - **自定义工具**（custom-group，紫系）：用户注册的代码·HTTP·CLI 工具——jenkins-build / jenkins-job-list（CLI，依赖 jcli ⚠️ 缺失）/ slack-notify（HTTP，curl ✅）/ git-pr（CLI，git ✅）/ data-transform（代码，无依赖），行内「实现类型」徽章（tool-kind：代码=绿 / HTTP=橙 / CLI=紫）+ 依赖状态（tool-dep-status，沿用 depStateColors 两态）。
  - **MCP 工具**（mcp-group，青系 #0D9488）：MCP server 暴露的工具，行改为 `mcp-tool-item`（原 mcp-item 概念并入），字段：mono 工具名 `<server>_<tool>`（id 即 filesystem_read_file / git_status / jira_search_issues / search_query）+ desc 标注「来自 MCP server，命名 {server}_{tool} · 权限 {server}_*」+ McpTypeBadge（Local 蓝 / Remote 紫）+ McpStatusBadge（✅/⚠️/◐ 三态，◐ scoped stmmcpspin 旋转）+ 启用状态。jcli 语义保持正确（jenkins 依赖 jcli，jira 属 Remote MCP 未连接，与 jcli 无关）。
- **操作按钮随 Tab**：skill → upload-skill-button ⧉（描边白）；tool → register-tool-button ✚（蓝实底主入口）+ **register-mcp-button ＋（描边白，保留——注册 MCP 是工具来源之一）**。
- **关键踩坑（React 保留 prop）**：`GroupHeader` 首版用 `key` 作参数名，但 `key` 是 React 保留 prop 不会传入组件 → `groupTheme[undefined]` 运行时崩溃（点工具 Tab 时整个树卸载，manage-list 消失）。改为 `kind` 参数名即修复。教训：自定义组件 props 永远避开 `key`/`ref` 保留名。
- **结构改动面**：`TabKey = "skill"|"tool"`；tabs 数组 2 项（工具计数=内置3+自定义5+MCP4=12）；listMeta 二态；工具列表渲染三分组；NavDock 统计改「技能 / 工具·内置 / 工具·自定义 / 工具·MCP / 依赖缺失」；manage-hint 文案补「MCP 工具经 v2 connect/disconnect 控制连接」；顶部注释与 meta.description 更新为「技能 / 工具（内置·自定义·MCP）二 Tab」。
- **验证（playwright 25/25 PASS）**：manage-tab=2 且 data-kind=[skill,tool] / 默认 skill：skill-item≥3 + upload-skill-button=1 且 register-tool/register-mcp=0 / search-input + manage-list 存在 / 切 tool：tool-item≥3（=8）+ mcp-tool-item≥1（=4）+ builtin-group/custom-group/mcp-group 三组各 1 + 分组顺序 builtin<custom<mcp / register-tool-button=1 + register-mcp-button=1 + upload-skill-button=0 / 列表文本含 filesystem_read_file+jira_search_issues+「来自 MCP server」 / jenkins-build 依赖 jcli / mcp-tool-item 属性 data-server=data-type=data-status 透传 / root position=relative + minHeight=720px + fixed/vh/vw 元素=0 / console+pageerror 0。截图 `.omo/evidence/skills-tools-2tab.png`（206KB 非空，工具 Tab 打开态）。脚本 `/tmp/opencode/verify_2tab.py`。
- **经验**：① 三 Tab→二 Tab 是「删 mcp Tab 分支 + 工具列表改为三分组渲染 + 按钮区合并」的收敛改点，mcp-item 组件改名为 mcp-tool-item 并挂到工具列表尾部即可，TypeBadge/StatusBadge/动画 token 全部复用零新增；② 分组头用「色条图标+说明+计数」三段式，三组色系（蓝/紫/青）与行内徽章语义（来源/类型/连接）一一对应，视觉即数据结构；③ 工具 Tab 的 register-mcp 用描边次按钮（相对 register-tool 蓝实底主按钮），表达「注册 MCP = 工具来源之一」的主次关系；④ 计数 pill 是「分组存在感」的关键——无计数时三分组视觉上退化成三条装饰条。

## tool-register 重构：去「内置模板」执行类型 + 依赖管理区 → 初始化命令/脚本区（2026-08-06）

- **交付**：改造 `prototypes/tool-register/index.tsx`（meta.id=tool-register 不变，唯一文件），两项用户决策落地——① 执行方式 5 种 → **4 种**（code/cli/http/mcp，去掉 template）；② 依赖管理「平台推断二进制」模型 → **「用户填写初始化命令/脚本，worker 执行工具前先运行完成初始化」**（平台不自动推断二进制）。未改 _shared / 其他原型 / 未引第三方库。
- **执行类型收敛**：`ExecType = "code"|"cli"|"http"|"mcp"`；execTypes 数组删 template 项（grid 2 列 4 项正好 2×2，无孤行）；删 handlerTemplates mock、template/setTemplate state、2d 分支配置面板（template-select）；meta.description 与顶部注释同步 5→4 种。CMDK_ITEMS「检测依赖」改「配置初始化命令」（依赖语义已移除）。
- **初始化区（init-section，替代 dependency-section）**：新 testid——init-section / init-hint（执行时机说明「worker 节点在首次执行该工具前运行初始化命令；已初始化过的节点跳过（可配置强制重跑）」）/ init-command-list / init-command-item（data-index 定位）/ init-command-input（textarea 多行 shell 脚本，T21 浅色 neutral[100] 底 + neutral[800] 字 + mono）/ init-command-note（说明可选）/ add-init-command（虚线描边按钮）/ remove-init-command。默认预填 `# 安装 jcli（Jenkins CLI）\ncurl -fsSL https://example.com/install-jcli.sh | bash`（jcli=Jenkins CLI 语义保持）。受控：initCommands 数组 + add/remove/updateScript/updateNote 四个 setter。
- **删除的依赖推断模型（全部）**：DepStatus/depStateColors 三态 token、Dependency 接口、deps/mcpDeps mock、DepStateBadge/DependencyRow/McpDependencyRow 组件、commands/setCommand/mcpInstallCommands/setMcpInstallCommand state、cliMissingDeps、dependency-section 区块及其 dependency-item/install-command-input/check-dependency-button/install-dependency-button/dependency-hint 等 testid、MCP Local 的 mcp-dependency 依赖检测区（mcp-dependency-item 等 mcp- 前缀 testid 一并移除）。
- **CLI/MCP 联动更新**：① CLI 类型 `cli-dependency-hint` → **`cli-init-hint`**（data-ready 布尔态双渲染）：无已配置脚本 → 琥珀警告「⚠️ 初始化命令未配置 —— 请配置初始化命令以准备 jcli 等环境」；≥1 条 → 蓝条「已配置 N 条初始化命令 —— worker 首次执行工具前自动运行（与下方初始化区呼应）」。② MCP Local 模式删依赖检测区，改 `mcp-init-hint` 蓝条「启动 MCP 命令若需要 npx / bun 等运行时，请在下方初始化区自行配置安装脚本 —— 平台不自动推断二进制」；Remote 模式不展示（条件只挂 local 分支）。
- **保留零改动**：全部既有 testid（tool-register-root/card/basic-section/name-input/desc-input/schema/role-bind、execution-section/type-list/type/config-panel、handler-code-editor、cli-command-template、http-callback-url、mcp-type-select/option/command-input/cwd/env/url/headers/oauth-toggle、register-tool-button/cancel/footer）；FieldRow/StepNum/inputStyle/baseFont/RAIL_W 惯例；T15（height:100% + minHeight:720 + relative，零 fixed/vh/vw）、T20（CmdK 受控默认关闭）、T21（命令区浅色）铁律。
- **验证（playwright 47/47 PASS + T21 专项 PASS）**：execution-type=4 且 key 集 {code,cli,http,mcp} 无 template / template-select=0 / init-section + init-command-list + init-hint 存在 / init-command-item=1（默认）且 input 预填 install-jcli / init-command-input + init-command-note ≥1 / add-init-command 点击 1→2、remove 2→1 / 原 15 个 dependency 系 testid（含 mcp- 前缀）count 全 0 / 切 cli → cli-init-hint data-ready=true，清空脚本后 data-ready=false 且文案含「请配置初始化命令以准备 jcli 等环境」/ 切 mcp → mcp-type-select + mcp-init-hint（local）+ mcp-command-input，切 remote → mcp-url-input 出现且 mcp-init-hint 消失 / http 与 code 类型无回归 / 无 fixed/100vh/100vw / console+pageerror 0。T21 专项：init-command-input computed bg=rgb(241,245,249)(neutral[100]) + color=rgb(30,41,59)(neutral[800]) + mono。截图 `.omo/evidence/tool-register-init.png`。脚本 `/tmp/opencode/verify_tool_register.py` + `/tmp/opencode/verify_t21.py`。
- **经验**：① 去执行类型 = 删 ExecType 联合项 + execTypes 数组项 + 条件渲染分支 + state + mock + 头部注释 + meta.description 六处机械收敛，grid 2 列 5→4 项恰好回正 2×2；② 「依赖推断 → 初始化命令」的本质是**把平台职责转移给注册者**：删状态检测 UI 后，联动提示从「列出缺失二进制」改为「提示用户去配置初始化命令」，data-ready 布尔态由「脚本非空计数」推导（configuredInitCount），无需任何二进制探测语义残留；③ testid 从 dependency-* 迁移到 init-* 是语义断裂点，playwright 断言要双向覆盖（新 init-* 存在 + 旧 dependency-*/mcp-依赖 全为 0），防「换皮不换里」；④ textarea 多行脚本用 neutral[100] 底 + neutral[800] 字正是 T21 的命令区范式，input 用白底区分「可编辑表单 vs 命令展示」，两类输入同页并存时靠底色分层。

## tool-register Schema 区重构：静态 Schema → 按执行类型动态展示（2026-08-06）

- **交付**：改造 `prototypes/tool-register/index.tsx`（meta.id 不变，唯一文件），用户决策落地——输入/输出 Schema 不再静态放在「基础信息」，移到「执行方式」选择之后按类型动态展示所需参数。未改 _shared / 其他原型 / 未引第三方库。
- **区块顺序（编号重排）**：① 基础信息（工具名/描述/版本/绑定角色，**删除静态 tool-schema 块**，标题说明改「名称/描述/版本/角色绑定」）→ ② 执行方式（4 类型，execution-section 不动）→ **③ schema-section（新，data-testid=schema-section + data-exec-type 透传）** → ④ 初始化命令（StepNum 3→4）。
- **schema-section 4 分支（受控，execType 决定显示哪套，互斥）**：3a code=`code-input-schema`/`code-output-schema` 两个 readOnly textarea（浅色 neutral[100] 底 T21，预填 JSON Schema 示例 `{"type":"object","properties":{...}}`，说明条「定义模型调用该工具的输入参数」）；3b cli=`cli-arg-map-list` 内 3 条 `cli-arg-map-item`（data-arg + data-placeholder，参数名 mono → 蓝 `{{占位符}}` pill → 说明，浅色行）+ `cli-output-parse` select（**复用 cliOutput state**，与 execution-config-panel 输出解析联动一致）+ 说明条「CLI 参数映射：把输入参数拼进命令占位符」；3c http=3 条 `http-param-item`（data-arg + data-location=query|body，query 蓝 / body 绿）+ 新增 `http-output` state 的 `http-output-parse` select；3d mcp=`mcp-schema-note` 蓝条「无需配置参数 Schema —— 连接后由 MCP server 声明工具的输入输出，注册为 {server}_{tool}」。
- **mock 数据**：`INPUT_SCHEMA_EXAMPLE`/`OUTPUT_SCHEMA_EXAMPLE`（JSON Schema 字符串，readOnly 不编辑）、`cliArgMap`（3 条 issueKey/projectKey/limit）、`httpParams`（3 条 query×2 + body×1），均 `as const` 静态数组，纯展示不实现真实校验。
- **验证（playwright 45/45 PASS，首跑即全绿）**：schema-section 存在且 data-exec-type 随切换 / 默认 code 显示 code-input-schema+code-output-schema 且预填 JSON / **tool-schema count=0（静态 Schema 已移除）** / 既有 8 个全局 testid 保留 + execution-type=4 / 切 cli→cli-arg-map-item=3（data-arg=issueKey + {{issueKey}}）+ cli-output-parse=json + code schema 隐藏 + cli-command-template 保留 / 切 http→http-param-item=3（query+body 双位置）+ http-output-parse + cli 隐藏 + http-callback-url 保留 / 切 mcp→mcp-schema-note（含「无需配置参数 Schema」+ {server}_{tool}）+ code/http 隐藏 + mcp-type-select + mcp-command-input 保留、切 remote 后 mcp-url-input 保留 / 切回 code 恢复 / 无 fixed/vh/vw + root relative / cmdk 受控 初始关→开→✕关 / console+pageerror 0。截图 `.omo/evidence/tool-register-dynamic-schema.png`（170KB 非空，cli 打开态）。脚本 `/tmp/opencode/verify_tool_register_schema.py`。
- **⚠️ 踩坑（JSX 大括号转义）**：JSX 文本里写 `（{{arg}}）` 会因 `{{` 被解析为对象字面量而报 `[PARSE_ERROR] Expected ':' but found '}'`（@fs 端点 500 + `const error={message` 可解析）——**文本中展示 `{{arg}}` 必须写成 `{"{{arg}}"}`**（单层表达式返回字符串），首个版本 500 即此因，curl @fs 200 后 playwright 才通过。
- **经验**：① 「按类型动态展示」的区块容器 = section 加 `data-exec-type` 透传 + 4 个条件渲染分支，与 execution-config-panel 的 2a~2d 同构，编号 3a~3d 注释对齐；② 输出解析 select 若两处（执行配置面板 + schema 区）出现，共用同一 state 保证语义一致（同一工具只有一种 stdout 解析方式）；③ 验证脚本中「条件渲染 testid」必须在对应类型切换后再断言（cli-command-template/http-callback-url/mcp-* 只在各自类型下存在，全局断言会误 FAIL）；④ 交互顺序坑：CmdK 打开后遮罩拦截下方表单点击（T20/learnings 已知），截图/继续交互前必须先关 cmdk。
- **概念模型重构（用户澄清：Schema 统一 vs 执行绑定分离）**：tool-register ③ 区由「按类型动态参数配置」改为 `input-schema-section`（统一区）——code/cli/http 共用同一 readOnly `input-schema-editor`（T21 浅色 mono 底，预填 `{"type":"object","properties":{"jobName":{"type":"string"},"buildNumber":{"type":"integer"}},"required":["jobName"]}`）+ 可选 `output-schema-editor`，切换 cli/http 时 editor **不消失**（`execType !== "mcp"` 单条件渲染，mcp 显示 `mcp-schema-note`）；旧 `cli-arg-map-item`/`http-param-item`/`code-input-schema`/`code-output-schema` 全部删除。
- **④ `binding-section`（执行绑定，仅 cli/http）**：cli=`binding-cli-item`（参数名 → {{占位符}}，参数名来自输入 Schema）+ `cli-output-parse` select（由 execution-config-panel 2b 内迁来，保留 testid 语义正确）；http=`binding-http-item`（参数名 + **受控 location select** query/body/path，`httpLocs` state 按参数名存 `Record<"query"|"body"|"path">`）+ `http-output-parse`；code=`binding-code-note`「无需执行绑定，execute 函数直接使用输入参数」/ mcp=`binding-mcp-note`「由 MCP server 处理」；说明条「模型按输入 Schema 传参；此处绑定参数如何拼入命令/请求（执行期细节，模型无感知）」。
- **区块顺序**：① 基础信息 → ② 执行方式 → ③ 输入/输出 Schema（统一）→ ④ 执行绑定（按类型）→ ⑤ 初始化命令（init-section StepNum 4→5）。
- **验证（playwright 38/38 PASS）**：input-schema-section/binding-section 存在 / code/cli/http 三类型 input-schema-editor 不消失且预填 jobName/buildNumber / mcp 无 editor + mcp-schema-note + binding-mcp-note / cli→binding-cli-item（{{jobName}}）+ cli-output-parse / http→binding-http-item（data-location=query）+ http-output-parse / code→binding-code-note / 既有 testid 全保留（cli-command-template/http-callback-url/mcp-type-select/mcp-command-input/mcp-url-input 须切到对应类型后断言）/ 无 fixed/vh/vw / console+pageerror 0。截图 `.omo/evidence/tool-register-schema-binding.png`。脚本 `/tmp/opencode/verify_tool_register.py`。
- **经验**：① 「统一区（切类型不消失）」用取反条件 `execType !== "mcp"` 单分支渲染，而非 4 分支互斥——避免同一 editor 三处重复；② 绑定区 select（location）用 `Record<arg, value>` state + `HTTP_LOCATIONS` const 数组，不引第三方库实现选择器；③ 输出解析 select 从执行方式区迁到绑定区后，执行方式区只留「命令模板/回调 URL」（概念归位：执行方式=怎么执行，绑定=参数怎么拼），删除冗余的无 testid 输出解析块。

## tool-register CLI 自由调用（Schema-less）子模式（2026-08-06）

- **交付**：改造 `prototypes/tool-register/index.tsx`（meta.id 不变，唯一文件），CLI 封装类型下新增第二个子模式——**自由调用（Schema-less）**：不定义输入 Schema、不定义参数映射，模型像 bash 一样传命令字符串（业界模式：Claude Code Bash tool schema-less、wrapmcp run_cli）。未改 _shared / 其他原型 / 未引第三方库。
- **模式选择（cli-mode-select）**：CLI 类型 2b 区顶部新增受控双 tab（`cliMode` state，默认 schema）——`cli-mode-schema`「Schema 化调用」（◈ 定义 Schema + 参数映射 · 类型安全）/ `cli-mode-free`「自由调用」（⌥ 不定义 Schema · 像 bash 一样传命令）。tab 样式完全复刻 mcp-type-select（grid 1fr 1fr + neutral[100] 容器 + 白底激活 + shadow.sm），data-active 布尔态透传。
- **自由调用配置区（cli-free-config，mode=free 时替代命令模板）**：① 说明蓝条「不定义输入 Schema，模型直接以命令字符串调用（类似 bash 工具）；适合通用 CLI 探索与快速接入」；② `cli-free-command` 命令模板/前缀（默认 `jcli `，固定前缀，模型传的字符串追加其后）；③ `cli-free-whitelist` 白名单 textarea（可选，每行一个子命令如 `job search`，留空=全允许）；④ 执行约束 grid：`cli-free-timeout`（默认 `60s`）+ `cli-free-cwd` 工作目录（可选）；⑤ 浅色提示条「模型会看到说明与白名单，自由构造命令；worker 执行时追加到前缀后运行」。
- **模式联动（核心语义）**：cli+free 时 `input-schema-section` 与 `binding-section` **整区隐藏**（条件 `!(execType === "cli" && cliMode === "free")` 包裹两 section），input-schema-editor / binding-cli-item / cli-output-parse / cli-command-template 全部不渲染；切回 schema 恢复。3a 内部再加双保险条件 `execType !== "mcp" && (execType !== "cli" || cliMode === "schema")`。cli-init-hint 初始化联动提示两模式共用（自由调用同样需要初始化命令准备环境）。
- **验证（playwright 45/45 PASS）**：全部既有 testid 存在（code 初始态下 binding-cli-item/cli-output-parse 是 cli 专属，须切 cli 后再断言，勿全局断言）/ 切 cli → cli-mode-select + cli-mode-schema（默认 active）+ cli-mode-free + cli-command-template + input-schema-editor + binding-cli-item=2 / 切 free → cli-free-config + cli-free-command（值=jcli ）+ cli-free-whitelist（2 行）+ cli-free-timeout + cli-free-cwd 可见，input-schema-editor / input-schema-section / binding-cli-item / binding-section / cli-command-template / cli-output-parse 全 count=0，init-command-item + register-tool-button 仍可见 / 切回 schema → 全部恢复 / 无 fixed/100vh/100vw inline / console+pageerror 0。截图 `.omo/evidence/tool-register-cli-free.png`。脚本 `/tmp/opencode/verify_cli_free.py`。
- **经验**：① 「整区隐藏 vs 隐藏内容」：需求说「输入 Schema 区与执行绑定区隐藏」，用条件包裹整个 `<section>`（含 header）最贴合，比只藏内部 editor 更干净，且 playwright 断言直接 count==0；② 自由调用本质是把「schema 声明接口」降级为「前缀 + 白名单 + 超时的命令自由区」——绑定区（参数映射）在 free 下概念上不存在，与其显示「无需绑定」说明，不如整区隐藏，避免误导用户以为还有参数映射可配；③ 双保险条件（section 层 + 3a 内容层）成本低，防后续有人拆 section 条件时 editor 泄漏；④ 与 mcp-type-select 同构的 tab 是复用最快的路径——图标/激活态/描述三段式布局直接复制，仅 testid 与文案不同。

## tool-register CLI 自由调用修正：Schema-less → 自动生成极简 {command} schema（2026-08-06）

- **交付**：改造 `prototypes/tool-register/index.tsx`（meta.id 不变，唯一文件），修正自由调用模式的协议语义。**关键事实（opencode 源码验证）**：opencode 工具强制要求 input schema（v2 `Tool.make` 的 `input` 必填、v1 `tool()` 的 `args` 必填），bash 工具先例 = `Schema.Struct({ command: String })`（packages/core/src/tool/bash.ts:23-24）——「自由调用」**不是**「无 schema」，而是「自动生成极简 {command} schema」。未改 _shared / 其他原型 / 未引第三方库。
- **③ 输入 Schema 区修正（核心）**：原「cli+free 整区隐藏 input-schema-section」改为 **section 始终渲染**，cli+free 时显示只读自动生成 schema `cli-free-schema`（T21 浅色 neutral[100] 底 + neutral[800] 字 + mono），内容 `{"type":"object","properties":{"command":{"type":"string","description":"模型自由构造的命令字符串（执行时追加到前缀后）"}},"required":["command"]}`（常量 `CLI_FREE_SCHEMA_EXAMPLE`）；下方蓝条说明「使用极简 {command} schema —— 与 opencode bash 工具同模式，模型像 bash 一样自由传命令字符串（符合 opencode 工具协议）」。手写 `input-schema-editor` / `output-schema-editor` 在 free 下仍隐藏（3a 条件不变），3a-2 新分支 `execType === "cli" && cliMode === "free"` 渲染。
- **④ 执行绑定区不变**：`binding-section` 仍由 `!(execType === "cli" && cliMode === "free")` 整区隐藏（command 是整体字符串，无参数映射概念）。
- **文案/注释收敛**：cli-free-config 说明条「不定义输入 Schema，模型直接以命令字符串调用」→「使用自动生成的极简 {command} schema（与 opencode bash 工具同模式）」；cli-mode-free tab desc →「自动生成 {command} schema · 像 bash 一样自由传命令」；调用模式 hint 同步；文件头注释、cliMode state 注释、3a 注释、def meta.description 全部从「Schema-less / 不定义 Schema」改为「自动生成极简 {command} schema / 符合工具协议」。
- **验证（playwright 21/21 PASS）**：切 CLI → 切 free → `cli-free-schema` 存在且 value 含 `"command"` 字段 + description + required / cli-free-config + cli-free-command + cli-free-whitelist + cli-free-timeout 存在 / binding-section 隐藏 + binding-cli-item=0 / input-schema-editor 隐藏但 input-schema-section 仍在（展示自动生成 schema）/ output-schema-editor 隐藏 / 文案含「使用自动生成的极简」「opencode bash 工具」/ 切回 schema → input-schema-editor + binding-cli-item=2 恢复、cli-free-schema 消失 / console+pageerror 0 / 无 fixed / 无 100vh/100vw。截图 `.omo/evidence/tool-register-cli-free-schema.png`。脚本 `/tmp/opencode/verify_tool_register_cli_free.py`。
- **经验**：① 「自由调用」的协议正确实现 = **极简 {command} schema 而非无 schema**——模型不是「无接口调用」而是「以 command 字符串为唯一入参调用」，这同时解释了为什么 bash 类工具在 opencode 里能自由执行；② section 级条件从「整区隐藏」改为「整区渲染 + 内容分支」后，隐藏/显示的断言要双向（free 时 input-schema-editor=0 但 input-schema-section 存在），避免旧断言「section count=0」误报；③ `{command}` 在 JSX 文本必须 `{"{command}"}` 或包 `<code>` 元素转义（复用 mcp `{server}_{tool}` 的 code 内联样式先例）；④ 概念上自由调用仍有 schema（自动生成），只是从「注册者手写 Schema+映射」降级为「平台按 bash 模式生成 command 字符串 schema」——手写编辑器隐藏、自动生成只读展示，是「协议合规」与「零配置」的平衡点。

## skills-tools-manage 工具列表改造：平铺分组 → 工具 Tab 内三子 Tab（2026-08-06）

- **交付**：改造 `prototypes/skills-tools-manage/index.tsx`（meta.id 不变）。工具 Tab 内新增三子 Tab（`data-testid="tool-subtab"` + `data-kind="builtin"|"custom"|"mcp"`）受控互斥切换（`useState<ToolTabKey>("builtin")`），删除平铺分组头（builtin-group/custom-group/mcp-group 的 GroupHeader 渲染与组件一并移除）。未改 _shared / 其他原型，零第三方库。
- **子 Tab 次级视觉**（对齐 worker-install install-method-tab 的 pill 容器范式但小一号）：外层 `neutral[100]` 容器 `padding:2 + radius.lg + alignSelf:flex-start`，按钮 `padding: xs+1 / md + fontSize.sm`（主 Tab 是 sm+1/lg + fontSize.md），active=白底 + shadow.sm + 字重 600，图标/计数 pill 用子 Tab 主题色（builtin 蓝 #2563EB / custom 紫 #7C3AED / mcp 青 #0D9488，复用既有 groupTheme token）。**主 Tab 大、子 Tab 小的层级通过 fontSize 与 padding 双降一档实现**，DOM 上主 Tab 是 manage-tab、子 Tab 是 tool-subtab，选择器互不干扰。
- **分组头复用改造**：原 groupTheme 对象不删，改供子 Tab 图标/计数色使用（`TOOL_SUBTABS` 数组引用 `groupTheme.*.icon/color`），避免新散落 magic number；分组 desc 文案弃用（子 Tab 行内放计数即可）。
- **保留字段**：builtin 子 Tab=开箱即用徽章（tool-ready）；custom=实现类型徽章（tool-kind：代码/HTTP/CLI）+ 依赖状态（tool-dep-status，jcli 未装 ⚠️）；mcp=<server>_<tool> mono 命名 + mcp-type（Local/Remote）+ mcp-status（已连接/未连接/连接中 ◐ 旋转）。tool-item 的 data-group="builtin"/"custom" 属性保留，playwright 可用 `[data-group]` 精确统计某子 Tab 行数而不用切 Tab。
- **验证（playwright 34/34 PASS）**：manage-tab=2（skill/tool）→ 切 tool → tool-subtab=3（kinds 全对）→ 默认 builtin（tool-item≥3，custom/mcp 隐藏）→ 平铺分组头 testid 全不存在 → 切 custom（tool-item≥3 含 jenkins-build + kind/dep 徽章，builtin/mcp 隐藏）→ 切 mcp（mcp-tool-item≥3 含 jira Remote + type/status 徽章，tool-item 隐藏）→ 切回 builtin 恢复 → 操作按钮随主 Tab（tool=register-tool-button+register-mcp-button / skill=upload-skill-button 互斥）→ manage-list/search-input 保留 → root position=relative → console 0 error。截图 `.omo/evidence/skills-tools-subtab.png`。
- **经验**：① 二 Tab 内嵌三子 Tab 时，子 Tab 容器需 `alignSelf:flex-start`（否则在 manage-list 卡片内被 stretch 撑满整行）；② 统计互斥列表用 data-group 属性（tool-item 与 mcp-tool-item 是不同 testid，但 builtin/custom 都是 tool-item，必须靠 data-group 区分）；③ 工具 Tab 内三来源平铺改子 Tab 后，NavDock children 的三来源计数仍保留作全局速览，与子 Tab 计数呼应不冲突。

## NavDock 导航体系扩展：4 项 → 6 项（workers / skills）（2026-08-06）

- **交付**：`prototypes/_shared/nav.tsx` 的 `NAV_ITEMS` 扩为 6 项（project▤ / board☰ / agents◉ / **workers⚙** / **skills◫** / messages✉），`DEFAULT_CMDK_ITEMS` 导航组同步 6 条（补 messages，新增 workers/skills，图标一致）。未改 NavDock 组件 API（activeKey/projectName/onNavClick/children）与 data-testid（rail-bar/rail-icon/rail-panel/nav-item/cmdk-item 全保留），零第三方库，仍 absolute + root relative + 零 fixed/vh/vw + minHeight:720。
- **各原型 activeKey 修正**（共 4 个）：worker-list / worker-install `"agents"→"workers"`；skills-tools-manage / tool-register `"agents"→"skills"`。其余 7 个业务原型不变（project-list=project / task-board=board / task-create=board / task-detail=board / group-chat=messages / dm-chat=messages / agent-config=agents）。同步更新 worker-list/worker-install 文件头注释（「Worker 属 Agent 运行节点域」→「Worker 运行节点域」）。
- **关键发现（CmdK 自定义 items 陷阱）**：8 个业务原型（worker-list/worker-install/skills-tools-manage/tool-register/agent-config/task-board/project-list/task-create）各自定义 `CMDK_ITEMS` 传给 CmdKPanel，**覆盖共享默认**——共享 `DEFAULT_CMDK_ITEMS` 只对未自定义的 group-chat/dm-chat/task-detail 生效。因此仅改共享默认**不够**：必须同步这 8 个页面的自定义导航组（补 Worker 节点/技能与工具/消息中心 3 条），并把 active 高亮归位（skills-tools-manage/tool-register 的 active 从 Agent 管理移到技能与工具）。worker-list/worker-install 此前已手工加过「Worker 节点 ⬢」→ 统一为共享 ⚙ 图标。
- **导航顺序决策**：project / board / agents / workers / skills / messages——业务流「项目→任务→Agent→运行节点→能力→消息」，agents 后紧跟 workers（运行域相邻），skills 居中，messages 殿后。
- **验证（playwright 48/48 PASS + 全量冒烟 11/11）**：6 个抽查原型（worker-list/worker-install/skills-tools-manage/tool-register/project-list/group-chat）rail-icon=6 且 keys=[project,board,agents,workers,skills,messages]、nav-item=6、activeKey 高亮精确（workers/skills/project/messages 唯一命中）、CmdK 导航组 6 条内容与图标全对、console+pageerror 0；全量 15 原型冒烟中 11 个业务原型 rail=6 + 0 error，login（无导航）/nav-hybrid/nav-cmdk/nav-rail（导航组件演示快照，内嵌历史 4 项副本，未引用共享 NAV_ITEMS）保持原样属预期。截图 `.omo/evidence/nav-6items.png`。脚本 `/tmp/opencode/nav_verify.py`、`/tmp/opencode/smoke.py`。
- **经验**：① 共享组件的「默认数据」常被页面自定义覆盖——改共享默认后必须 grep 各页面的自定义副本（`group: "导航"` / `items={...}`），否则验收项「CmdK 显示 6 个导航命令」在自定义页面上必然失败；② 演示原型（nav-hybrid/nav-rail）内嵌 NAV_ITEMS 历史快照副本，与共享层解耦，改动共享层不会自动生效，除非明确要求否则不动它们；③ Dock 高度适配无需调间距：收起态图标列 6×40 + 5×8 + 2×16 = 312px，展开态面板约 300px+children，均远小于 root minHeight 720——Dock 高度 auto 由内容决定。

## login 品牌区深色渐变 → 浅色毛玻璃主题（2026-08-06）

- **交付**：改造 `prototypes/login/index.tsx`（meta.id 不变，唯一文件），消除「左黑右白」对比怪象，与全站浅色毛玻璃主题（NavDock `rgba(255,255,255,.72)`）协调。未改 _shared / 其他原型，零第三方库。
- **配色改造（核心）**：品牌区背景 `radial-gradient(#1E293B→#0F172A→#0B1120)` 深色渐变 → 浅色毛玻璃线性渐变 `linear-gradient(135deg, rgba(255,255,255,.92) 0%, rgba(248,250,252,.85) 45%, rgba(239,246,255,.9) 100%)`（白→neutral[50]→蓝调 #EFF6FF 收尾），品牌蓝紫渐变 `linear-gradient(135deg,#3B82F6,#8B5CF6)` **仅保留在 Logo 方块作点缀**（尺寸 42→40、阴影减淡 `0 6px 18px rgba(59,130,246,.3)`）。文字全部由 sidebarTheme（深底白字）改 neutral 系：产品名 neutral[900]、价值主张 neutral[800]、副标题/列表/角色说明 neutral[500]/[600]、✓ 保持品牌蓝。全部复用 _shared/styles.ts token，零散落魔法色值。
- **左右分区**：品牌区桌面端 `borderRight: 1px solid neutral[200]`、移动端 compact 改 `borderBottom` 同色（居中分割线取代「一黑一白」的硬切）；右侧表单区原有 `radial-gradient(90% 60% at 50% 0%, #FFFFFF 0%, neutral[50] 70%)` 浅底不动，两侧同属浅色系。删除了 `sidebarTheme` import（该 token 是深色主题，登录页不再需要）。
- **保留**：表单（username/password/login-button/register-link data-testid）、移动端品牌区折叠为顶栏、四角色色点（色值不变，仅说明文字改中性色）。T15 铁律不变：minHeight:720、flex 布局、零 fixed/100vh/100vw。
- **验证（playwright ALL PASS）**：username/password/login-button/register-link 各 1 / 品牌区 `backgroundImage`=浅色 linear-gradient（getComputedStyle 断言非 #0F172A/#1E293B/#0B1120 系，backgroundImage 而非 backgroundColor，因是渐变背景）/ 品牌区 color=rgb(30,41,59)=neutral[800]、产品名=rgb(15,23,42)=neutral[900] 非白字 / 分割线 borderRight=neutral[200] 系浅色 / 表单区 main 背景=白→neutral[50] 径向渐变 / console+pageerror 0 / 无 fixed/vh/vw。截图 `.omo/evidence/login-light.png`。脚本 `/tmp/opencode/verify_login_light.py`。
- **经验**：① 验证「背景不再是深色」要断言 `backgroundImage` 而非 `backgroundColor`——渐变背景的 backgroundColor 恒为 transparent，getComputedStyle 只从 backgroundImage 能看到实际颜色；② 左区改浅色后右区「黑→白」反差不复存在，但两浅色块仍要靠 `borderRight: 1px solid neutral[200]` 细分隔，否则纯色块边界模糊；③ `text=...` locator 匹配到多个元素时 first 可能不是目标元素，断言文字颜色用 `closest div` 或直接查含该文本的 div（`[...document.querySelectorAll('div')].find(e => e.textContent.trim() === '...')`）更稳；④ 此改动让 login 成为纯浅色原型，与 nav 演示原型一样不再依赖 sidebarTheme 深色 token。

## 用户管理与权限设计原型：user-management + role-permission + 导航 7 项（2026-08-06）

- **交付**：`prototypes/user-management/index.tsx`（meta.id=user-management）+ `prototypes/role-permission/index.tsx`（meta.id=role-permission），均 device=desktop、`satisfies PrototypeDef`，复用 `../_shared/nav`（NavDock/NavTopBar/CmdKPanel）+ `../_shared/styles` token，未引第三方库。
- **导航体系扩展 6 项 → 7 项（users）**：`_shared/nav.tsx` 的 NAV_ITEMS 追加 `{ key:"users", label:"用户管理", icon:"☷" }`（末位，几何线条 unicode 与既有 6 项风格统一），`DEFAULT_CMDK_ITEMS` 导航组同步 7 条。**既有页不破坏**：worker-list 抽查 rail-icon=7 + active 仍为 workers + users 图标存在不高亮 + worker-card 未回归。未动其他页面自定义 CMDK_ITEMS（MUST NOT 约束），仅共享默认同步。
- **user-management 结构**：root（height:100% + minHeight:720 + relative）→ NavTopBar `title="用户管理"` → 统计条（user-stats：总用户/管理员/成员/已禁用，蓝/绿/绿/红）→ 操作行「新增用户」（add-user-button 蓝实底）→ 用户列表卡（表头 + 5 行 `user-item`[data-user-id][data-status]：1 管理员 + 3 成员 + 1 禁用）：头像（角色色圆）+ 用户名（mono）+ RoleBadge（user-role-badge：管理员蓝◈/成员绿●）→ 邮箱 → 所属项目数 → StatusBadge（user-status-badge：启用✅绿/禁用⛔红）→ 操作（编辑/禁用·启用/重置密码，**禁用按钮点击本地翻转状态**演示）。底部 user-pool-hint 说明「仅项目」组织模型（02 篇 1.1/1.2）。NavDock activeKey="users"；CmdK 受控关闭。
- **新增用户弹层（user-form）**：受控开关（formOpen 默认 false，点 add-user-button 打开，✕/遮罩/Esc 关闭），`position:absolute; inset:0; zIndex:60`（高于 Dock z-50 / CmdK z-40）+ 居中 520px 白卡（毛玻璃阴影 shadow.lg）。字段：username-input / user-email-input / user-password-input / user-role-select（管理员·成员 受控双按钮）/ user-project-select（项目 chips 多选受控 toggle，默认勾选一项）/ user-form-submit 创建 + user-form-cancel 取消。表单 `onSubmit={e => e.preventDefault()}` 防提交刷新。
- **role-permission 结构**：NavTopBar `title="角色与权限"` → 内容 flex row：左 240px 角色列表（3 个 `role-item`[data-role=admin|member|custom] 受控切换，图标色块+角色名+「N 项允许 · 角色模板」副文案 + 底部 add-role-button 虚线）→ 右权限配置面板：当前角色标题（图标+label+desc 对齐 02 篇 1.1/1.2）→ **权限矩阵**（permission-matrix 表格：8 资源行 [任务▤/群聊✉/产出物▦/Agent 配置◉/Worker 节点⚙/技能工具◫/用户管理☷/权限配置◈，对齐业务原型域] × 6 操作列 [查看/创建/编辑/删除/验收/管理]，格 `td[data-perm]`=✓ 允许绿/◐ 部分琥珀/✗ 禁止灰，`table`+`thead` 语义表格，PermLegend 图例条）→ **权限范围**（permission-scope：适用范围 global/projects 受控双按钮 + 指定项目 chips 多选 + 项目内角色 chips 多选，随角色 mock 数据不同）→ permission-note 蓝条「平台权限与 opencode 权限相互独立 · 平台权限管『用户能操作什么』，opencode 权限管『agent 能做什么』（PermissionV2 Ruleset）」。
- **权限 mock**：admin=8×6 全 allow（48）；member=任务(查看/创建/编辑/验收 ✓ 删除✗)、群聊/产出物(部分◐)、用户管理+权限配置全 ✗（29 deny/8 partial/11 allow）；custom 介于两者。验证断言 admin 默认 48 allow → 切 member 出现 deny+partial 且用户管理行全 deny。
- **⚠️ useState 初始值陷阱（本次踩坑）**：`PermissionScope` 内部 `useState(def.scope.global ? "global" : "projects")` 只在**挂载**时取初始值——页面初始 activeRole=admin（global）挂载后，切 member 组件不重挂载，scopeType 仍停留 global，导致「member scope 指定项目 active」断言 FAIL。**解法：`<PermissionScope def={def} key={def.key} />` 用 key 强制角色切换时重挂载**，初始值随新 def 重置。通用教训：子组件初始 state 依赖父级 props 且需随 props 变化重置时，用 key 重挂载是最零侵入方案（比 useEffect 同步干净）。
- **验证（playwright 55/55 PASS，首跑 54/55 修复 key 后全绿）**：user-management 24 项（root/rail-icon=7 含 users 序末位/nav-item=7/Dock active=users×2/user-item=5≥4/add-user-button/user-stats/角色+状态徽章双覆盖/user-form 初始 0→点开→字段 6 个+submit→角色切换→✕ 关闭/fixed 元素=0/vh·vw=0/console 0 error）+ role-permission 25 项（root/rail=7/active=users/role-item=3 含三 key/matrix=48 格/admin 全 allow/scope 双按钮+项目+内角色/note 含相互独立+用户能操作什么/member 切换后 deny=29+partial+用户管理行全 deny/scope 指定项目 active/切全局/fixed=0/vh·vw=0/console 0 error）+ worker-list 抽查 6 项（rail=7/nav-item=7/active 仍 workers/users 不高亮/worker-card≥3/console 0）。截图 `.omo/evidence/user-management.png`（215KB）/ `role-permission.png`（178KB）非空。脚本 `/tmp/opencode/verify_user_permission.py`。
- **经验**：① 平台管理类页面（user-management/role-permission）同属「users」导航域，activeKey 一致，与既有 workers/skills 域划分同理；② 弹层类 UI 沿用 T19 CmdKPanel 受控开关心智（默认关闭 + 三关闭路径），zIndex 需高于 Dock（50）与 CmdK（40），取 60；③ 权限矩阵用原生 `<table>` + `thead/tbody` 语义结构，48 个 `td[data-perm]` 可被 playwright 精确计数断言，比 div 网格更稳；④ `onSubmit preventDefault` 让表单按钮 type=submit 可点击但不刷新页面（纯展示原型）；⑤ 源码 grep `fixed|100vh|100vw|\bvh\b|\bvw\b` 仅注释铁律说明命中（T15 合规），LSP 未安装（typescript-language-server 缺失），以 @fs 编译 200 + playwright 兜底验证（learnings 既有记录）。

## 用户管理与权限设计补进 PRD：02/03/06 篇（2026-08-06）

- **交付**：`docs/agent-platform/02-用户与场景.md` + `03-功能需求-任务与群聊协作.md` + `06-交互与页面设计.md`（仅 3 篇，01/04/05/07 与原型未动），对应新增原型 user-management / role-permission。
- **02 篇**：新增 1.4 用户与权限模型小节（平台权限「用户能操作什么」≠ opencode 权限「agent 能做什么」，PermissionV2 Ruleset，两条链路独立互不干扰）+ US-13 用户管理 / US-14 权限控制（编号接 US-12，US-01~14 连续）。用户故事引言补「用户管理与权限控制等衍生故事」。
- **03 篇**：功能域「四个→五个」（新增用户与权限）；末尾新增第 5 章 FR-22 用户管理（P0：新增/编辑/禁用/重置密码/分配角色管理员·成员/所属项目）/ FR-23 角色权限矩阵（P0：8 资源×6 操作 ✓/◐/✗，资源对齐业务原型域）/ FR-24 权限范围（P0：全局/指定项目多选/项目内角色）+「平台权限与 opencode 权限的边界」小节 + 2 个 ```prototype 内嵌块（user-management/role-permission, height 720）。FR-01~24 连续无缺。
- **06 篇**：计数 8→10 联动改点清单（frontmatter description / 开篇「全文覆盖」/ 页面总览导语 / 一致性约定 / 收尾段 共 5 处）+ 页面总览表追加 2 行（user-management 侧边栏「用户管理」、role-permission 侧边栏「用户管理」→「权限配置」）+ 新增 2.9/2.10 小节（各含用途/入口/关键交互锚定 FR-22/23/24 + prototype 内嵌块）+ mermaid 补旁路（项目列表-.->用户管理页-.->角色与权限页）+ 流转要点新增管理入口条。
- **验证**：curl 5177 content 三 key 命中；grep 断言 US-01~14/FR-01~24 连续无缺、关键词（用户管理/权限矩阵/权限范围/US-13/FR-22/23/24/边界）全命中；`npx md-docs build --out-dir /tmp/site` EXIT:0。证据 `.omo/evidence/update-users-permission.md`。
- **经验**：① 「N 个页面」是联动改点，增页须全文 grep `8 个|八个` 逐一更新（本次 5 处）；② 新功能域在 03 篇开头功能域清单与文末章节两处同步，避免只加章节漏改导语；③ 权限模型表述以原型 permission-note 为锚（平台权限管用户能操作什么 / opencode 权限管 agent 能做什么），02/03/06 三处措辞一致；④ 原型内嵌块沿用 3 反引号 + id/title/device/height 语法（learnings T12/T19 记录），height 720 与 T21 对齐。

## agent-config ④ 工具配置区重构：工具(action) × effect(allow/ask/deny)

**变更**：删除旧「工具 × 读取/写入/执行」PermissionMatrix 表格（TOOL_ACTIONS 常量 + table 组件整体移除），改为「每个工具 = 一个权限点」模型，对齐 opencode PermissionV2（action=工具名 + effect∈{allow,ask,deny} + 通配符）。

**新结构**（全部在 agent-config/index.tsx 单文件内）：
- `toolPermissions` mock ×5：read=allow、write=allow、bash=ask、jenkins-build=ask、jira_query=allow（read/write/bash=内置，jenkins-build=自定义，jira_query=MCP 即 <server>_<tool>）
- `toolEffectMeta`：allow=绿/无需确认·只读低风险、ask=琥珀/每次确认·有副作用、deny=红/白名单排除（配色与 statusColors 同构）
- `toolSourceMeta`：内置=蓝、自定义=紫、MCP=青 来源徽章
- `ToolPermissionList` 组件：每工具一行 = tool-toggle-item 启用开关（停用=对 agent 不可见，行 opacity 0.62）+ mono 工具名/来源徽章/effect 说明 + tool-effect-select 三态 segmented（data-effect=allow/ask/deny，aria-checked）
- 通配符行 tool-wildcard-row：虚线卡片 `jenkins-* → ask`，说明可批量授权同类工具
- ④ 区头部新增权限点提示行：「工具名即权限 action（如 jenkins-build），支持通配符批量授权（如 jenkins-*）」

**验证**：playwright 22/22 PASS（tool-permission-item=5 且每项三态齐全、mock effect 逐一匹配、通配符行存在、旧表头 th=0、table=0、保留 7 个既有 data-testid、无 fixed/vh/vw、console 0 error、minHeight 720）。截图 `.omo/evidence/agent-config-tool-permission.png`。

**经验**：opencode v2 权限模型 action 为自由字符串（非枚举），工具注册时 action=工具名（bash.ts 源码 `action: name`）；UI 上「选择工具后再配权限点」= 每工具独立选择 effect，而非工具×操作二维矩阵。

## 工具权限模型同步进 PRD：03/04/07 篇（2026-08-06）

- **交付**：`docs/agent-platform/04-功能需求-Agent与产出物.md` + `03-功能需求-任务与群聊协作.md` + `07-opencode-v2-调研与架构决策.md`（仅 3 篇，01/02/05/06 与原型未动），把 agent-config 原型已实现的工具权限模型（learnings 前条）落到 PRD。
- **04 篇**：FR-35 工具配置细化（启用开关 + 每工具独立 effect allow/ask/deny；工具名即权限 action 如 jenkins-build；通配符批量 jenkins-*）；新增 FR-48 工具权限（编号续 FR-47 后：权限点=工具名开放命名空间、effect 三态、有副作用工具默认 ask、来源徽章内置/自定义/MCP、通配符）；FR-36 权限范围补充与工具权限的关系（工具权限=每工具 effect / 权限范围=资源范围，正交叠加生效）；配置面板说明补 FR-35/FR-48。FR-30~48 连续无缺。
- **03 篇**：FR-23 角色权限矩阵补充「技能工具」资源行含工具级权限（每工具=权限点 action；工具内部执行策略不属平台矩阵，由 Agent 侧逐工具 effect 配置，见 04 篇 FR-48）。FR-01~24 连续（FR-48 仅交叉引用）。
- **07 篇**：新增 3.1 小节「工具权限模型（PermissionV2）」——权限点是开放命名空间非固定枚举（内置 bash/read/edit 枚举，但工具注册自动以名字成为新权限点，源码 `action: name`）；effect∈{allow,ask,deny} + 通配符（Wildcard jenkins-*）；与 PermissionV2 对齐（action 自由字符串 schema `Schema.String` 非枚举）；权限链路 = 创建工具定能力+默认权限 → agent-config 逐工具配 effect → 运行时按 effect 放行或 request→reply 确认（呼应第 3 章 Permission 交互正式化）。
- **验证**：curl 5177 content 三 key 命中；04 篇 FR-30~48 / 03 篇 FR-01~24 编号连续；grep 7 关键词（权限点/effect/allow/ask/deny/通配符/FR-48）均 3/3 篇命中；`npx md-docs build --out-dir /tmp/site` EXIT:0。证据 `.omo/evidence/update-tool-permission-docs.md`。
- **经验**：① 07 篇原稿用「Wildcard 通配」未含「通配符」字面，grep 断言差一篇——断言关键词要按验收字面统一，文档中尽量用同一术语（通配符），英文术语作括注；② md-docs build 必须在含 `docs/` 的目录运行（本项目即仓库根），`cd docs/agent-platform` 后 build 会报「未找到 docs 目录」；③ 03 篇的 FR-48 是交叉引用（04 篇的 FR），按文档标题精排排序 grep 时会被算进 03 篇编号集合，断言连续性需区分「本页编号」与「交叉引用」。

## 需求层评审修复：05/06/03 三篇严重问题（2026-08-06）

- **背景**：需求层评审（S1/L4 + S2 + S3）指出 3 项严重问题：05 篇验收边界与实际交付脱节（6 篇文档/8 原型 → 实际 7 篇文档/17 原型）、06 篇页面清单与 05 篇口径不一致（表内 10 页 vs 17 原型）、03 篇 FR 编号乱序（FR-01~05 → FR-17~19 → FR-06~16 → FR-20~24）。
- **03 篇 FR 重排映射**（旧→新）：FR-17→06 背景文档上传 / FR-18→07 启动流程 / FR-19→08 主Agent / FR-06→09 群聊 / FR-07→10 消息模型 / FR-08→11 定向@ / FR-09→12 @all / FR-10→13 互@ / FR-11→14 共用会话 / FR-12→15 上下文注入 / FR-13→16 分层 / FR-14→17 实时查看 / FR-15→18 不广播 / FR-16→19 持久化 / FR-20/21 恰好不变 / FR-22~24 不变（保 04 篇 FR-48 引用不失效）。重排后 FR-01~24 连续无跳号。
- **交叉引用同步的 3 个层面（易漏）**：① 03 篇正文内部引用（10 处：FR-01 见 FR-06、FR-03 见 FR-07、背景文档随 FR-15、启动见 FR-08、主Agent 见 FR-07、消息模型 2 处见 FR-18、段落 FR-14、持久化既 FR-15、Loading 见 FR-10/FR-17）；② 06 篇对 03 篇 FR 的引用（8 处：FR-08→11 / FR-09→12 / FR-07→10 / FR-14→17 / FR-11→14 / FR-10→13 / FR-12→15 / FR-15→18）；③ 04 篇引用（FR-31/39~46/48 一律不动，04 篇编号独立）。
- **05 篇 3.1 口径修正**：6→7 篇文档（补 opencode v2 调研与架构决策）、8→17 原型（补 worker-list/worker-install/skills-tools-manage/tool-register/user-management/role-permission/nav-rail/nav-cmdk/nav-hybrid，device: desktop + height: 720）、共享组件描述改「覆盖全部原型」、结尾说明段重写。
- **06 篇口径统一手法（最小侵入）**：页面总览表主体不动，表后新增「### 页面范围与 05 篇 17 个原型的关系」说明段——8 核心协作 + 平台管理（用户管理/角色权限）+ Worker/能力管理（Worker 列表/新增 Worker/技能工具/注册工具），口径 8 核心 + 9 管理/工具 = 17 原型，3 个导航方案原型为设计演进存档不计入业务页面。
- **验证**：curl 5177 content 端点命中 03/05/06 三 key；grep 05 篇「17 个原型」4 处；grep 03 篇 `^### FR-` 输出 01~24 连续；md-docs build 退出码 0。证据 `.omo/evidence/fix-severe-doc-issues.md`。
- **教训**：文档间 FR 交叉引用是多向的（03 篇被 06 篇消费、03 篇引用 04 篇），重排编号时必须把「下游消费方」一并 grep 检查，否则会产生新的引用失效；改动前先 grep 全量 FR 引用点建立映射表再动手。

## 修复 03 篇 5 项 🟡 需求闭环问题（M1~M5，2026-08-06）

- **交付**：`docs/agent-platform/03-功能需求-任务与群聊协作.md`（唯一文件，01/02/04/05/06/07 与原型全不动）。5 项全按「细化现有 FR」落地，未新增 FR 编号，FR-01~24 保持连续。证据 `.omo/evidence/fix-medium-doc-issues.md`。
- **落点与写法**：M1 主Agent职责 → FR-08 追加「职责边界」小节（协调权基于 FR-13 / 推进职责沿 FR-07 / 兜底沿 FR-21 / 不越权验收沿 FR-04）；M2 待验收触发 → FR-03 表格「待验收」进入方式改「成员手动标记，Agent 不自动触发」+ FR-04 追加「进入待验收」（主验收人核对文档库后手动标记，比自动判定可控）；M3 互@循环 → FR-13 追加「互 @ 循环控制」（3 轮上限提示「协作轮次已达上限，请成员介入」+ A→B→A→B 循环检测 + 成员可插话破环）；M4 版本验收联动 → FR-04 追加「版本与验收联动」（验收基线记录「已验收版本」/ 验收后 Agent 出新版本任务自动退回进行中 / 已验收版本不可覆盖只可新增，引 04 篇 FR-43）；M5 团队调整 → FR-02 追加「进行中团队调整」（添加 Agent 注入文档库上下文沿 FR-15 / 移除 Agent 产出保留会话冻结 / 系统消息提示沿 FR-10）。
- **⚠️ 编号映射坑**：任务描述里的旧编号（M1「FR-06 主Agent」、M3「FR-10 互@」、M5「FR-12 注入」）是重排前的编号，实际当前文件是 FR-08 主Agent / FR-13 互@ / FR-15 注入。**必须先 read 当前文件核对编号再动手**，正文引用一律用当前文件实际编号，否则造成错引。
- **验证方式（5/5 PASS）**：① 注入端点 grep 03 key 命中；② 03 篇内关键词断言 职责边界=1/牵头=5/待验收=4/主验收人=1/手动标记=2/轮次=1/循环=3/已验收版本=2/团队调整=2 全命中；③ 编号连续性用 `grep -oE '^### FR-[0-9]+'`（只匹配标题行，避免把正文交叉引用 FR-43/FR-48 误判为缺号——03 篇正文引 04 篇 FR-43/FR-48 是合法交叉引用）；④ `md-docs build --out-dir /tmp/...` 退出码 0。
- **经验**：①「细化现有 FR」路线 = 在 FR 正文后追加带粗体小标题的段落（**进行中团队调整。**/**职责边界。**/**互 @ 循环控制。**/等），小标题格式与既有 FR 内小节（如 FR-10 的「消息内容类型（Part）」）保持一致；② 状态机表格行的修改是精确单行替换，改动最小且不丢列；③ 编号连续性验证必须区分「本篇定义 FR」与「跨篇引用 FR」，用 `^### FR-` 前缀匹配标题行即可。

## 修复需求层评审 🟢 3 项轻微问题（2026-08-06）

- **交付**：01/02/03 三篇各一处修改，未动 04/05/06/07 与原型。证据 `.omo/evidence/fix-minor-doc-issues.md`。
- **L1 三种角色统一（02 篇）**：1.4 后新增 `### 1.5 三种角色的关系`。三套角色并行不冲突——平台角色（管理员/成员）管「能否进平台/管理域」、项目内分工（产品/架构/开发/测试）管「项目里干什么」、自定义角色（验收员/运维专员）是前两者的组合扩展（按岗位组合权限）。文末引 03 篇 FR-23/FR-24 作锚点。
- **L2 项目生命周期（02/03 篇）**：02 篇追加 US-15（As a 平台管理员或项目成员 → 创建项目并将成员加入 → 协作有边界、任务归属明确）；03 篇 FR-24 后追加 FR-25（P0，项目创建/成员管理/项目内权限 + 与 FR-01/FR-22/FR-24 衔接），**追加在末尾不重排**，FR-01~25 保持连续。组织模型严格对齐「仅项目」，未引多租户/组织层级。
- **L3 开发阶段 vs 仓库操作边界（01 篇）**：非目标「不做仓库操作」条目下加三条子说明——① 平台产出代码文件在范围内（Agent 生成代码以产出物归档，引 04 篇产出物协议）；② 不操作代码仓库在范围外（提交/分支/PR/CI/CD 留后续迭代）；③ 「开发阶段」= 产出实现代码与实现说明，不含合并回仓库流程。
- **验证方式（4/4 PASS）**：① 注入端点 grep 3 个 key 全命中；② 本地 grep 断言 02 篇「三种角色」=1 +「平台角色/项目内分工」各 3、03 篇 FR-25 标题命中、01 篇三条子说明命中；③ 编号连续性用 `grep -oE 'FR-0[1-9]|FR-1[0-9]|FR-2[0-5]' | sort -u` 核对 25 个全齐；④ `md-docs build --out-dir /tmp/site-fix`（需在 docs/ 上级目录运行）退出码 0。
- **经验**：① 追加新编号（US/FR）一律只追加末尾，先 read 核对当前最大编号（US-14/FR-24）再递增；② 角色关系类说明放权限模型小节后独立成小节（1.5），保持表格简洁；③ 非目标条目下用缩进子列表补充边界，不改既有条目措辞、不破坏原编号列表结构。

## [2026-08-06] Oracle Round 2 文档修复（12 项）落地要点

- **待开始五态统一是跨篇联动**：06 篇 §2.3/§2.4/§3.4、05 篇 §3.2、02 篇 US-06 五处需同步，单篇改不闭环。FR-03 是唯一状态机权威定义，其余篇以它为准。
- **权限模型一致性**：06 篇 §2.8「四块 + 读取/写入/执行矩阵」是 04 篇 FR-35/FR-48（启用开关 + effect 三态 + 通配符）的旧版残留，修复时以 04 篇为权威源。
- **FR 编号断链补法**：worker-list/worker-install/skills-tools-manage/tool-register 4 原型原本无需求定义，补 FR-26/27 时「追加末尾 + 新 §6 + 原型内嵌」三点齐做，且要与 FR-23 权限矩阵的 Worker 节点/技能工具资源行互证。
- **FR-47/48 编号乱序的处理决策**：重排为 FR-30~49 连续不可行（04 篇只有 19 个 FR），采用「不动编号 + 编号约定说明」，避免连锁破坏 03/06/07 篇交叉引用。教训：编号乱序时先数总数再决定重排可行性。
- **边界类需求（删除/撤回）**：统一用「**本版边界：…**」加粗前缀段落嵌入现有 FR 末尾，与 FR 正文区分，闭合状态机避免 FR-23 删除操作列悬空。
- **07 篇 FR 引用修正需先 grep 03 篇**：mentions→FR-11/FR-13、abortSession→FR-21/FR-10、消息模型→FR-10/FR-21、中断语义→FR-21，以 03 篇当前编号为唯一事实源。
- **06 篇页面数联动**：新增 §2.11/§2.12 后，frontmatter description、§1 总览表、「页面范围与 05 篇 17 原型的关系」、§4 mermaid 流转图、§5 一致性约定（10→12 个页面）必须同步更新，否则口径不一致。
- **原型 mock 冲突不改原型**：agent-config 含「写入仓库/提交代码」与 01 篇非目标冲突，仅记录 issues.md，改原型需走 visual-engineering 任务（本任务职责边界）。

## 2026-08-06 Round3 尾留问题修复（N1/N2/N3）
- FR-23 权限矩阵「删除」为通用模板：矩阵内删除操作需声明适用范围，对不可删资源（任务 FR-03/消息 FR-19/产出物 FR-43）一律 ✗，避免矩阵与边界声明矛盾
- 文档数字一致性：改页面数时需同步检查正文、description frontmatter、开头综述三处（06 篇"10 个核心页面"残留即为此类遗漏）
- §3.2 完整平台功能清单需与 FR 清单同步：新增 P0 功能域（FR-26 Worker 管理/FR-27 技能工具）后必须回补功能清单表格
- 验证链路：grep 断言 → curl @id/__x00__virtual:md-docs-content 注入 key → md-docs build exit=0，三者齐备才算闭环

## 2026-08-06 基础功能完整性扫描 → 下一版增强项（05 篇 3.4）
- 决策：G1-G18 基础功能缺失项不列入第一版 FR，作为「下一版增强（已确认方向）」写入 05 篇 3.4
- 3.4 重组为两子分组：「范围外（后续迭代）」7 项原样保留 +「下一版增强」10 项（通知推送/全局搜索/会话断点续接/审计日志/群聊成员管理/任务模板/消息回复引用/看板拖拽批量/数据导出/体验优化）
- 每项仅一句话说明，不做设计；末尾注明「本版不做设计与排期」
- 验证：curl 5177 注入 10 关键词全命中 + md-docs build exit=0；证据 .omo/evidence/update-next-version-enhancements.md

## T19 平台架构设计（08 篇，2026-08-06）

- **交付**：`docs/agent-platform/08-平台架构设计.md`，frontmatter `title/id/order/kind/description`，order=8、kind=技术设计。完整平台技术设计第一篇，架构级（选型/模块/拓扑/数据/决策），无实现代码（反断言 CREATE TABLE/SELECT/npm install 全 0）。
- **结构与 07 篇衔接**：9 章 = 定位与文档关系 / 技术栈选型 / 控制面模块划分 / Worker 节点承载 / 组件拓扑 / 数据模型 / 关键设计决策 / 本版 vs 下一版增强 / 风险。§1 用「继承表」逐条映射 07 篇基线（控制面/数据面分离、不直连 opencode、Driver 抽象、每任务组一实例），显式声明"落地化非推翻"。
- **技术选型结论**：NestJS 10（模块化映射控制面模块划分 + 内置 @Sse/管道，对比 Express 需自建分层、Fastify 基建薄）；TanStack Query v5 + Zustand v5；**实时统一 SSE**（与 worker→控制面通道同协议 + EventSource 自动重连 + 事件 id 游标续拉，WebSocket 双向留下一版）；Prisma 5+（双库兼容：**字符串枚举 + Json 列**规避 SQLite 无原生 enum）；JWT + bcrypt；pino；**首版不引入 Redis/BullMQ**（单机进程内队列 + QueuePort 抽象，分布式再换）。
- **关键设计决策模板**（可复用于后续技术文档）：① 首期单机但**仍走 HTTP/SSE 控制协议**（07 篇 11.7：单机≠进程内直连）；② SSE 游标续拉（事件带递增 id，断线 REST 补拉）；③ 会话流链路 worker SSE→控制面幂等落库→前端 SSE（落库后转发，保证可恢复）；④ 状态机「服务层校验→同事务落库（tasks.status + task_events）→广播 SSE」三段式；⑤ worker 事件 `(instance_id, event_id)` 唯一约束幂等，为自愈重调度铺路。
- **数据表划分 21 张**：任务域含 task_events（状态机事件日志）、产出物域 artifact_versions.accepted_flag（验收基线 FR-04/43 联动）、Worker 域 task_group_instances（任务组→实例映射，07 篇 TaskGroupRegistry 控制面侧）；audit_logs 仅预留不建（下一版）。
- **验证方式**：content 注入端点 grep 命中 08 key（count=1）+ md-docs build `--out-dir /tmp/site` EXIT:0 + 本地断言（9 章连续 / 18 个关键选型模块表断言 / ASCII 47 行 / 反断言 0）。证据存 `.omo/evidence/architecture-design.md`。
- **复用经验**：① 技术设计文档与 PRD 的差异点在「反断言」——架构文档允许类型签名/接口示意，但不允许 DDL/SQL/安装命令，用 grep 反断言兜底；② 与前置架构基线（07 篇）的一致性用「继承表 + 章节级对应锚点」显式固化，避免评审时被质疑推翻基线；③ FR 引用必须核对编号（03 篇 01~27 / 04 篇 30~48，04 篇有 FR-47/48 补充编号不按序）。

## T19 补充：08 篇第 5 章 mermaid 组件拓扑图（2026-08-06）

- **交付**：08 篇 §5 组件拓扑新增 mermaid 正式图（`flowchart TB` 三层：Web 前端 → 平台服务端控制面 → Worker 节点池），原 ASCII 图保留作补充参考；图后加 3 条「关键数据流」图例（前端↔控制面 REST+SSE / 控制面→Worker HTTP / opencode 铁律链）。
- **mermaid 语法坑（本次踩坑）**：`A <--|"text"| B`（反向箭头带 label）**不被 mermaid 解析**，报 `Parse error ... Expecting 'LINK','UNICODE_TEXT','EDGE_TEXT', got 'STR'`。修法：一律按数据流方向写正向 `A -->|"text"| B`（如 `I1 -->|"SSE：..."| FE_SSE` 表达控制面推前端）。`<-->` 双向无 label 合法，subgraph 可作为边端点、subgraph 内嵌 `direction LR/TB` 均正常。
- **md-docs mermaid 渲染容器（选择器关键）**：md-docs 渲染出的 mermaid 图**不是** `<div class="mermaid">` 而是 `<svg class="flowchart" id="mmd-..." aria-roledescription="flowchart-v2">` 包在 `<div class="flex justify-center">` 内。断言选择器用 `svg.flowchart` 或 `svg[aria-roledescription^='flowchart']`（`.mermaid` 容器计数为 0，勿用）。svg 是 SVGElement 非 HTMLElement，取文本用 `text_content()` 而非 `inner_text()`（会报 Node is not an HTMLElement）。
- **验证（10/10 PASS）**：playwright（headless shell 1208）直达 `#/p/agent-platform/docs/platform-architecture` 轮询 `svg.flowchart`（最多 15s）→ count=1 + svg text_content 含 10 个关键节点文本（Web 前端/平台服务端/Worker 节点池/WorkerServer/WorkerRuntime/opencode/Worker 控制协议/REST /api/v1/RealtimeModule/WorkerSseClient）+ 正文 4 个 marker + console 0 error。截图 `.omo/evidence/architecture-mermaid.png`（元素截图 52KB，svg 高 2827px）。build `--out-dir /tmp/site-arch` EXIT:0，产物 js 含「正式组件拓扑图」。
- **复用经验**：① 组件拓扑图节点用「前缀 + 语义名」（FE_/A/BIZ/WK/INFRA/DB/WS/TGR/RT/OC）防 id 冲突；subgraph 标题与含 `（）/` 的 label 一律双引号包裹；边 label 用 `|"..."|`。② 铁律可视化 = 画「控制面 WorkerClient →(HTTP)→ WorkerServer → TaskGroupRegistry → WorkerRuntime →(spawn)→ opencode」链且不画控制面-opencode 直连，比文字更有说服力。③ mermaid 渲染异步，playwright 需 wait_for_selector/轮询而非 goto 后立即断言。
- **三级 SSE 链路（本次定稿，08/09 篇）**：① 模型输出流（opencode 内部，worker 内捕获）≠ ② worker→控制面 SSE（07 篇 11.3，引擎事件，WorkerSseClient 订阅）≠ ③ 控制面→前端 SSE（09 篇 §4，业务事件，前端 EventSource）。②③ 是不同连接但事件帧格式同构（{id,type,data,timestamp}），构成「一套事件基座」。RealtimeModule 做「消费→幂等落库→语义转换（引擎事件→业务事件）→按订阅者转发」，非透传（FR-18 思考/工具仅按需给 sessions/:id/stream）非另起一套（③ 复用同一帧格式）。
- **文档落点**：08 篇 §7.2 后新增 `#### 7.2.1 三级 SSE 链路`（mermaid flowchart TD：① subgraph → ② WorkerSseClient → RealtimeModule 消费链 → ③ EventSource，边 label 标注事件类型与方向）；09 篇 §4 开头、4.1 前新增无编号 `### 三级 SSE 链路总览`（三级参数表：通道/协议/事件类型/消费动作，明确 §4 定义第③级契约、② 消费表关联 §4.3），不重复 mermaid。
- **mermaid 复用经验**：flowchart 的 subgraph 标题与含中文/斜杠 label 一律双引号包裹；方向用正向 `A -->|"text"| B`（勿用反向 `A <--|"text"| B`，会 Parse error）。本图 4 节点 3 边，build 1.27s 通过。
- **验证**：md-docs build EXIT=0；grep 断言 08 篇含「三级 SSE 链路」、09 篇含「第③级」；bundle 注入 dist/assets/index-wQSPf5QT.js 五 key 全命中。证据 `.omo/evidence/sse-three-tier.md`。

## 09 篇 §5.4 产出物收集链路补充（2026-08-06）

- **交付**：`docs/agent-platform/09-API设计.md` 新增 `### 5.4 产出物收集链路（FR-38~41/43）`（插在 §5.3 之后、§6 之前），回答「模型产出文档之后如何收集」：事件驱动回流（Agent json_schema 产出 FR-38 → worker SSE task.completed / message.part.delta 回流 → 控制面 ArtifactsModule 校验归档 → append 版本 FR-43 + 广播 artifact.submitted）。
- **产出物分流**：结论文本直接归档（FR-40，text part 在 task.completed payload，无需额外拉取）；文档/文件平台拉取（FR-41，file part 带 url 指向 worker 工作区，控制面经 WorkerClient 调 `GET /worker/:id/files/:path`）。该端点在 Worker 控制协议（07 篇 11.3）**不对前端暴露**，前端只能走 §3.6 REST 端点取已归档内容（两套边界，§6）。
- **重拉机制（FR-41 不产生不完整归档落地）**：控制面记 pending artifact（文件引用+重试状态）→ 指数退避重试默认 3 次（2s/4s/8s，可配）→ 仍失败标记「拉取失败」，产出保留 worker 会话、事件不写 artifacts 表 → 会话/任务恢复可重拉。
- **大文件**：默认 50MB 可配；超限仅记文件引用元数据入文档库，文件留 worker 工作区或异步流式拉取（分片边拉边存），对接 05 篇 3.3 对象存储预留接口。
- **幂等**：同一 file part 重复消费不重复归档，以 file part id / 内容 hash 去重（对齐 08 篇 §6.3 worker 事件幂等；09 篇 §4.3 消费表用 (worker_id, event_id) 表述，08 篇 §6.3 用 (instance_id, event_id)，引用时以「08 篇 §6.3 + 本文档 §4.3」并提避免歧义）。
- **验收联动**：归档后广播 artifact.submitted；已验收任务 Agent 新增产出物版本 → 任务自动退回进行中（FR-04「验收后更新」）；已验收产出物提交新内容 409 ARTIFACT_ACCEPTED_IMMUTABLE（§3.6），只能 append 新版本。
- **验证**：grep 断言 8 关键词全命中（产出物收集链路/文件拉取/重拉/大文件/幂等/GET /worker/:id/files/:path/pending artifact/ARTIFACT_ACCEPTED_IMMUTABLE）+ md-docs build exit=0 + curl 内容注入端点命中 09 key 及新小节文本（watcher 热加载即时生效）。证据 `.omo/evidence/artifact-collection-chain.md`。
- **经验**：验证 grep 关键词要按任务原文逐个核对字面出现（本任务「文件拉取」最初写成「经 worker 拉取」字面不命中，把小节标题改为「文件拉取端点：…」即命中）；mermaid 时序图与 §5.1 风格统一用 sequenceDiagram + alt 分流分支。
