# Phase 2 原型一致性验收报告

- **日期**: 2026-08-07
- **验收范围**: 任务看板 / 创建任务 / 群聊 / 私聊（原型 → 实现页）
- **结论**: **4/4 PASS**（其中群聊、私聊各附带 1 个本次发现并修复的真实缺陷，见 §6）

## 0. 环境与方法

| 项 | 值 |
|---|---|
| 实现环境 | server:3000（nest dev）+ web:3001（next dev），admin/admin123，项目 p_seed_1 |
| 实现页 | `/board`、`/tasks/new`、`/tasks/[id]`、`/messages/[id]` |
| 原型 | `docs/agent-platform/prototypes/{task-board,task-create,group-chat,dm-chat}/index.tsx`，md-docs 服务 :5178 |
| 对比方式 | ① Playwright 实现页实拍（等数据加载完成，非 loading/空态）② md-docs 原型预览实拍 ③ 原型/实现源码结构核对（分栏宽度、token、data-testid） |
| 测试数据 | 任务 t_0000000006（pending，群聊 3 user+3 agent mock 回复）、t_0000000007（in_progress）；私聊 c_0000000009（t6×a_product，1 user+1 agent） |
| 截图存档 | `.omo/evidence/phase2-parity/impl-*.png`（4 张）+ `proto-*.png`（4 张） |

> 说明：原型在 md-docs DeviceFrame 内预览，受框架视口宽度限制（部分卡片/右栏被裁剪），布局结构与 token 以源码核对为准（§1-4 均已双路验证）。

---

## 1. 任务看板 `/board` → **PASS**

截图：`impl-task-board.png` / `proto-task-board.png`

### 布局结构对比

| 区域 | 原型 | 实现 | 结论 |
|---|---|---|---|
| 顶部栏 | NavTopBar（面包屑 + Cmd+K 触发框 + 用户） | 标题「任务看板」+ 统计「5 个任务 · 4 个 Agent 在线」+ 搜索框 + 用户 | ✅ 一致（统计文案同原型） |
| 筛选条 | `status-filter`，6 按钮：全部/待开始/进行中/待验收/已完成/已归档 | 同 6 按钮，选中态蓝底白字，未选中灰边框 | ✅ 一致 |
| 卡片网格 | `task-card`，2 列网格，卡片含编号/`status-badge` 状态徽章/标题/描述/`task-members` 成员头像/`task-artifact-count` 产出物计数/待开始卡 `start-task-button` + `start-task-hint` | 完全同构（4 张真实卡片，2×2 网格，进行中蓝 / 待开始灰蓝徽章） | ✅ 一致 |
| 左侧导航 | NavDock 悬浮 rail | Dock 6 图标，board 高亮（蓝竖线） | ✅ 一致 |

### token 一致性
- 选中筛选：`#3B82F6` 蓝底白字 / 未选中：灰边框灰字 ✅
- 状态徽章：待开始 `#475569` 系灰蓝、进行中蓝 —— 实现同 ✅（原型注释「待开始本地配色灰蓝 #475569 与已归档灰 #64748B 区分」与实现 `status-badge` 一致）
- 卡片白底圆角 + 浅灰边框、描述 `neutral[400/500]` ✅

### data-testid
`task-board-root`、`status-filter`、`status-filter-option`、`task-card`、`status-badge`、`task-members`、`task-artifact-count`、`start-task-button`、`start-task-hint` —— **全部保留**；实现额外增加 `board-loading/board-error/board-retry`（数据态增强，非视觉偏差）。

### 差异说明
- 数据驱动豁免：原型 mock 编号 `T-1044/T-1041`、成员头像 mock 化 vs 实现真实 `t_0000000006…` + 真实团队头像（内容差异，非布局差异）。

---

## 2. 创建任务 `/tasks/new` → **PASS**

截图：`impl-task-create.png` / `proto-task-create.png`

### 布局结构对比

| 区域 | 原型 | 实现 | 结论 |
|---|---|---|---|
| 左侧表单区（≈60%） | `task-title` / `task-description` / `doc-upload`（虚线框上传 + `doc-file` 3 个 mock 文件）/ `priority-select`（低/中/高） | 同字段；真实上传区 + 3 个预置文档（PDF/CSV/DOCX）+ 优先级三选 | ✅ 一致 |
| 右侧 Agent 区（≈40%） | `agent-option` 4 角色卡片（产品经理/架构师/开发者/测试，产品经理带 `main-agent-tag` ★ 主 Agent） | 同 4 卡片 + 勾选态 + ★ 主 Agent 徽章 | ✅ 一致 |
| 顶部 | 标题「创建任务」+ 副标题「提交需求，组建虚拟 AI 团队」 | 同文案 | ✅ 一致 |

### token 一致性
- 必填星号 `#ff4d4f` 红、主 Agent 徽章浅蓝底 `#e6f7ff` + 深蓝字 `#1890ff`、角色头像蓝/灰/绿/橙 —— 实现同 ✅
- 页面浅灰底 `#f7f8fa`、卡片白底圆角 ✅

### data-testid
`task-title`、`task-description`、`doc-upload`、`doc-upload-btn`、`doc-file`、`priority-select`、`agent-option`、`main-agent-tag`、`create-hint` —— **全部保留**；实现额外 `title-error/create-error/create-success/selected-agents/agents-loading` 等（校验/数据态增强）。

### 差异说明
- 数据驱动豁免：原型为纯静态展示（产品经理/开发者预勾选）vs 实现真实可交互勾选；原型 3 个 mock 文档名 vs 实现预置文档名。结构/字段完全一致。

---

## 3. 群聊 `/tasks/[id]` → **PASS**（附带 1 个本次修复缺陷，见 §6）

截图：`impl-group-chat.png` / `proto-group-chat.png`

### 布局结构对比

| 区域 | 原型 | 实现 | 结论 |
|---|---|---|---|
| 左栏 成员面板（≈20-25%） | `members-panel` + `member-item`（头像/名/在线状态/当前活动），标题「任务成员 · N」 | 同构：3 成员（D 开发者/P 产品经理/T 测试）全部「在线」+ 底部提示「点击成员可发起与该 Agent 的私聊」 | ✅ 一致 |
| 中栏 消息区（flex:1，≈55-60%） | `ChatHeader`（任务名+状态+团队头像）→ `chat-message-list` → `mention-hint` → `MessageInput` | 同构：任务名+待开始徽章 → 消息列表 → @提示 → 输入区「输入消息，@ 提及某个 Agent…」+ 发送 | ✅ 一致 |
| 右栏 任务面板（≈20-25%） | `task-info-panel`（标题/状态/说明/产出物 `artifact-link`/`view-session-link`） | 同构：任务详情+暂无产出物+「打开会话面板 →」 | ✅ 一致 |
| 三栏比例 | MembersPanel \| flex:1 \| TaskPanel | 20-25 / 55-60 / 20-25 | ✅ 一致 |

### token 一致性（气泡，源码级对照）
原型 `_shared/components.tsx` ChatBubble 与实现 `web/src/components/ui/chat-bubble.tsx` **panel-to-panel 相同**：
- 用户消息：`#2563EB` 底白字、右对齐、`borderTopRightRadius: sm` ✅
- Agent 消息：`#FFFFFF` 白卡 + `neutral[200]` 边框 + 左对齐 + 角色名·时间戳头 ✅
- 系统消息：`neutral[100]` 居中灰 pill ✅

### data-testid
`group-chat-root`、`members-panel`、`member-item`、`chat-message-list`、`mention-hint`、`task-info-panel`、`artifact-link`、`view-session-link` —— **全部保留**；消息类型组件（`msg-thinking/msg-tool/msg-error/loading-indicator`）在共享 ChatBubble 侧保留 ✅

### 差异说明
- 数据驱动豁免：原型 mock 成员 4 人含「处理中」+ 活动描述 vs 实现真实 3 人；任务标题 mock `T-1041 通知中心迭代` vs 真实任务。

---

## 4. 私聊 `/messages/[id]` → **PASS**（附带 1 个本次修复缺陷，见 §6）

截图：`impl-dm-chat.png` / `proto-dm-chat.png`

### 布局结构对比

| 区域 | 原型 | 实现 | 结论 |
|---|---|---|---|
| AgentInfoBar | `dm-agent-info`：头像 P + 名「产品经理」+ 角色标签 + 在线 + 协作说明「正在整理『通知中心迭代』需求清单 · 私聊会话（与群聊共用同一 session）」 | 同构：头像 + 名 + 在线 + 「正在协作『AI 助手交互原型验收』· 私聊会话（与群聊共用同一 session）」 | ✅ 一致 |
| 消息区 | `chat-message-list`：用户右蓝 / agent 左白卡 + 名·时间戳 | 同构（1 user + 1 agent 真实回复） | ✅ 一致 |
| 底部 | 输入框「发送私聊消息给 产品经理…」+ 发送 | 同构 + 「查看历史会话 ↗」链接 | ✅ 一致 |
| 单栏布局 | 顶部 AgentInfoBar → 消息列表 → 输入区 | 同 | ✅ 一致 |

### token 一致性
- 用户气泡 `#2563EB`、agent 白卡 `#FFFFFF` + `neutral[200]` 边框 —— 与原型 ChatBubble 完全一致 ✅

### data-testid
`dm-chat-root`、`dm-agent-info`、`chat-message-list`、`view-session-link` —— **全部保留**；实现额外 `dm-back-list/dm-loading/dm-error`。

### 差异说明
- 数据驱动豁免：AgentInfoBar 协作文案 mock「正在整理『通知中心迭代』需求清单」vs 实现真实「正在协作『任务名』」（模板一致，动态任务名不同）。

---

## 5. 汇总表

| # | 页面 | 结论 | 布局 | token | data-testid | 差异 |
|---|---|---|---|---|---|---|
| 1 | 任务看板 /board | ✅ PASS | 一致 | 一致 | 全保留 | 仅数据内容差异（豁免） |
| 2 | 创建任务 /tasks/new | ✅ PASS | 一致 | 一致 | 全保留 | 静态勾选 vs 可交互（豁免） |
| 3 | 群聊 /tasks/[id] | ✅ PASS | 三栏一致 | 气泡逐 token 一致 | 全保留 | loading 残留缺陷已修复 |
| 4 | 私聊 /messages/[id] | ✅ PASS | 一致 | 一致 | 全保留 | loading 残留缺陷已修复 |

差异分类：
- **PASS（视觉一致）**: 4/4 —— 分栏宽度比例、间距/对齐、气泡配色、筛选/卡片结构、data-testid 语义与原型源码完全对齐。
- **FAIL（需修复）**: 0 项残留。验收过程中发现 1 项真实缺陷（§6）已当场修复并重验。
- **数据驱动豁免**: mock 编号/成员/勾选态/动态文案（原型静态 mock 数据 vs 实现真实数据），结构与模板一致，不构成视觉偏差。

---

## 6. 验收中发现并修复的真实缺陷（loading 残留）

**现象**：私聊页刷新后「产品经理 操作中…」LoadingIndicator 恒残留（agent 回复已渲染但指示器不收敛）；群聊页存在同隐患（时序偶发）。稳定复现：私聊页连续多次刷新均残留。

**根因**：channel scope（补拉历史 `chat.message.new`）与 task scope（补拉历史 `agent.loading`）两个 SSE 连接补拉顺序不定。私聊页原「历史 loading 收敛」effect 仅在 `messagesQuery.isSuccess` 时执行一次——若 loading 重放在历史查询成功**之后**到达，收敛逻辑已跑完，指示器永久残留（回复先收敛、loading 后设置 → 恒「处理中」）。

**修复**（`web/app/(main)/messages/[id]/page.tsx`、`web/app/(main)/tasks/[id]/page.tsx`）：
收敛 effect 依赖数组由 `[messagesQuery.isSuccess, messagesQuery.data]` 扩展为加入 `loadingByAgent, errorByAgent`——无论 loading 重放在历史回复之前还是之后到达，只要某 Agent 的历史最后一条是 agent 回复，其残留 loading/error 一律清除（setState 无变化时返回原引用，不引发循环）。两页同步修复保持行为一致。

**验证**：
- 私聊页连续 3 次全新加载 + 刷新：loading 全收敛（修复前稳定复现）
- 群聊页刷新：收敛
- `npx tsc --noEmit` exit 0

---

## 7. 结论

4 个 Phase 2 页面与原型在布局结构（分栏/网格/间距/对齐）、设计 token（配色/圆角/阴影/字号）、data-testid 语义三个维度全部一致，唯一发现的真实缺陷（SSE 补拉时序导致 loading 残留）已修复并通过重验。原型→实现迁移保真度达成，无遗留视觉偏差。
