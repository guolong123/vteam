# 证据：09 篇新增 §6「群聊与消息机制」重点功能专章

日期：2026-08-06
目标文件：`docs/agent-platform/09-API设计.md`（702 行，由 504 行扩至 702 行，新增 199 行）
变更：新增独立专章 §6「群聊与消息机制（重点功能专章）」，原 §6/§7/§8 顺延为 §7/§8/§9，同步更新 7 处交叉引用。

## 新增章节结构

| 小节 | 内容 |
|------|------|
| §6.1 消息模型 | 消息三态（user/agent/system，senderType，FR-10）；内容 Part 五类与群聊展示规则表（text 直接展示 / reasoning 默认折叠 / tool 卡片三态 / file 入文档库 / aborted 显示「已中断」）；消息结构 8 字段表（id 兼作 SSE 游标、content、mentions、status 等） |
| §6.2 频道模型 | task_group vs private 表（FR-09 每任务一个群聊 / FR-14 私聊群聊共用会话）；成员构成（人类 project_members + Agent 虚拟团队 FR-02）；表关系图 chat_channels→messages→sessions（08 篇 §6） |
| §6.3 @ 触发机制 | mentions 解析（@agent/@all → mentions 数组，服务端二次校验）；触发分派链路（上下文注入 FR-15 → worker prompt）；三种触发表（定向 FR-11 / @all FR-12 / Agent 互 @ FR-13，3 轮上限 + 循环检测）；dispatch 状态机（pending/processing/completed/failed）；Mermaid 端到端时序（用户 @ 产品经理 → 落库 → 上下文注入 → Loading 两阶段 → task.completed 回流 → 广播） |
| §6.4 消息流与实时性 | 三级 SSE 在群聊的阶段-事件对应表（用户消息/处理中/内部过程不广播 FR-18/完成/失败）；时序约束（loading→final/error 按 messageId 聚合）；性能目标 ≤1s（05 篇 1.1） |
| §6.5 消息历史与游标 | REST cursor 分页（§2.2 详述）；SSE since 与 REST cursor 同源（消息主键）；私聊历史（FR-14 上下文连续，FR-15 注入来源）；归档可追溯 |
| §6.6 消息状态机与错误处理 | 生命周期（用户 sending→sent；Agent pending→processing→completed/failed）；Loading 两阶段表（thinking/operating，FR-20）；错误三层表（工具级/消息级 8 种/重试级，FR-21）；重试路径（成员重新 @，单 Agent 隔离） |
| §6.7 边界与一致性 | 7 项边界表：持久化（FR-19）/ 不支持撤回编辑（FR-19 边界）/ 系统消息自动生成 / 私聊群聊上下文连续（FR-14）/ 单 Agent 失败隔离 / 删除边界（无 DELETE 端点）/ 幂等（08 §6.3） |

## 交叉引用更新（原 §6→§7、§7→§8、§8→§9）

| 位置 | 原文 | 改为 |
|------|------|------|
| §1 表格 | 由控制面翻译衔接（§6） | （§7） |
| §1 边界 | 仅按 08 篇 §8 做模块/接口占位（§7） | （§8） |
| §2.3 worker 标记 | 与用户权限体系完全隔离（§6） | （§7） |
| §3.9 尾注 | 由 WorkersModule 的 WorkerClient 内部调用（§6） | （§7） |
| §5.3 安全隔离 | 与用户权限体系分离（§6） | （§7） |
| §5.4 文件拉取 | 分属两套边界（§6） | （§7） |
| §7 演进解耦 | 只动对外契约层（§7） | （§8） |

## 验证结果

| 检查 | 结果 |
|------|------|
| md-docs build 退出码 | ✅ 0 |
| dev 服务 HTTP 200（:5199） | ✅ |
| curl 注入 key-09（`__x00__virtual:md-docs-content` 含 09 篇） | ✅ count=1 |
| 注入含「群聊与消息机制」+ chat.message.new / message.part.delta | ✅ |
| 章节编号连续（## 1~9，无断号） | ✅ |
| §6 子章节 6.1~6.7 | ✅ 7 节 |
| grep 断言：群聊与消息机制 / 消息状态机 / @ 触发机制 / 三级 SSE 在群聊 / Loading / 错误三层 / dispatch / mentions 解析 / 互 @ 循环控制 / 不支持撤回编辑 | ✅ 全命中 |
| Mermaid 时序图块（原 2 + 新 1） | ✅ 3 块 |
| 仅改 09 篇，未动其他文档 | ✅ |

## 一致性锚点

- 03 篇 FR-09~21 → §6 各小节逐条引用（FR-10 消息模型/Part 展示、FR-11/12/13 @ 触发、FR-14 共用会话、FR-15 上下文注入、FR-18 不广播、FR-19 持久化与撤回边界、FR-20 Loading 两阶段、FR-21 错误三层 8 种）
- 08 篇 §6 表（chat_channels/messages/sessions）→ §6.2 表关系图 + §6.1.3 字段对齐（sender_type/content Json/mentions Json/created_at）
- 09 篇既有 §3.5 Chat 端点 / §4.2 事件契约 / §5.1 发消息详设 → 新专章以「引用 + 扩展」衔接（§5.1 已详的 8 步流程与 DTO 不再重复，聚焦生命周期视角）
- 05 篇 1.1 ≤1s 目标 → §6.4 性能目标
- 08 篇 §7.3 先落库后转发 → §6.4 时序说明
