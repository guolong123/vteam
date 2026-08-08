# Draft: Phase 3 Agent 与产出物（M3）

## 背景
- 用户要求：按推进计划继续下一阶段计划编写
- 已完成：Phase 0-2（M0-M2）
- 下一阶段：**Phase 3「Agent 与产出物」**（18 篇推进计划 §7）

## Phase 3 范围（18 篇 §7）
- **7.1 AgentsModule**：GET /agents（type?）+ POST /agents（custom）+ clone + PATCH（模板403）+ available-models（静态占位）
- **7.2 虚拟团队**：task_agents + team add/remove + sessions 状态机（created→active→frozen→archived）
- **7.3 ArtifactsModule**：json_schema 校验 + 归档链路（mock 注入）+ 文档库 + 验收联动
- **7.4 前端**：agent-config / user-management / role-permission + **新增产出物管理页**
- **M3**：Agent 配置 → 加入任务 → 产出物归档（mock）→ 文档库展示 → 验收闭环

## 用户决策记录
### 产出物管理页（用户明确设计，非原型 task-detail）
- **路由**：`/artifacts?pid=xxx`（与 /board?pid= 同模式）
- **入口**：看板页加「产出物」入口按钮 + 项目页卡片次级入口；Dock 高亮归项目
- **归属**：项目级（聚合该项目所有任务的产出物）
- **筛选**：任务下拉 + 类型（结论文本/文档/文件）+ 验收状态（全部/已验收/未验收），**默认全部**
- **展示**：列表（类型徽章+标题+所属任务+版本+作者+验收状态+时间）+ 点击行展开**版本查看器**（复用原型 ArtifactViewer，接真实版本 API）
- **验收状态徽章**：要加（补原型，非按原型原样）
- **前后端同步**推进

### 已收口决策（研究结论确认 + 用户确认 + Metis/Oracle 审查）
- task-detail 原型不迁移（产出物聚合页 /artifacts?pid= 取代）→ 18 篇 §7.4 需同步（计划含文档更新任务）
- role-permission 路由：新建 /roles + Dock 新项（用户确认）
- Agents 写权限：14 篇 §7 模板 403 PERMISSION_AGENT_READONLY，clone/custom 可 PATCH（已定案）
- 验收状态徽章：加（补原型）
- 前后端同步推进，契约先行（Metis 审查）

## 研究结论（后端）
- 20 表 100% 就绪；创建任务写 task_agents+sessions；team add/remove 完整；MockDispatcher 可复用；Realtime 基座就绪
- 需新增：Agents CRUD 全套、ArtifactsModule（4端点+校验+归档链+事件注册）、sessions active 过渡、验收联动（accepted_flag/409/退回）、AdminGuard 落地、users 创建/重置密码、角色矩阵 CRUD、artifact ID 前缀

## 研究结论（前端）
- tokens.ts 与原型逐字一致；导航 6 项就绪；ui 8 + chat 5 组件已迁移
- 4 页原型就绪：agent-config→/agents、user-management→/users 替换占位；role-permission→新建 /roles；task-detail 不迁移（产出物聚合页取代）

## 技术决策（初步）
- mock 归档事件注入：复用 MockDispatcher 模式新建 ArtifactsMockConsumer
- 验收联动：accept 事务内标记 accepted_flag + 409 不可变 + append 退回
