# Task 4 — 数据表清单（schema 落库）

## 说明

规格 15 篇 §7.1 全表总览为 20 张（含预留表 `audit_logs`）。本版按「预留不建」处理，实际建出 **19 张业务表**，`audit_logs` 不建。

## 建出表清单（19 张）

| # | 表 | 域 | 类型 |
|---|----|----|------|
| 1 | `users` | 认证/用户 | 业务主表 |
| 2 | `roles` | 认证/用户 | 业务主表 |
| 3 | `projects` | 项目 | 业务主表 |
| 4 | `project_members` | 项目 | 关系表 |
| 5 | `agents` | Agent | 业务主表 |
| 6 | `agent_skills` | Agent | 关系表 |
| 7 | `agent_tool_effects` | Agent | 关系表 |
| 8 | `skills` | 技能工具 | 业务主表 |
| 9 | `tools` | 技能工具 | 业务主表 |
| 10 | `tasks` | 任务 | 业务主表（状态机核心） |
| 11 | `task_agents` | 任务 | 关系表（虚拟团队） |
| 12 | `task_events` | 任务 | 事件表 |
| 13 | `sessions` | 会话 | 业务主表 |
| 14 | `chat_channels` | 群聊 | 业务主表 |
| 15 | `messages` | 群聊 | 业务主表 |
| 16 | `artifacts` | 产出物 | 业务主表 |
| 17 | `artifact_versions` | 产出物 | 版本体 |
| 18 | `workers` | Worker | 业务主表 |
| 19 | `task_group_instances` | Worker | 关系表 |

## 未建（预留）

| 表 | 说明 |
|----|------|
| `audit_logs` | 预留表，本版不建（15 篇 §3.10/§7） |

## 唯一约束（对照 15 篇 §4.3）

| 表 | 唯一约束 | 语义 |
|----|---------|------|
| `users` | `username`、`email` | 账号唯一 |
| `project_members` | `(project_id, user_id)` | 用户在一项目内唯一 |
| `task_agents` | `(task_id, agent_id)` | Agent 在任务团队内唯一 |
| `sessions` | `(task_id, agent_id)` | 每 Agent 每任务独立会话 |
| `artifact_versions` | `(artifact_id, version)` | 版本号唯一 + 并发 append 乐观锁 |
| `chat_channels` | `(task_id, agent_id)` | task_group 每任务一频道（NULL 不参与唯一判定） |
| `agent_skills` | `(agent_id, skill_id)` | 技能绑定唯一 |
| `agent_tool_effects` | `(agent_id, tool_action)` | 工具权限点唯一 |
| `tools` | `action` | 工具名即权限点唯一 |

## 索引（对照 15 篇 §5.1）

| 表 | 索引 |
|----|------|
| `tasks` | `(project_id, status)` → `idx_tasks_project_status` |
| `task_agents` | `(task_id, joined_at)` → `idx_task_agents_task` |
| `task_events` | `(task_id, created_at)` → `idx_task_events_task_time` |
| `messages` | `(channel_id, id)` → `idx_messages_channel_id` |
| `artifacts` | `(task_id, type)` → `idx_artifacts_task_type`；`(task_id)` → `idx_artifacts_task` |
| `workers` | `(status, last_heartbeat_at)` → `idx_workers_status_heartbeat` |

## 落库验证

```sql
-- sqlite_master 查询结果（python3 sqlite3 读取 prisma/dev.db）
-- TABLE COUNT: 19
-- 表名：agent_skills, agent_tool_effects, agents, artifact_versions, artifacts,
-- chat_channels, messages, project_members, projects, roles, sessions, skills,
-- task_agents, task_events, task_group_instances, tasks, tools, users, workers
```