# Evidence: 15-数据模型细化（ER 图）

## 变更

**新建文件**：`docs/agent-platform/15-数据模型细化（ER图）.md`（702 行，frontmatter: title=数据模型细化（ER 图）/ id=data-model-er / order=15 / kind=技术设计）。

**内容覆盖（7 节详设）**：
- §1 定位与文档关系：08 §6.1 表清单逐表落库依据；13/12/14/10/09 篇字段依据收敛点；表数量口径说明（08 §6.1 实际 20 张，含 audit_logs 预留；08/09 篇正文"21 表"为计数口径差异，以表格清单为准）
- §2 字段类型约定：MySQL↔SQLite 类型映射表（BIGINT↔INTEGER/JSON↔TEXT/DATETIME↔TEXT/ENUM↔TEXT+CHECK/BOOLEAN↔INTEGER 等）、业务主键策略（VARCHAR(64) 域前缀+自增序号 t_1/e_1024，与 09/10/13 篇 string id 一致，序号单调保证 SSE 游标）、通用约定（无软删除列、uk_/idx_ 命名、外键 RESTRICT）、四类分域标注表
- §3 逐表字段定义：20 表全量字段表（每表含约束列与来源列）——users/roles（permissions Json 矩阵 FR-23）/projects/project_members/tasks（五态+五时间戳+version 乐观锁）/task_agents（removed_at 标记）/task_events（event_type/from/to/actor/metadata）/sessions（四态 created/active/frozen/archived）/chat_channels/messages（content Json+mentions Json）/artifacts/artifact_versions（sha256/accepted_flag/uk(artifact_id,version)）/agents（12 字段+base_agent_id）/agent_skills/agent_tool_effects/skills/tools（action 唯一=权限点/mcp_server/schema/init_command）/workers/task_group_instances/audit_logs（预留不建+建表计划）
- §4 关系与约束：mermaid erDiagram 完整 20 表关系图（标注 N:M 经关系表、agents 自关联 base_agent_id）；9 条关键关系说明表；10 条唯一性约束汇总（task_agents/sessions/artifact_versions/chat_channels/messages.id 游标同源）；级联策略表（归档不删内容 FR-05/移除标记/外键全 RESTRICT）
- §5 关键索引设计：查询场景→索引表（10 个索引：看板 project_id+status/消息分页 channel_id+id/产出物 task_id+type/会话 uk(task_id,agent_id)/worker 心跳 status+last_heartbeat_at 等）；联合/覆盖索引与 SSE 游标同源说明（messages.id 主键即游标，序号单调避 t_10<t_2 陷阱）
- §6 数据一致性要点：状态机 tasks.status+task_events 同事务三段式（乐观锁 CAS）；事件幂等（task_events 不设 (task_id,from,to) 唯一索引的原因——reject 循环合法重复；worker 事件 (instance_id,event_id) 去重；sha256 去重）；accepted_flag 与 accept 同事务联动；双库 DDL 策略 6 行
- §7 表清单总览与开放问题：20 表总览表（域/表/类型/用途/详设落点）；5 项开放问题（audit_logs 启用时机/大字段存储演进/messages 增长归档/主键序号分布化/软删除边界）

## 验证结果

- `md-docs build` exit=0（构建完成 → /tmp/opencode/md-docs-dist）
- grep 断言：erDiagram×1、BIGINT×2、accepted_flag×8、task_agents×17、联合索引×1、mermaid 块 1（≥1 要求）
- dist bundle 注入确认：assets JS 含 data-model-er×1、数据模型细化×1、task_agents×14、accepted_flag×20
- dev 服务注入确认：`/@id/__x00__virtual:md-docs-content` 含 data-model-er×1 + 数据模型细化×1
- 未修改 01-14 篇（仅新建 15 篇）

Tags: data-model, er-diagram, ddl, mysql-sqlite-compat
