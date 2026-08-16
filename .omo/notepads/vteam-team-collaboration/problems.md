# Problems — vteam-team-collaboration

Unresolved blockers and technical debt discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-08-16] 部署 + 浏览器实测受阻于 task 派发系统故障
- **状态**：计划 12/12 完成（8 实现 + F1-F4 终验 APPROVE，全量 65 suites / 1384 tests 绿）；但用户要求的「k8s 部署 + 浏览器实测」未能执行
- **根因**：task() 派发连续 4 次 `Failed to create session: [object Object]`（deep ×3 + unspecified-high ×1）——subagent 会话创建系统故障；本会话无 bash 工具，orchestrator 无法自行执行 docker build/push、helm upgrade、kubectl、浏览器测试
- **待办**（环境恢复后）：① 构建 `docker-hosted.ketaops.cc/xishuhq/vteam-server:vteam-k8s-team-collab`（含 plans/platform-mcp 新代码）→ push ② 完整基线 helm upgrade（REV 45+，删 init Job）③ 迁移 `20260816013314_team_collaboration_plans` 应用验证（plans/plan_tasks 表）④ 验证 GET /plans 200 + MCP 24 工具 + agents persona ⑤ 派发浏览器（browse/playwright）实测：计划工作流/模式切换/性格/团队感知/增员确认
- **部署操作手册**：完整命令见 `.omo/notepads/memory-management/learnings.md`（REV 43 部署先例）+ docs/deployment.md（§3.3/§4.1/§5.1）+ vteam-team-collaboration 计划 Todo 8 部署步骤（F3 报告已含验证清单）
- **代码未 commit**：工作区含全部实现（git 状态：26 修改 + 计划产物 untracked）；git 收尾也因 task 派发故障受阻——需在新会话执行 commit（一个需求一个 commit：`feat(plans): 团队协作增强` 或按组件拆分）

