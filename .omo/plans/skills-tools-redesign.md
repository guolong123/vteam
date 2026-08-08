# 技能与工具管理（SkillsToolsModule 重构）

> 起因：用户指出 skills/tools 新增操作"与 UI 不符、内部实现未按设计文档"。核对 09 篇 §3.8 + 11 篇确认现有 SkillsModule/ToolsModule 是自创简化版（9 项偏差）。用户决策：MCP 本轮做完整 + worker 注入真实接线。
> 验证：Metis（4 必改点 + 3 高优补项）+ Oracle（三块技术实测全部可行）均已采纳。

## 设计依据（事实源）
- **09 篇 §3.8 SkillsTools**（175-184 行）：POST /skills（multipart SKILL.md）、PATCH /skills/:id/status（{enabled}）、GET /skills（enabled 过滤 + [admin] 成员只读已启用）、POST /tools（{name, execution, schema?, initCommand?, mcpServer?} 无独立 source）、GET /tools（source? 过滤 + 来源徽章）、PATCH /tools/:id（{schema?, initCommand?, enabled?}）；**无 DELETE 端点**（工具不提供 DELETE：权限点悬空）；[admin] 权限标注
- **11 篇**：工具=代码函数/Skills=SKILL.md/MCP=外部服务器（§2）；工具名即权限 action FR-48；自定义工具 .opencode/tools/*.ts 目录扫描（§3.2）；Skills 目录发现 SKILL.md 6 处路径（§4.2）；MCP local/remote + <server>_<tool> + 三态监控（§5）；注册→暴露→权限过滤链路（§6）；平台资源管理 v1 写文件+重启（§7）；MCP 三态上报控制面（§5.8）
- **08 篇 §3.1**：SkillsToolsModule = 技能上传、工具注册（代码/CLI/HTTP/MCP + 初始化命令）与 schema 绑定
- **06 篇 §2.8/§2.9**：agent 配置页工具行（启用开关+action+来源徽章+effect 三态）、技能工具管理页
- **04 篇** FR-27/34/35/48

## 架构决策（已采纳验证结论）

### D1. 端点契约对齐（09 §3.8，Metis 必改点 3）
- POST /skills = multipart 上传 SKILL.md（frontmatter 解析 name/description/version/allowed-tools）；内容落库（fileMeta 存元数据 + **content 新列存全文**）
- PATCH /skills/:id/status = {enabled} 启停专用；GET /skills 成员只读可见已启用
- POST /tools = {name, execution, schema?, initCommand?, mcpServer?}（**去 source 入参**，execution=mcp→source=mcp，其余→custom；builtin 走 seed）
- **删 DELETE /skills + /tools**（09 §3.8 明确不提供 DELETE；停用 enabled=false 替代）
- **AdminGuard**：skills/tools 管理端点加 AdminGuard（复用 users/admin.guard.ts）；GET 成员只读（enabled=true 过滤）
- 迁移：表数据零迁移（source 列保留展示）；前端 4 处调用点同步（无外部消费者，直接改契约）

### D2. worker 注入真实接线（Oracle 实测 + Metis 必改点 1/2）
- **命令通道 T4a**：扩展心跳响应携带 `command: "reload-config"`（09 §3.9 已预留 {command?}）；worker registry-client 解析执行；pull 模型 10s 延迟可接受；**同时服务 Agent 配置变更重启**（09 §3.7）
- **注入执行器 T4b**：renderGitToolsFile 泛化为 renderCustomToolFile（execution 分支 cli→spawnSync/http→fetch/code→内联）；写 <workDir>/.opencode/tools/*.ts + <workDir>/.opencode/skills/<name>/SKILL.md + <workDir>/opencode.json mcp 节；SKILL.md 内容经 GET /skills/:id/content 拉取（worker 无法读 server 本地盘）
- **重启执行器 T4c**：OpencodeServer.restart() = stop+start + 重启后重新注册；**无活跃会话才重启**（单 serve 实例，任务组隔离本轮无法兑现——Metis 必改点 2）
- `--pure` 只禁插件不影响配置读取（Oracle 实测）；opencode.json 项目级配置与全局 mcp 节合并行为集成时验证

### D3. MCP 资源模型（Oracle 实测 + Metis 高优补项 7）
- **T8a**：mcp_servers 表（name unique/type local|remote/command Json?/url?/headers Json?/oauth Json?/enabled）+ CRUD + 配置校验
- **T8b**：mcp_servers → opencode.json mcp 节生成（配置格式实测一致）；tools.mcpServer 列存 server id
- **T8c**：三态监控 = worker 定时 spawnSync("opencode", ["mcp","list","--pure"]) 解析行文本（✓/✗ + 状态词，剥 ANSI）；**30-60s 节流**（不能每 10s 心跳 spawn 子进程）；needs_auth 用真实 OAuth 补验一次；状态随心跳上报；本轮不做 auth 流程本身（范围收敛）

### D4. 前端对齐（Metis 必改点 4）
- **api.ts FormData 支持**：检测 FormData 跳过 JSON.stringify + 不设 Content-Type（multipart 前置）
- skills 页：multipart 上传 / status 端点 / 成员只读 UI（非 admin 隐藏操作）
- tool-register：去 source 字段 + 来源徽章展示
- **agent 配置页**：技能区 SKILL_POOL 硬编码 → GET /skills（enabled=true）真实拉取；工具区启发式来源 → GET /tools 显示 action/source/enabled + effect 三态

## 任务分解（T1-T12 + F1-F4）

- [x] T1 后端 SkillsModule 重构：multipart 上传 + frontmatter 解析 + content 落库 + status 端点 + AdminGuard + 删 DELETE + GET 成员只读
- [x] T2 后端 ToolsModule 重构：去 source 入参（execution 推导）+ PATCH 收敛 + AdminGuard + 删 DELETE
- [x] T3 注册→权限命名空间联动：GET /tools（enabled=true）可用过滤 + 停用工具在 agent 配置页不可见
- [x] T4a 命令通道：心跳响应携带 commands + worker 解析执行（复用 AgentsModule 配置变更重启）
- [x] T4b 注入执行器：renderCustomToolFile 转写 + SKILL.md 写入 + mcp 节生成 + GET /skills/:id/content 拉取
- [x] T4c 重启执行器：OpencodeServer.restart() + 重启后重新注册 + 无活跃会话才重启判定
- [x] T5 前端 api.ts FormData 支持 + skills 页对齐（multipart 上传/status 端点/成员只读 UI）
- [x] T6 前端 tool-register 对齐（去 source 字段 + 来源徽章）
- [x] T7 前端 agent 配置页联动（技能区 GET /skills 真实拉取 + 工具区 GET /tools + effect 三态）
- [x] T8a 后端 MCP 服务器实体：mcp_servers 表 + CRUD + local/remote 配置校验
- [x] T8b worker MCP 注入：mcp_servers → opencode mcp 节生成（--pure 兼容验证）
- [x] T8c MCP 三态监控：worker 探测（opencode mcp list 30-60s 节流）+ heartbeat 扩展 + 控制面展示
- [x] F1 契约对齐审计（oracle）：逐端点对照 09 §3.8
- [x] F2 回归审计（oracle）：agents 三表事务/workers 分派无回归
- [x] F3 worker 注入端到端 QA（oracle）：SKILL.md 注入后 skill 工具可见性 + 重启会话中断代价验证（F3-1 content TEXT + F3-2 spawnSync 已修复，173/173 + 534/534 全绿）
- [x] F4 前端 UX 审计（oracle）：agent 页真实来源徽章 + MCP 三态真实数据 + 非 admin 只读（APPROVE：来源徽章真实驱动、MCP 三态全链路真实、无 P1；P2 记录 tool-register 孤儿路由非前置隐藏）

## 并行/串行依赖
```
T1 ──┬─→ T2 ──→ T3
     ├─→ T5（契约冻结可早开）
T4a（独立）→ T4b（依赖 T1+T4a）→ T4c（依赖 T4b）
T8a（可并行 T4b）→ T8b → T8c
T5 → T7（依赖 T3+T5）；T6 依赖 T2
F1-F4 ← 全部
```
- 并行：T1 ∥ T4a ∥ T8a ∥ T5；T4b 后 T4c/T8b 并行
- 关键路径：T1 → T4b → T4c → F3

## 关键验证点（Oracle 实测）
- multer 已就绪（platform-express 传递依赖，零新增依赖）
- SKILL.md frontmatter：name/description/version/allowed-tools（实测 ~/.config/opencode/skills/）
- 注入落点：<workDir>/.opencode/skills/<name>/SKILL.md（serve cwd 已对齐 workDir）
- opencode mcp list --pure 输出可解析（✓/✗ + 状态词，ANSI 需剥色，退出码恒 0）
- 工具注入模板：git-tools.ts renderGitToolsFile 泛化
- 指令通道：心跳 {command?} 扩展（09 §3.9 预留）
- 重启：OpencodeServer stop/start 已有；单实例（无 TaskGroupRegistry）→ 无活跃会话才重启

## 已知范围收敛
- 本轮不做 MCP auth 流程本身（11 §5.8：OAuth 在 worker 本地，控制面只展示 needs_auth 引导）
- worker 多实例化（TaskGroupRegistry）不在本轮（重启隔离收益后续实现）
- skills 编辑（PATCH /skills/:id 非契约端点）前端移除或保留为扩展（T5 决策）
