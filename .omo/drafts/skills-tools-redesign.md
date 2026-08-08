# Draft: 技能与工具管理（SkillsToolsModule 重新设计）

> 起因：用户指出新增的 skills/tools 操作"与 UI 不符、内部实现未按设计文档"。核对 09 篇 §3.8 + 11 篇后发现现有 SkillsModule/ToolsModule 是自创简化版，多项偏离设计契约。本计划按设计文档重做。

## 设计依据（事实源）
- **09 篇 §3.8 SkillsTools**（175-184 行）：端点契约——POST /skills（multipart SKILL.md 上传）、GET /skills（enabled 过滤）、PATCH /skills/:id/status（启停）、POST /tools（{name, execution, schema?, initCommand?, mcpServer?}）、GET /tools（source 过滤）、PATCH /tools/:id（{schema?, initCommand?, enabled?}）；[admin] 权限标注
- **11 篇**（资源与注册机制）：工具=代码函数注册、Skills=SKILL.md 文件、MCP=外部服务器（§2 全景）；工具名即权限 action FR-48（§2 末）；自定义工具两路径（目录扫描/插件 §3.2）；Skills 目录发现 SKILL.md（§4.2）；MCP 配置 local/remote + <server>_<tool> 命名 + 三态监控（§5）；注册→暴露→权限过滤完整链路（§6）；平台资源管理模型（§7：三类资源生命周期、资源×Agent 绑定、v1 写文件+重启 vs v2 热更新）
- **08 篇 §3.1**：SkillsToolsModule = 技能上传、工具注册（代码/CLI/HTTP/MCP + 初始化命令）与 schema 绑定（FR-27）
- **04 篇** FR-27/FR-34/FR-35/FR-48；**06 篇 §2.8/§2.9**（agent 配置页工具行 + 技能工具管理页交互）

## 现有实现偏差（需修正）
见上方偏差清单 1-9。核心：端点契约不符、无 [admin] 权限、缺注册→权限命名空间→Agent effect 联动、缺 worker 注入生效链路、缺 MCP 资源模型。

## 重新设计要点
### A. 端点契约对齐（09 篇 §3.8）
- `POST /api/v1/skills`：multipart/form-data 上传 SKILL.md（解析 frontmatter：name/description；文件内容存 fileMeta 或新列）；默认停用
- `PATCH /api/v1/skills/:id/status`：`{enabled: boolean}` 启停专用
- `GET /api/v1/skills`：enabled? 过滤 + 分页；[admin] 全量，成员只读可见已启用
- `POST /api/v1/tools`：`{name, execution: code|cli|http|mcp, schema?, initCommand?, mcpServer?}`——**去掉独立 source 入参**（source 由 execution/注册方式推导：builtin/custom/mcp）
- `PATCH /api/v1/tools/:id`：`{schema?, initCommand?, enabled?}` 更新工具定义
- `GET /api/v1/tools`：source?（builtin/custom/mcp）过滤 + 分页 + 来源徽章

### B. [admin] 权限（09 篇 §3.8 标注）
- skills/tools 管理端点（POST/PATCH/DELETE）加 AdminGuard；GET 成员可读（已启用过滤）

### C. 注册→权限命名空间→Agent effect 联动（FR-48，11 篇 §6/§7.3）
- 工具注册成功 → action 进入权限命名空间（工具名即权限点）
- agent 配置页工具行（06 篇 §2.8）：启用开关 + action + 来源徽章 + effect 三态 → 联动 agent_tool_effects
- 技能授权（FR-34）：agent 配置页技能勾选 → 联动 agent_skills
- 停用联动：工具停用 → Agent 无法调用；技能停用 → 已勾选 Agent 不再注入

### D. worker 注入生效（11 篇 §7.2，v1 当前基线）
- 资源变更 → 控制面下发"资源配置 + 触发生效"指令 → worker v1 写文件 + 重启实例（或 v2 transform 热更新，预留）
- 工具（自定义）→ 转写 .opencode/tools/*.ts 注入实例；Skills → SKILL.md 写入任务组 skills 目录；MCP → 生成 mcp 配置节

### E. MCP 资源模型（11 篇 §5.8，本轮或标记下轮）
- MCP 服务器实体（CRUD + local/remote 配置）+ 可用性三态监控（needs_auth/connected/failed）——**考虑规模，可列为下轮**，本轮先做 skills/tools 核心

## 工作分解（草案，待 Metis/Oracle 验证）
- [ ] T1 后端：SkillsModule 重构对齐端点（multipart 上传 + status 端点 + [admin]）
- [ ] T2 后端：ToolsModule 重构对齐端点（去 source 入参 + [admin] + 来源推导）
- [ ] T3 后端：注册→权限命名空间联动（agent_tool_effects/agent_skills 关联）
- [ ] T4 worker：资源注入生效链路（.opencode/tools 转写 + SKILL.md 写入 + 重启指令）
- [ ] T5 前端：skills 页对齐（上传 SKILL.md 文件 + 启停 status 端点）
- [ ] T6 前端：tool-register 对齐（去 source 字段 + 来源徽章展示）
- [ ] T7 前端：agent 配置页工具行/技能区联动（06 篇 §2.8）
- [ ] T8 MCP 资源模型（local/remote CRUD + 三态监控）——规模确认后定本轮/下轮
- [ ] F1-F4 Final Wave

## 待确认
- [x] **MCP 本轮做**：MCP 资源模型（local/remote CRUD + 三态监控 + worker 注入）完整实现
- [x] **worker 注入真实接线**：资源变更 → 控制面下发配置 → worker 写文件 + 重启实例（v1 生效链路真实实现，非骨架）

## 验证结论（Metis + Oracle 已采纳）
### Metis 必改点（4）
1. **补命令通道任务 T4a**：现状无任何 server→worker 命令通道（心跳响应被忽略、控制协议无 restart 端点）——pull 模型（心跳携带 commands）为最小改动
2. **修正重启隔离假设**：现有 worker 单 serve 实例（无 TaskGroupRegistry）——"任务组隔离重启"本轮无法兑现；T4c 验收定义「无活跃会话才重启」或降级后续会话生效
3. **删 DELETE 端点 + 补 GET [admin] 只读过滤**：偏差清单漏列 DELETE /skills + /tools 超集（09 §3.8 明确工具不提供 DELETE）；GET /skills 成员只读可见已启用
4. **补前端 FormData 前置 + agent 配置页真实数据源**：api.ts 强制 JSON 需改造；agent 页硬编码 SKILL_POOL/启发式来源需替换

### Metis 高优补项（3）
5. T4a 命令通道同时服务 Agent 配置变更重启（09 §3.7）
6. SKILL.md 内容落库（DB 新列）+ worker 拉取端点（分布式 worker 无法读 server 本地盘）
7. MCP 三态探测节流（30-60s 而非 10s 心跳内 spawn 子进程）

### Oracle 实测结论（三块技术全可行）
- multer 已就绪（platform-express 传递依赖，零新增）；SKILL.md frontmatter 格式实测（name/description/version/allowed-tools）；存储=DB（fileMeta 存元数据 + content 新列存全文）
- 工具注入：renderGitToolsFile 可泛化为 renderCustomToolFile（execution 分支 cli→spawnSync/http→fetch/code→内联）；OpencodeServer stop/start 已有
- MCP：配置节格式实测一致；opencode mcp list --pure 输出可解析（✓/✗ + 状态词，含 ANSI 需剥色）；`--pure` 只禁插件不影响配置读取；needs_auth 需真实 OAuth 补验
- 指令通道：扩展心跳响应 command: reload-config（09 §3.9 已预留 {command?}）最轻路径
- 迁移：表数据零迁移；前端 4 处调用点同步（POST /skills→multipart、PATCH status、POST /tools 去 source、skills 编辑决策）+ AdminGuard（roleId 校验）

## 正式任务分解（T1-T12 + F1-F4）
- [ ] T1 后端 SkillsModule 重构：multipart 上传 + frontmatter 解析 + content 落库 + status 端点 + AdminGuard + 删 DELETE + GET 成员只读过滤
- [ ] T2 后端 ToolsModule 重构：去 source 入参（execution 推导）+ PATCH 收敛 {schema/initCommand/enabled} + AdminGuard + 删 DELETE
- [ ] T3 注册→权限命名空间联动：GET /tools（enabled=true）可用过滤 + agent 配置页数据源（接 T7）
- [ ] T4a 命令通道：心跳响应携带 commands + worker 解析执行（复用 AgentsModule 配置变更重启）
- [ ] T4b 注入执行器：.opencode/tools 转写（renderCustomToolFile）+ SKILL.md 写入 + mcp 节生成 + GET /skills/:id/content 拉取
- [ ] T4c 重启执行器：OpencodeServer.restart() + 重启后重新注册 + 无活跃会话才重启判定
- [ ] T5 前端 api.ts FormData 支持 + skills 页对齐（multipart 上传/status 端点/成员只读 UI）
- [ ] T6 前端 tool-register 对齐（去 source 字段 + 来源徽章）
- [ ] T7 前端 agent 配置页联动（技能区 GET /skills 真实拉取 + 工具区 GET /tools action/source/enabled + effect 三态）
- [ ] T8a 后端 MCP 服务器实体：mcp_servers 表 + CRUD + local/remote 配置校验
- [ ] T8b worker MCP 注入：mcp_servers → opencode mcp 节生成（--pure 兼容验证）
- [ ] T8c MCP 三态监控：worker 探测（opencode mcp list 30-60s 节流）+ heartbeat 扩展 + 控制面展示
- [ ] F1 契约对齐审计（oracle）
- [ ] F2 回归审计（oracle）
- [ ] F3 worker 注入端到端 QA（oracle）
- [ ] F4 前端 UX 审计（oracle）
