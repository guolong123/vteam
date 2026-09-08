# fix.md — 修复 diff 摘要（仅产品代码 1 文件 + 回归 spec 1 文件）

## server/src/chat/chat.service.ts（3 hunk，均在 createMessage）
1. `isTeamPrivate` 判定 + `effectiveTaskId` 团队私聊置 null
   （阻断 currentTask 合成上下文渗入；DM 不写 taskId）。
2. 私聊无 @ 回退：`triggers.length===0 && channel.teamMemberId` →
   `buildTeamMemberTrigger(teamId, teamMemberId)` 补 dispatched 对端触发
   （失败仅日志，不阻断发消息落库）。
3. `dispatchTaskId` 团队私聊恒 `''`（`teamId` 照常透传）→ dispatcher
   `teamMode` 分支全链路 team-mode。

## server/src/chat/chat.service.spec.ts（+1 describe，2用例）
- `私聊无 @ → 对端成员回退触发 dispatched + team-mode 分派`
  （trigger 形状 + dispatch `{taskId:'', teamId, targets:[tmm_]}` +
  落库 data 无 taskId）。
- `团队有 currentTask 时私聊仍走 team-mode`
  （DM-tab 真实形状 mentions:[{agentId}]，断言不走 ta_ 快照）。
- Failing-first：fix 中 `isTeamPrivate` 置 false → 2 红（EXIT:1）；
  恢复 → 全绿。

## 未触碰
schema/migration/seed、docs、e2e、前端；ingress/dispatcher/realtime
零改动（证伪无辜）。其余 worktree 脏文件为并行会话所有，未触碰。
