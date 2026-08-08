# 证据：13-任务状态机与全生命周期.md

**日期**：2026-08-06
**文件**：`docs/agent-platform/13-任务状态机与全生命周期.md`（408 行）

## 验证结果

| 检查项 | 结果 |
|--------|------|
| md-docs build | exit=0（构建完成 → dist/） |
| 文档行数 | 408 行（≥300 要求） |
| mermaid 块 | 2 块（§3.1 stateDiagram-v2 状态机 + §6.1 sequenceDiagram 生命周期时序） |
| grep「状态机」 | 16 处 |
| grep「accepted_flag」 | 9 处 |
| grep「mark-pending-review」 | 13 处 |
| grep「回收 worker 实例」 | 3 处 |
| grep「幂等」 | 11 处 |
| dist 注入 | `dist/assets/index-D85fkp-n.js` 含 task-state-machine ×1、任务状态机与全生命周期 ×3、accepted_flag ×19 |

## 结构（9 节）

1. 定位与文档关系（FR-01~08 依据、09 §3.4 落点、08 §6.3 唯一事实源）
2. 任务实体模型（tasks 表展开 + 创建即生成三件套：群聊/文档库/背景文档）
3. 五态状态机（mermaid stateDiagram + 迁移总表 + 无效迁移 409）
4. 各迁移详设（创建/start/mark-pending-review/accept/reject/archive 六小节）
5. 状态变更事件与联动（task_events 表 + SSE + 系统消息）
6. 跨模块联动时序（mermaid sequenceDiagram + reject 二次循环）
7. 权限与边界（执行人权限/幂等/本版边界/冲突处理）
8. 状态机实现要点（服务端集中校验/乐观锁并发/worker 实例绑定）
9. 开放问题（5 项）

## 关键设计决策

- 状态枚举：pending/in_progress/pending_review/completed/archived（对齐 09 §2.1 错误示例 from=pending）
- 已完成→进行中虚线回边为自动迁移（FR-04 验收后更新），非 REST 动作
- 归档后操作限制表：状态迁移端点 409、team 禁止、发消息禁止、产出物拒绝
- 并发：tasks 表 CAS 式状态更新 + task_events 幂等键 + artifact_versions 乐观锁
- 任务状态与 worker 实例解耦：worker 自愈不改变任务状态
