# 团队成员增员「脱离任务」改造

## 背景 / 根因

「添加实例」== 创建 `TeamMember`（`tmm_`）。两条入口都被「任务状态守卫」绑死：

| 入口 | 现状 | 守卫 |
|---|---|---|
| Web 会话页「添加实例」 | `POST /tasks/:id/team` | `teamEditable = !!queueHeadTask && status ∈ {pending,in_progress,blocked}`（`web/app/(main)/teams/[id]/session/page.tsx:1297`）；团队空闲 → `queueHeadTaskId=null` → 按钮 disabled（`TeamMembersPanel.tsx:886`） |
| MCP `vteam_team_add_member` | `teamAddMember` → 确认门 → `tasksService.updateTeam` | `taskId` 必填（`platform-mcp.tools.ts:562`）+ `assertWorkerTask` + `updateTeam` 状态守卫（`tasks.service.ts:797-806`） |

用户决策：团队成员增员应**与任务无关**；**保留确认门**；不涉及移除成员/启用禁用/重置会话。

## 设计（已定）

不放松 `updateTeam` 的任务守卫（保住 FR-02 语义），而是**新增团队级路径**并在空闲时改走它。

### Slice A — Web UI 解锁
1. `web/src/components/teams/TeamMembersPanel.tsx`
   - 添加实例入口按钮：`disabled={adding}`（去掉 `!teamEditable`）；title → 「为团队添加成员（自动建会话并绑定）」；`border/color/cursor` 恒为可用态。
   - `openPanel` 守卫（:294）→ `if (adding) return;`。
   - 若 `teamEditable` prop 不再被使用则删除该 prop 并同步调用方。
2. `web/app/(main)/teams/[id]/session/page.tsx`
   - `handleAddInstance(payload)` 分流：
     - `queueHeadTaskId` 非空 → 保持 `POST /tasks/:id/team`（保留群系统消息与任务语义）；
     - 否则 → `teamsApi.addMember(teamId, {roleId?, agentId?, alias?})`，成功后 `invalidateQueries(["team", teamId])`。
   - `adding` = 两个 mutation 的 `isPending` 或；`addError` 取当前活跃 mutation 的错误。
   - 保持 `handleAddInstance: (payload) => Promise<boolean>` 契约不变（面板依赖返回值）。
   - 修正 `teamEditable` 相关文案/传参。
3. e2e：`web/e2e/roles-members.spec.ts` 先建 pending 任务，仍走任务路径，应继续绿；新增「团队空闲可直接添加实例」用例（可后置）。

### Slice B — Server：`teams.service.addMember` 群系统消息对齐
- `server/src/teams/teams.service.ts` `addMember()`：在事务内写 `「{alias} 已加入团队」` 到 `team_group` 频道（复用同文件 984-1067 行 `removeMember` 的既有模式），并按同样口径广播 CHANNEL 消息事件。
- 目的：空闲态增员在群聊可见，与任务路径 UX 一致。
- spec：扩展 `server/src/teams/teams.service.spec.ts`。

### Slice C — Server：MCP `team_add_member` 脱离任务
1. `server/src/platform-mcp/platform-mcp.tools.ts`
   - `teamAddMemberSchema` 改为 team-free 约定：`taskId?` + `teamId?` + `selfInstanceId`(必填) + `agentId`(必填) + `alias?` + `workDir?`；复用 `OPTIONAL_TASK_ID_DESC` / `TEAM_ID_DESC`。
   - 更新工具 description（说明可传 taskId 或 teamId）。
2. `server/src/platform-mcp/platform-mcp.service.ts` `teamAddMember()`
   - 改用 `resolveExecContext(ctx, args)` → `{kind:'task'|'team', taskId?, teamId, callerId}`。
   - 团队解析：task 维度 → `findTaskTeamGate(taskId)`；team 维度 → 直接用 `teamId`。
   - 幂等校验（已加入 400 / pending 重复 409）按解析出的 teamId。
   - 确认问题：team 维度需要 team 作用域（见下）。
3. `server/src/questions/questions.service.ts` `createForPlatform()`
   - 支持 team 作用域：`options.teamId`；`taskId` 落 `team:<teamId>`（列非空），`sessionId` 取该团队主成员会话（使 `teamIdOf` 经 session 解析出团队）；broadcast 口径用 `team:<teamId>`（`confirmByAgent` 已支持 slice `team:` 前缀）。
4. `handleTeamAddResolved` 分流
   - task 维度 → `tasksService.updateTeam(...)`（原样，保留 task_event 审计）。
   - team 维度 → `teamsService.addMember(teamId, {agentId, alias, workDir})`（团队级无 task_event；审计/广播沿用 Slice B 的团队级口径）。
5. spec：`platform-mcp.controller.spec.ts`（`team_add_member.inputSchema.required` 断言、工具数 34 不变）、`platform-mcp.tool-naming.spec.ts`、`platform-mcp.service.spec.ts`、questions 相关 spec。
6. 检查 worker 注入的 agent 提示词里对 `team_add_member` 的描述，补 `teamId` 可选说明。

## 风险
- 权限差异：UI 从 `tasks.edit` 变 `teams.edit`（`POST /teams/:id/members` 需 `teams.edit`）→ 需确认会话页用户已具备；否则按钮点了 403。
- `team_add_member` schema 放宽属于公开工具契约变更，需同步 agent 提示词与 spec。
- 团队作用域确认问题的 `sessionId` 解析若取不到团队主成员会话，`teamIdOf` 会退化为 global → 直播帧丢失。
