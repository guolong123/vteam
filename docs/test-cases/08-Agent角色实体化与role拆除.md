---
title: Agent 角色实体化与 role 拆除测试用例
id: testcases-agent-role-decommission
order: 8
kind: 测试用例
description: AgentRole 实体 / 提示词三段拆分 / 外部 Agent 只读展示与角色绑定 / 原生权限与服务端工具门 的真实浏览器端到端测试用例（正向+反向）
---

# Agent 角色实体化与原生权限测试用例

> 本轮改造（`opencode-native-permissions-and-fixes`）后，旧 worker 侧拦截层已被删除，
> 平台自身工具的权限门落在服务端（`tools/call` 时 403），`agents[].permission`
> 只含引擎原生键。凡下文与旧安排冲突之处，以本轮描述为准。

## 1. 模块范围与环境

本文档覆盖五个连续改造计划落地后的用户可见行为：

| 计划 | 交付 | 本文档关注点 |
|------|------|-------------|
| ① `agent-native-permission-editor` | Agent 权限编辑器（原生 permission 可改） | Agent 详情页权限段可用性 |
| ② `agent-role-entity` | `AgentRole` 实体 + `TeamMember.roleId` + 提示词三段拆分 | 角色 Tab、成员⇄角色、提示词只读性 |
| ③ `third-party-agent-display` | 外部（非 vteam）Agent 只读展示 + 角色绑定 | 「外部 Agent」Tab、非治理警告、角色编辑器单槽位 |
| ④ `agent-role-decommission` | **`Agent.role` 列彻底拆除**，职责归位 | 列消失后行为不变 |
| ⑤ `opencode-native-permissions-and-fixes` | **原生权限 + 服务端工具门**：worker 侧拦截层删除，`vteam_*` 只在服务端判定 | **本文档重点**：`task` 可编辑、角色单槽位内外二选一、服务端 403、新冻结基线 |

**四个「职责归位」映射（本次改造的核心，所有断言围绕它）**

| 旧 `Agent.role` 承担的职责 | 现在由谁承担 |
|---|---|
| 岗位标签（显示名 / 头像配色 / 团队默认别名） | `AgentRole` / `TeamMember.roleId` |
| 权限（能干什么） | `Agent.policyId`（引擎原生键 `edit/read/bash/task`） |
| opencode 执行体名（`vteam-<key>`） | `Agent.agentKey` |
| 计划（planner）职责判定 | 策略实际持有的 `task` 原生权限（`subagent_depth` 覆盖套娃） |
| 平台自身工具（`vteam_*`）的允许/拒绝 | **服务端** `tools/call` 时判定（403 + `PLATFORM_MCP_TOOL_NOT_PERMITTED`） |
| 角色默认用哪个 Agent（含外部引擎 Agent） | `AgentRole` 单槽位：`defaultAgentId` XOR `defaultOpencodeAgentName`，成员创建时按规则 5 预填 |

**测试环境**

| 项 | 值 |
|----|----|
| Web 入口 | http://127.0.0.1:13001 |
| API 入口 | http://127.0.0.1:13000/api/v1 |
| 部署形态 | docker compose：db / init / server(13000) / web(13001) / worker |
| 管理员 | `admin` / `admin123`（数据型断言需数据归属该账号） |
| Seed 账号 | `seed-admin` / `Admin@123456`（种子团队 `tm_0000000001` 的成员归属 seed-admin） |
| 认证方式 | JWT Bearer（`Authorization: Bearer <accessToken>`）；**cookie 不被接受**，必须带 Bearer |
| 执行态 | 全新重建（`docker compose down -v && up -d --build`）：7 个模板 Agent、8 个 AgentRole（7 内置 + `ar_general`）、1 个种子团队、7 个成员 |
| 浏览器 | Playwright `channel: "chrome"`；compose web 用独立 tmp config 指向 `:13001` |

**冒烟命令**

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:13000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq -r .accessToken)

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:13000/api/v1/agent-policies   # 7 内置策略
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:13000/api/v1/agents            # 7 模板 Agent
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:13000/api/v1/agent-roles      # 8 个角色
```

**关键数据事实（全新库）**

| 事实 | 值 |
|------|----|
| `agents` 行数 | 7（全部 `type='template'`） |
| 每个模板的 `agent_key` | 等于该模板的原岗位键（product / project_manager / architect / developer / tester / plan / librarian） |
| 每个模板的 `policy_id` | 非空（`ep_<key>`） |
| `team_members` | 7 行，`role_id` 全部非空 |
| `AgentRole` | 7 内置（`default_agent_id` 均非空）+ `ar_general`（`default_agent_id` 为 NULL） |
| 头像配色键集 | `product / project_manager / architect / developer / tester / plan`（**`librarian` 不在配色键集**，回落中性色） |

**实现差异与前置说明（预期以实际实现为准）**

1. **`Agent.role` 列已不存在**：任何 `SELECT ... role FROM agents` 都会报 1054。这不是缺陷，是本次目标。UI/API 仍有一个叫 `role` 的**字段**，但其值来自 `agentKey`（机器键），与已删除的列无关。
2. **`/agents` 的 `role` 字段语义**：值 = `agentKey`（机器键）。模板内 `agentKey === 原 role`，因此**渲染逐项不变**；自定义 Agent 的该字段由 `null` 变为其 `agentKey`，但配色映射对未知键回落 `developer` 中性色 ⇒ 渲染仍不变（已在浏览器实测）。
3. **角色标签（人名可读）与机器键分离**：API 的 `role` 字段是**机器键**（`developer`），别名标签才是中文展示名（`开发者-1`）。不要把两者混用断言。
4. **`librarian` 无专属配色**：知识管理员头像回落到中性 `developer` 色 —— 这是**既有**行为（配色键集只有 6 个），非本次回归。
5. **外部 Agent 不受 vteam 权限管辖**：外部 Agent 在「外部 Agent」Tab 只读展示，也可在**角色编辑器**的单槽位选择器中被选中（`defaultOpencodeAgentName`）；`/agent-policies` 的 `agents[].permission` 中绝不出现外部名，也不出现任何 `vteam_*` 键。
6. **计划职责的边界**：子任务扇出由引擎原生的 `task` 权限 + `subagent_depth` 治理（默认 1 即禁套娃）。UI 上「Agent 详情 → 权限 → task」处是与 `bash` 同形态的**可编辑三态**，附带说明 `subagent_depth` 的注释，不再有任何 guard/字面量执行体名的说法。

**本次改造的回归红线（最高优先级）**

```
R1  agents 表无 role 列（1054 为预期）
R2  7 内置 /agent-policies 与冻结基线一致（sha e795b0c8…；历史基线 3b8c5d4b… 只作历史，仍由 e2e-third-party-no-policy-leak.sh D1 断言）
R3  每个成员 role_id 非空，且 roleId → AgentRole.key 映射正确
R4  每个 Agent 的 policy_id 非空（能力不因删列而丢失）
R5  三个 Tab（Agent / 角色 / 外部 Agent）都存在且可用
R6  会话页消息输入区全页零 <select>（历史承诺，不得回归）
R7  未授权的平台工具调用被服务端拒绝（403 + PLATFORM_MCP_TOOL_NOT_PERMITTED）
R8  角色单槽位：defaultAgentId 与 defaultOpencodeAgentName 至多一个非空（双设 400 AGENT_ROLE_DEFAULT_SLOT_CONFLICT）
```

---

## 2. Agent 列表与岗位身份用例（TC-ROLE）

### 2.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-ROLE-001 | `/agents` 渲染 7 个模板 Agent | 正向 | P0 | `admin` 已登录（浏览器） | 1. 打开 `/agents`<br>2. 等 `agent-config-root` 可见 | 1. `agent-list-item` 计数 = 7<br>2. 每行显示"模板"徽章<br>3. 无 `agents-error` |
| TC-ROLE-002 | 每个模板头像 `data-role` 正确（岗位身份来自 `agentKey`） | 正向 | P0 | 同 TC-ROLE-001 | 1. 逐行读取 `agent-list-item` 内 `agent-avatar` 的 `data-role` | 1. 6 个模板的 `data-role` 分别为 `product / project_manager / architect / developer / tester / plan`<br>2. **知识管理员（librarian）** 的 `data-role` = `developer`（无专属配色的既有回落）<br>3. 值与岗位键一一对应，无 `undefined` / 空值 |
| TC-ROLE-003 | 头像配色取自角色主题 token | 正向 | P1 | 同 TC-ROLE-001 | 1. 取 `a_product` 行头像的计算样式 `background-color` / `border-top-color` | 1. `background-color` = `rgb(240, 253, 250)`<br>2. `border-top-color` = `rgb(153, 246, 228)`<br>（即 `tokens.ts` 中 product 主题值，证明配色仍走角色主题而非降级色） |
| TC-ROLE-004 | 选中详情显示有效权限（能力来自 `policyId` 而非已删列） | 正向 | P0 | 同 TC-ROLE-001 | 1. 点击任一模板行<br>2. 等待 `effective-permission-section` | 1. 权限段可见，含 `effective-permission-row`<br>2. `effective-policy-meta` 显示绑定的策略<br>3. 页面无报错、无空白权限区 |
| TC-ROLE-005 | `task` 权限可编辑（三态，与 `bash` 同形态） | 正向 | P0 | 同 TC-ROLE-004 | 1. 定位 `native-task-effect`（三态 allow/ask/deny，`data-readonly="false"`）<br>2. 改值后 reload 回读一致<br>3. 确认旧 `native-task-note` 不存在 | 1. `native-task-effect` 可见且三态齐备<br>2. 改值持久化（页面与 `GET /agent-policies` 一致）<br>3. `native-task-note` 计数 = 0；替代说明含 `subagent_depth`，不含 `guard`/`vteam-plan` |
| TC-ROLE-006 | 三个 Tab 存在且首个为 Agent | 正向 | P0 | 同 TC-ROLE-001 | 1. 读 `manage-tabs` 与 `manage-tab` | 1. `manage-tab` 计数 = **3**<br>2. 文本依次为 `Agent` / `角色` / `外部 Agent`<br>3. `Agent` 的 `data-active="true"` |

### 2.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-ROLE-007 | `agents` 表不再有 `role` 列 | 反向（结构性） | P0 | 容器内可连 MySQL | 1. `SHOW COLUMNS FROM agents LIKE 'role'`<br>2. `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='aiagents' AND table_name='agents' AND column_name='role'` | 1. 步骤 1 返回 **0 行**<br>2. 步骤 2 返回 **0**<br>3. 若任一非 0 → 本次改造未生效，阻断 |
| TC-ROLE-008 | 无模板 Agent 缺 `policy_id`（能力不丢） | 反向 | P0 | 同上 | 1. `SELECT COUNT(*) FROM agents WHERE policy_id IS NULL` | 1. 返回 **0**<br>2. 若 >0 → 有 Agent 失去能力来源，阻断 |
| TC-ROLE-009 | 无 `agent_key` 为空的内置模板 | 反向 | P1 | 同上 | 1. `SELECT COUNT(*) FROM agents WHERE type='template' AND (agent_key IS NULL OR agent_key='')` | 1. 返回 **0** |
| TC-ROLE-010 | 未知角色键回落到中性色而非崩溃 | 反向 | P1 | `admin` 已登录；存在一个自定义 Agent（无角色配色键） | 1. 创建/挑选一个自定义 Agent<br>2. 打开 `/agents` 读取其头像 `data-role` | 1. `data-role` = `developer`（中性回落）<br>2. 列表仍渲染，无错误边界/白屏 |
| TC-ROLE-011 | 页面控制台无错误 | 反向 | P0 | 同 TC-ROLE-001 | 1. 监听 `console`(error) 与 `pageerror`，访问 `/agents` 并切换三个 Tab | 1. 登录后零 console error / 零 pageerror<br>2. （登录页跳转期的单次 401 探测不计） |

---

## 3. 角色 Tab 与提示词用例（TC-AROLE）

### 3.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-AROLE-001 | 角色 Tab 列出 7 内置角色 | 正向 | P0 | `admin` 已登录 | 1. 打开 `/agents` → 点 `manage-tab`「角色」<br>2. 等 `agent-role-root` | 1. `role-item` 计数 ≥ 7<br>2. 7 个内置角色（产品经理/项目经理/架构师/开发者/测试/计划员/知识管理员）均在列<br>3. 每项带 `role-type-badge` |
| TC-AROLE-002 | 内置角色只读（无删除/无保存） | 正向 | P0 | 同上 | 1. 选中任一内置角色 | 1. 出现 `role-builtin-notice`（"内置角色只读，不可编辑或删除"）<br>2. `role-delete-button` 计数 = 0<br>3. 输入控件为只读态 |
| TC-AROLE-003 | 内置角色的岗位职责提示词非空且只读 | 正向 | P0 | 同上 | 1. 读取 `role-prompt` 的值与只读属性 | 1. 值非空（长度 > 0）<br>2. 元素为只读（`readOnly` / 不可编辑）<br>3. 内容是「岗位定义」（含角色身份语义），**不含**平台级通用条款 |
| TC-AROLE-004 | 角色 Tab 与 Agent Tab 互不干扰 | 正向 | P1 | 同上 | 1. 角色 Tab → 切回 Agent Tab → 再切回角色 Tab | 1. 每次切换目标 Tab 正确渲染<br>2. Agent Tab 仍显示 7 个 `agent-list-item`<br>3. 无状态串扰、无重复渲染 |
| TC-AROLE-009 | 角色选中态与警告深色模式无浅色硬编码 | 正向 | P1 | `admin` 已登录；可切换主题 | 1. 切深色主题，选中角色项读计算背景；读外部警告块颜色<br>2. 切回浅色复核原值 | 1. 深色下选中背景非 `#EFF6FF`/非纯白（半透明 tint），警告块非浅色 amber<br>2. 浅色下与原 hex 逐字节一致（无回归） |

### 3.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-AROLE-005 | 内置角色 DELE 被拒（403 + 行仍在） | 反向 | P0 | `admin` token | 1. `DELETE /api/v1/agent-roles/ar_developer` | 1. 返回 **403**，错误码为内置只读类<br>2. 再 `GET /api/v1/agent-roles/ar_developer` 仍 **200** |
| TC-AROLE-006 | 删内置角色后角色总数不变 | 反向 | P1 | 同 TC-AROLE-005 执行前 | 1. 记录 `GET /agent-roles` 总数<br>2. 尝试删内置角色<br>3. 再读总数 | 1. 前后总数相同<br>2. 内置 7 项仍在 |
| TC-AROLE-007 | 未认证访问角色接口被拒 | 反向 | P1 | 无 token | 1. `GET /api/v1/agent-roles`（无 Authorization） | 1. 返回 **401**<br>2. 不返回任何角色数据 |
| TC-AROLE-008 | 角色提示词不含平台级通用条款（拆分未回滚） | 反向 | P1 | `admin` token | 1. 读 7 个内置角色的 `rolePrompt`<br>2. 检索平台级块标记（团队协作规约 / 回执铁律 等） | 1. 7 个 `rolePrompt` 均为非空<br>2. 平台级块**不出现在**任何 `rolePrompt` 中（它们已被抽为平台常量） |

---

## 4. 外部 Agent 展示用例（TC-EXT）

### 4.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-EXT-001 | 外部 Agent Tab 渲染引擎上报的外部 Agent | 正向 | P0 | `admin` 已登录；worker 在线 | 1. `/agents` → 点「外部 Agent」Tab<br>2. 等 `external-agents-root` | 1. `external-agent-item` 计数 > 0<br>2. 不出现 `external-agents-unavailable` |
| TC-EXT-002 | 每条目都带非治理警告（逐条计数） | 正向 | P0 | 同上 | 1. 计 `external-agent-item` 与 `external-agent-item-warning` 数量 | 1. 警告数 **等于**条目数（逐条覆盖，无遗漏）<br>2. 每个警告文本 = `此 Agent 来自外部（非 vteam 内置），不受 vteam 权限规则管辖。`<br>3. 详情处另有 `external-agent-detail-warning` |
| TC-EXT-003 | 提示词只读展示 | 正向 | P0 | 同上 | 1. 点选一条外部 Agent<br>2. 等 `external-agent-instructions` | 1. 元素标签为 `PRE`<br>2. 正文非空<br>3. 无 `contenteditable` |
| TC-EXT-004 | 外部面板内零编辑控件 | 正向 | P0 | 同上 | 1. 在 `external-agents-root` 内检索可编辑控件 | 1. `textarea` / `input` / `select` / `[contenteditable]` 计数均为 **0**<br>2. 页面无 `prompt-editor` / `save-agent-button` / `effective-permission-section`（外部 Agent 不纳入 vteam 策略） |

### 4.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-EXT-005 | 指令拉取失败 → 显式不可用态（绝不空白） | 反向 | P0 | `admin` 已登录 | 1. `page.route("**/agents/omo-agent-prompt**")` 回 500<br>2. 打开外部 Agent Tab 并点选一条 | 1. 出现 `external-agent-instructions-unavailable`，文本「说明加载失败（暂不可用）」<br>2. `external-agent-instructions` 计数 = 0（**不是**空框）<br>3. 详情与警告仍在（失败不吞上下文） |
| TC-EXT-006 | 外部名字不进入 `/agent-policies` | 反向 | P0 | `admin` token | 1. `GET /api/v1/agent-policies`<br>2. 检索外部 Agent 名（如 Prometheus / Sisyphus / oracle / general 等） | 1. `agents[].name` 与 `guard.roles` 的键集中**均无**外部名<br>2. 受治理集合与外部集合**互不相交** |
| TC-EXT-007 | 引擎不可用时不谎报为"没有外部 Agent" | 反向 | P1 | 可停/断 worker | 1. 使外部列表请求失败或降级<br>2. 打开外部 Agent Tab | 1. 显示 `external-agents-unavailable` 文案（worker 离线/版本不支持）<br>2. HTTP 仍为 200（不 500）<br>3. 与"确实没有外部 Agent"的空态文案可区分 |
| TC-EXT-008 | 受治理 Agent 不被误标为外部 | 反向 | P0 | `admin` 已登录 | 1. 打开外部 Agent Tab<br>2. 检索 7 个内置名（vteam-product 等） | 1. 外部列表**不含**任何 `vteam-` 受治理名 |

---

## 5. 成员⇄角色与别名用例（TC-MBR）

### 5.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-MBR-001 | 每个成员 `role_id` 非空 | 正向 | P0 | 可连 MySQL | 1. `SELECT COUNT(*), SUM(role_id IS NULL) FROM team_members` | 1. 总数 = 7，`SUM(... IS NULL)` = **0**<br>2. 若 >0 → 成员缺角色绑定，阻断 |
| TC-MBR-002 | `roleId` → `AgentRole.key` 映射正确 | 正向 | P0 | `admin` token | 1. `GET /api/v1/teams/tm_0000000001` 取成员 `roleId`<br>2. `GET /api/v1/agent-roles` 建 id→key 映射<br>3. 逐成员比对 | 1. 每个成员 `roleId` 都能解析到唯一 `AgentRole.key`<br>2. 该 key 与其 `agentId` 对应模板的岗位一致（如 `ar_developer` ↔ `a_developer`）<br>3. 无成员指向不存在的角色 |
| TC-MBR-003 | 团队详情页成员行显示正确别名与角色 | 正向 | P0 | `seed-admin` 或 `admin` 已登录，进入种子团队详情 | 1. 打开 `/teams/tm_0000000001`<br>2. 读各 `member-row` 的别名与头像 `data-role` | 1. 别名形如 `产品经理-1` / `项目经理-1` / `架构师-1` / `开发者-1` / `测试-1` / `计划员-1` / `知识管理员-1`<br>2. 头像 `data-role` 与岗位一致（librarian 回落 `developer`）<br>3. `main-badge` 落在主成员（项目经理）上 |
| TC-MBR-004 | 别名标签来自 `AgentRole.name` 而非旧列 | 正向 | P0 | 同 TC-MBR-003 | 1. 比对渲染别名与 `GET /agent-roles` 中各角色 `name` + `seq` | 1. 别名 = `<AgentRole.name>-<seq>`<br>2. 7 个成员全部匹配<br>3. 中文标签与角色键分离（键用于配色，名用于展示） |
| TC-MBR-005 | 团队列表页成员头像角色色正确 | 正向 | P1 | 登录态 | 1. 打开 `/teams`<br>2. 读 `team-card` 内头像 `data-role` | 1. 渲染 ≤5 个成员头像<br>2. 每个 `data-role` 与其岗位一致<br>3. 超出部分显示 `+N` |

### 5.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-MBR-006 | 角色映射缺失时回落而非空标签 | 反向 | P0 | 可构造一个 `role_id` 为空的成员（临时） | 1. 将某成员 `role_id` 置空<br>2. 打开团队详情页<br>3. 恢复该成员 | 1. 该成员行**不显示空标签**，回落为 `agent.name` 派生的别名<br>2. 页面不抛错、不白屏<br>3. 恢复后别名回到 `<AgentRole.name>-<seq>` |
| TC-MBR-007 | 会话页仍是全页零 `<select>`（历史承诺） | 反向 | P0 | 登录态 | 1. 打开 `/teams/tm_0000000001/session`<br>2. 等 `team-session-root` | 1. 全页 `select` 计数 = **0**<br>2. `message-agent-select` 计数 = 0<br>3. `member-external-agent-select` 计数 = 0<br>4. `message-input` 与发送按钮仍存在 |
| TC-MBR-008 | 角色编辑器是外部 Agent 选择器的唯一宿主（成员行零 picker） | 正向 | P0 | 登录态 | 1. 打开 `/teams/tm_0000000001`（详情）检索 `member-external-agent*` 前缀<br>2. 打开 `/agents` 角色 Tab 读 `role-default-agent`<br>3. 再打开会话页读同名 testid | 1. 详情页 `member-external-agent*` 计数 = 0（成员行 picker 已随 issue 3 移除）<br>2. 角色编辑器 `role-default-agent` 存在，选项含内部 Agent 与引擎外部 Agent<br>3. 会话页该 testid 计数 = 0<br>4. 边界明确：选择只收归角色编辑器，禁止消息输入区 |
| TC-MBR-009 | 角色外部槽位预填成员（规则 5）：显式值胜出 | 正向 | P0 | `admin` token；有外部名的角色 | 1. 给某角色设置 `defaultOpencodeAgentName`（如 `Prometheus - Plan Builder`）<br>2. 不传 `opencodeAgentName` 添加成员 → 回读成员 `opencodeAgentName`<br>3. 传显式值添加另一成员 → 回读<br>4. 清理 | 1. 未显式传值时成员 `opencodeAgentName` = 角色外部名（预填）<br>2. 显式传值时成员值 = 显式值（显式胜出）<br>3. 角色本身 `defaultAgentId` 为 null（槽位互斥） |

---

## 6. 能力与策略用例（TC-POL）

> 本节已按 `opencode-native-permissions-and-fixes` 重写：`agents[].permission`
> 只含引擎原生键（`edit/read/bash/task`，无 `vteam_*`）；`guard.roles[*]` 只剩
> `{permission}`（`tools`/`bashDeny`/`correction` 随 worker 拦截层删除）；
> 平台自身工具的允许/拒绝由服务端 `tools/call` 时判定。

### 6.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-POL-001 | 7 内置 `/agent-policies` 与新冻结基线一致 | 正向 | P0 | `admin` token；新基线文件 `.omo/evidence/opencode-native-permissions-and-fixes/baseline-agent-policies.json` 存在 | 1. `GET /api/v1/agent-policies`<br>2. 按基线同等格式序列化后取 sha256<br>3. 与基线 sha `e795b0c8…` 比对 | 1. 序列化 sha **等于**基线 sha<br>2. 7 个 agent 的 `name` / `description` / `mode` / `permission` 全树深等<br>3. `guard.roles` 键集与各角色 `permission` 深等（`tools`/`bashDeny`/`correction` 已不存在） |
| TC-POL-002 | 受治理集合与外部集合互斥且完备 | 正向 | P0 | 同上 | 1. 比对 `/agent-policies` 的 agent 名集合 与 `/agents/opencode` 中 `governed:true` 的集合 | 1. 两集合**相等**（双向无缺无多）<br>2. `governed:false` 的条目名**不在**策略集合中 |
| TC-POL-003 | 权限编辑器可用（原生四行可改，含 `task` 三态） | 正向 | P0 | `admin` 已登录 | 1. 打开某模板 Agent 详情<br>2. 在权限段定位原生权限控件（`native-rule-editor` / `native-rule-effect` / `native-rule-row`、`native-bash-effect`、`native-task-effect`） | 1. 四行恒显且可用（非只读降级态）；`task` 为可编辑三态（TC-ROLE-005）<br>2. 权限段展示执行体名（`effective-policy-meta`）与作用域（`effective-permission-scope`）<br>3. 无 `native-rule-error`；无 `native-task-note` |
| TC-POL-008 | 服务端拒绝未授权平台工具（403 + `PLATFORM_MCP_TOOL_NOT_PERMITTED`） | 正向 | P0 | `admin` token；worker 在线 | 1. 选一角色缺失的工具（如开发者调 `task_transition`），直发 JSON-RPC `POST /api/v1/platform-mcp`（`tools/call`，裸名如 `task_transition`，带 worker token + 调用者身份）<br>2. 同会话调一允许的工具（如 `group_post`） | 1. 未授权调用返回 **403**，稳定码 `PLATFORM_MCP_TOOL_NOT_PERMITTED`（JSON-RPC 层 `-32003` + `[403]` 前缀），handler 不执行<br>2. 允许的调用成功<br>3. `tools/list` 仍向所有 Agent 提供全部工具（拦截只在调用时） |
| TC-POL-009 | 角色单槽位：内部 XOR 外部（`AGENT_ROLE_DEFAULT_SLOT_CONFLICT`） | 正向 | P0 | `admin` token | 1. 建自定义角色，`role-default-agent` 单选外部引擎名 → 保存 → reload 回读<br>2. 切回内部 Agent → 保存 → 回读<br>3. 直发同时双设的 PATCH | 1. 外部 leg：`defaultOpencodeAgentName` = 所选名且 `defaultAgentId` = null；列表项如实显示外部名（非"未设置"）<br>2. 内部 leg：`defaultAgentId` = 所选 id 且 `defaultOpencodeAgentName` = null（原子清空）<br>3. 双设 → **400** `AGENT_ROLE_DEFAULT_SLOT_CONFLICT`，已持久态不变 |

### 6.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-POL-004 | 历史冻结基线文件未被修改 | 反向 | P0 | 仓库可读 | 1. `shasum -a 256 .omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json` | 1. 输出 = `3b8c5d4b…af87`（历史值，仅作历史锚点）<br>2. 该文件不在本轮改动的提交范围内（本轮基线另见 TC-POL-001） |
| TC-POL-005 | `worker/**` 无手写拦截残留（`role-guard` 已删） | 反向 | P0 | 仓库可读 | 1. `grep -rn "role-guard\|vteam-role-guard" worker/src`（生产代码） | 1. 命中为空（注释除外）<br>2. 注入的 `opencode.json` 无 guard 插件项；无 `.vteam-role-guard/roles.json` 写入 |
| TC-POL-006 | 代码中无残留 `Agent.role` 读取 | 反向 | P0 | 仓库可读 | 1. `grep -rn "agent\.role" server/src server/prisma --include=*.ts \| grep -v spec` | 1. 命中仅为注释/文档<br>2. 无任何生产读取路径 |
| TC-POL-007 | 注入产物不含外部名、不含 `vteam_*` 权限键 | 反向 | P1 | 可读 worker 工作目录 | 1. 结构化读取 worker 侧注入的 `opencode.json`<br>2. 检查 `agents[].permission` 与 agent 名槽位 | 1. agent 名槽位**无**外部名；键集等于受治理集合<br>2. `agents[].permission` 键集 = 原生键（`edit/read/bash/task`），**零** `vteam_` 前缀键<br>（注意：`plan` 会作为合法的 handoff 映射键出现，须按 JSON 路径判别，**不可**裸 grep） |

---

## 7. 端到端主流程用例（TC-E2E）

以下为**跨模块**的真浏览器串联用例，用于验收「删列后平台整体仍可用」。

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-E2E-001 | 新建 Agent 选岗位 → 继承能力（非骨架） | 正向 | P0 | `admin` 已登录 | 1. `/agents` → `create-agent-button`<br>2. 填写名称与 `agent-key-input`<br>3. `create-agent-role` 选择「开发者」岗位（值为 `ar_*`）<br>4. `create-agent-confirm` 提交 | 1. `POST /agents` 返回 201<br>2. 请求体含 `agentRoleId:"ar_developer"`，**不含** `role` 键<br>3. 回包 `effectivePermission.permission.bash = "allow"`、`tools` 非空（继承岗位能力，**非**骨架）<br>4. 落库策略为新建 custom 策略（非共享内置行）<br>5. 用后清理该 Agent（删除 agent + 其策略） |
| TC-E2E-002 | 新建 Agent 不选岗位 → deny-by-default 骨架 | 正向 | P0 | 同 TC-E2E-001 | 1. 同上但 `create-agent-role` 保持「无」<br>2. 提交 | 1. 返回 201<br>2. 请求体**不含** `agentRoleId`，**不含** `role`<br>3. `effectivePermission.permission.edit = {"*":"deny"}`、`bash = "deny"`、`tools = {}` |
| TC-E2E-003 | 成员按岗位添加 → 自动预填默认 Agent | 正向 | P1 | 有可添加的临时团队 | 1. 团队成员面板选「开发者」岗位并提交<br>2. 回读成员 | 1. 成员 `roleId` = 该岗位 id<br>2. `agentId` = 该岗位 `defaultAgentId`<br>3. 显式切换 Agent 时覆盖岗位默认（提交体 `agentId` 为覆盖值）<br>4. 用后删除临时团队 |
| TC-E2E-004 | Agent 列表 → 详情 → 角色 Tab → 外部 Agent Tab 全链路无错 | 正向 | P0 | 登录态 | 1. 依次访问四个表面并各做一次交互（选中行 / 切换 Tab / 选外部条目） | 1. 四步均正常渲染<br>2. 零 console error / 零 pageerror<br>3. 无请求 5xx |

### 7.1 反向（异常路径）

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-E2E-005 | 旧 `role` 字符串提交被静默剥离 → 落骨架（而非保留已删列语义） | 反向 | P0 | `admin` token | 1. `POST /agents` 传 `{name, agentKey, role:"developer"}`（**不带** `policyId`/`agentRoleId`） | 1. 返回 201（未知字段被全局 whitelist 管道剥离）<br>2. 新 Agent 的能力为**骨架**（`tools = {}`、`bash = "deny"`）<br>3. 证明旧 `role` 通路已彻底失效，不会"看似成功却保留旧语义" |
| TC-E2E-006 | 改标签不重配策略（保护用户编辑） | 反向 | P0 | `admin` token；某 Agent 已绑定策略 | 1. 记录其 `policyId` 与该策略 config<br>2. `PATCH /agents/:id` 仅改 `name`（或改标签类字段）<br>3. 回读 `policyId` 与策略 config | 1. `policyId` 不变<br>2. 策略 config 与 `updatedAt` 不变<br>3. 标签变更**不会**自动重建/覆盖策略 |
| TC-E2E-007 | 全新库迁移链干净通过 | 反向（运维） | P0 | 已执行 `docker compose down -v` | 1. `docker compose up -d --build`<br>2. 读 `init` 容器退出码与日志 | 1. `init` 退出码 = **0**<br>2. 全部迁移（含 `20260919000010_drop_agents_role`）已应用<br>3. seed 无 `Unknown argument 'role'` 之类的列不存在错误<br>4. 无未完成为的迁移 |
| TC-E2E-008 | 拦截层删除的边界声明未被夸大 | 反向（一致性） | P1 | 仓库可读 + live 栈 | 1. 检索本轮证据/文档中关于"子任务扇出"的表述<br>2. 用真实调用校验：未授权平台工具走服务端 403；文件越界仍被引擎原生 `edit` 限制 | 1. 文档**明确**声明「子任务由引擎原生 `task` + `subagent_depth` 治理，平台工具由服务端 403 守门，无手写拦截残留」<br>2. 不存在任何"worker guard 仍在拦截"的宣称<br>3. 实测行为与声明一致 |

---

## 8. 用例统计与执行建议

### 8.1 统计

| 章节 | 用例编号段 | 正向 | 反向 | 小计 |
|------|-----------|------|------|------|
| Agent 列表与岗位身份 | TC-ROLE-001 ~ 011 | 6 | 5 | 11 |
| 角色 Tab 与提示词 | TC-AROLE-001 ~ 009 | 5 | 4 | 9 |
| 外部 Agent 展示 | TC-EXT-001 ~ 008 | 4 | 4 | 8 |
| 成员⇄角色与别名 | TC-MBR-001 ~ 009 | 7 | 2 | 9 |
| 能力与策略 | TC-POL-001 ~ 009 | 5 | 4 | 9 |
| 端到端主流程 | TC-E2E-001 ~ 008 | 4 | 4 | 8 |
| **合计** | — | **31** | **23** | **54** |

### 8.2 优先级分布

| 优先级 | 数量 | 说明 |
|-------|------|------|
| P0 | 41 | 核心不变量（R1–R8 全部由此覆盖） |
| P1 | 13 | 重要但非阻断 |

### 8.3 执行建议

1. **浏览器用例**（TC-ROLE-001~006/010/011、TC-AROLE-001~004/009、TC-EXT-001~005/007/008、TC-MBR-003~005/007/008、TC-E2E-004；另有 TC-POL-003/008/009、TC-MBR-009、TC-AROLE-009 的页面部分）：Playwright，`channel: "chrome"`，baseURL 指向 compose web `:13001`；用独立 tmp config（不改 `playwright.config.ts`）。已落地的 spec 与 harness：
   - `web/e2e/roles-members.spec.ts`（4 tests）← `bash scripts/e2e-roles-members.sh`；外部槽位往返 + 槽位冲突面即 TC-POL-009 的页面证明。
   - `web/e2e/no-agent-picker.spec.ts`（5 tests）← `bash scripts/e2e-no-agent-picker.sh`；测试 1（会话页零 `<select>`，TC-MBR-007）与测试 5（详情页零 `member-external-agent*`，TC-MBR-008）为本轮边界。
   - `web/e2e/no-agent-picker.spec.ts` + `web/e2e/third-party-agents.spec.ts`（2 tests）+ `web/e2e/roles-members.spec.ts` 一起 ← `bash scripts/e2e-agent-surfaces.sh`（`member-external-agent.spec.ts` 已删除，覆盖已迁移至此三处；勿重建）。
   - `web/e2e/native-rule-editor.spec.ts`（7 tests）← `bash scripts/e2e-native-rule-editor.sh`；测试 1/2 覆盖 `task` 可编辑面（TC-ROLE-005）。
   - `web/e2e/task-permission-editable.spec.ts`（3 tests）← `bash scripts/e2e-task-permission-editable.sh`（连带重跑 native-rule-editor）。
   - `web/e2e/dark-mode-role-warning.spec.ts`（2 tests，TC-AROLE-009）← 独立 tmp config（见 todo 8 证据 `task-8-dark-mode.txt`）。
   - `web/e2e/create-agent-role.spec.ts` ← `bash scripts/e2e-create-agent-role.sh`（TC-E2E-001/002 的页面证明）。
2. **API 用例**（TC-AROLE-005~008、TC-EXT-006、TC-MBR-001/002/006/009、TC-POL-001/002/008/009、TC-E2E-001/002/003/005/006）：curl 或 Playwright `request` fixture；**必须带 Bearer**（cookie 不被接受）。TC-POL-008 的 403 探针见 `scripts/e2e-permission-matrix.sh`（服务端门矩阵，含 `PLATFORM_MCP_TOOL_NOT_PERMITTED` 断言）。
3. **数据/仓库用例**（TC-ROLE-007~009、TC-POL-004~007、TC-E2E-007/008）：`docker exec ... mysql`、`shasum`、`git diff`、注入产物结构化读取。TC-POL-004 只断言**历史**基线 `3b8c5d4b…` 未动（`e2e-third-party-no-policy-leak.sh` D1 仍守护它，勿改该脚本）；本轮基线 `e795b0c8…` 由 `scripts/e2e-role-boundaries.sh` 与 `scripts/e2e-native-edit-enforcement.sh` 守护。
4. **写型用例必须自清理**：TC-E2E-001/002（删除 agent + 策略）、TC-MBR-006（恢复 `role_id`）、TC-E2E-003（删除临时团队）。执行后断言「无残留」（agent 数回到 7、成员数回到 7、`role_id` 为空数回到 0）。
5. **建议执行顺序**：TC-ROLE（结构）→ TC-POL（不变量）→ TC-AROLE / TC-EXT（页面）→ TC-MBR（成员）→ TC-E2E（串联）。
6. **证据留存**：每个 P0 用例保留可核对的机器可读证据（JSON/截图/命令输出），置于 `.omo/evidence/` 下的本计划目录；截图与 `.sql` 已被 `.gitignore` 覆盖，勿强行入库。
