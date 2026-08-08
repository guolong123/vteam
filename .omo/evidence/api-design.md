# 证据：09 篇 API 设计完成

日期：2026-08-06
目标文件：`docs/agent-platform/09-API设计.md`（448 行，frontmatter title: API 设计 / id: api-design / order: 9 / kind: 技术设计）

## 交付内容

1. **定位与文档关系**（§1）：09 篇 = 08 篇接口落地（继承表）；**对外 API ≠ worker 协议** 声明；FR 依据范围；07/08 篇 `/api/workers/register` 前缀统一收敛为 `/api/v1`（语义不变，不推翻 08 篇）。
2. **通用约定**（§2）：REST `/api/v1` + Bearer JWT（access 2h + refresh 7d）；统一错误响应 `{code, message, details?}`（错误码表 400/401/403/404/409/500）；分页双轨（列表 page/pageSize、消息/事件 cursor 游标同源消息主键）；权限落地标记 `[admin]/[project]/[worker]` + 矩阵「查看/创建/编辑/删除/验收/管理」→ HTTP 语义映射 + 删除仅限可删对象（FR-23 边界）。
3. **REST 端点清单**（§3）：10 个模块 50+ 端点（Auth/Users/Projects/Tasks/Chat/Artifacts/Agents/SkillsTools/Workers/Permissions），每端点 方法+路径+请求/响应要点+权限+FR 依据；任务五态迁移端点与状态图；产出物落库主路径为 worker 事件驱动、成员辅助提交为 P1 入口；工具不提供 DELETE（停用替代）；worker 内部端点（instances/prompt/abort 等）不对外暴露。
4. **SSE 事件设计**（§4）：统一事件帧 `{id, type, data, timestamp}`；前端订阅端点 `GET /events`（scope 过滤）+ `GET /sessions/:id/stream`（按需订阅，FR-18 不广播）；7 个前端事件表；worker 6 事件消费表（幂等落库→业务处理→转前端）；游标续拉三场景（since 补拉/会话重放/历史兜底）。
5. **关键接口详设**（§5）：发消息+@触发（8 步处理流程 + Mermaid 时序 + DTO 示意）；会话流查看（按需订阅/只读/鉴权/生命周期）；Worker 注册与心跳（DTO + 注册即入池 + outbound 启停指令 + 安全隔离）。
6. **对外 API vs worker 协议关系**（§6）：七维对比表 + 翻译链示意 + 分离三理由（安全面/语义隔离/演进解耦）。
7. **本版 vs 下一版预留**（§7）：通知/搜索/审计/WebSocket/会话续接不新增端点仅占位；`/api/v1` 版本化。
8. **风险与开放问题**（§8）：5 项（游标耦合/@ 异步割裂/幂等键/归档失败/补拉窗口）。

## 验证结果

| 检查 | 结果 |
|------|------|
| curl 注入命中 09 key（`http://localhost:5177/@id/__x00__virtual:md-docs-content`，`"/docs/agent-platform/09-API设计.md"`） | ✅ count=1 |
| md-docs build `--out-dir /tmp/site-09` 退出码 | ✅ 0 |
| 章节结构 `## N.` 数量 | ✅ 8 章连续 |
| 模块端点表（`### 3.x`） | ✅ 10 节 |
| 关键端点断言（channels/:id/messages ×8 / sessions/:id/stream ×3 / workers/register ×3 / since ×6 / 心跳 ×7） | ✅ 全命中 |
| 关键事件断言（chat.message.new ×11 / message.part.delta ×3 / task.completed ×6 / 游标续拉 ×2 / 不广播 ×2） | ✅ 全命中 |
| 权限锚点（FR-23 ×12 / FR-24 ×5 / FR-48 ×3） | ✅ 全命中 |
| 反断言（CREATE TABLE / INSERT INTO / npm install / import { / @nestjs/swagger 实现代码） | ✅ 0（设计级无实现代码） |
| 仅创建 09 篇，未动 01-08 与原型 | ✅ |
| 08 篇未修改（mtime 18:19 早于本次） | ✅ |

## 一致性锚点

- 08 篇 §3.1 模块划分 → §3 端点按模块组织（同模块名）
- 08 篇 §3.3 WorkerClient/WorkerSseClient + 07 篇 11.3 端点 → §6 关系表 + §5.3 注册详设
- 08 篇 §7.2 统一 SSE + 游标续拉 → §2.2/§4.1/§4.4
- 08 篇 §6.3 worker 事件幂等 → §4.3 消费表
- 03 篇 FR-01~27、04 篇 FR-30~48 → §3 各端点依据列逐条引用
- 05 篇性能指标（≤1s/≤5s/≤2s）→ §5.1/§5.2 注释
- 07 篇 11.2 注册协议（outbound）→ §5.3 注册即入池 + 心跳响应携带启停指令
