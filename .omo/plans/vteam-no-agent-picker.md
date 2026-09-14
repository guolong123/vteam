# 计划：移除消息发送区 agent 选择器（opencodeAgentName 影子路径入口）

## TL;DR (For humans)

团队会话页消息输入框里的 opencode agent 下拉选择器与既定策略冲突：策略要求 opencode agent 身份完全由 policy 决定（role/agentKey/plan-mode + worker 能力位门），而该选择器允许用户手写 `TeamMember.opencodeAgentName`，在策略门失败时绕过策略生效。删除该选择器 UI 及其专属数据查询；保留 `@` 提及、后端回退链路与 `plan_mode` 工具（不在本次范围）。

## 决策来源（用户确认）

- 用户原话：「现在在消息发送区域还有个选择agent的地方，这里和我们的策略冲突了，去掉它」。
- 沿用约束：干净代码、不留退役说明、不做 AB 双轨；只删 UI 入口，不动后端机制。

## 已实测事实（本会话）

- 选择器仅一处渲染：`web/app/(main)/teams/[id]/session/page.tsx:1272` 传 `agentOptions/agentValue/onChangeAgent/agentSelectDisabled` 给 `MessageInput`；`MessageInput` 唯一调用方即此页。
- 写入链：`instanceOpencodeAgentMutation` → `PATCH /teams/:teamId/members/:instanceId { opencodeAgentName }`（主成员行）。
- 数据源：`opencodeAgentsQuery`（`GET /agents/opencode`）在 session 页仅服务于该选择器；`OpencodeAgentItem`/`isSelectableOpencodeAgent` 在该页仅此一用（第 31 行导入、第 933/1272 行使用）。
- `InputAgentOption` 接口仅 `message-input.tsx` 内部使用。
- dispatch 优先级（`worker-dispatcher.ts:1738`）：策略候选 + 能力位门通过 → 策略 agent 覆盖，显式选择不能绕过；门失败 → 回退显式选择。删除 UI 后不再产生新的显式值；存量行与 `plan_mode` 工具写入不受影响。

## 冻结设计

### D1 删除范围（仅前端展示层）
- `message-input.tsx`：删选择器渲染块（~457-490）、4 个 props（`agentOptions/agentValue/onChangeAgent/agentSelectDisabled`）与 `InputAgentOption` 接口；`@` 提及、附件、发送逻辑零改动。
- `session/page.tsx`：删 `opencodeAgentsQuery`、`instanceOpencodeAgentMutation`、传给 `MessageInput` 的 4 个 props；第 31 行导入仅去 `OpencodeAgentItem`/`isSelectableOpencodeAgent`（`TeamMembersPanel/roleOptionsOf/customAgentsOf/AgentItem` 保留，仍在用）。
- 不删：`TeamMember.opencodeAgentName` 列、dispatch 回退链、`plan_mode` 的 agentName 参数、后端任何代码。

## Todos

- [x] 1. [web] 删除消息发送区 agent 选择器及其专属查询
  References: `web/src/components/ui/message-input.tsx`（props ~113-127、渲染块 ~457-490）、`web/app/(main)/teams/[id]/session/page.tsx`（import ~31、query ~930、mutation ~940、传参 ~1272-1283）
  Acceptance: 选择器 UI 消失（`agentOptions/agentValue/onChangeAgent/agentSelectDisabled/InputAgentOption/opencodeAgentsQuery/instanceOpencodeAgentMutation` 在两文件零残留，grep 证明）；`@` 提及、附件、发送、私聊切换零回归；`tsc` + lint 干净。
  QA: happy - Playwright：会话页输入区无 agent 下拉，@计划员仍可触发，console 0 错误；failure - 任一残留引用或 TS 报错即失败。Evidence: `.omo/evidence/no-agent-picker/removed.png` + `grep.txt`。
  Commit: `refactor(web): remove agent picker from message input`
  Recommended task executor category: visual-engineering

- [x] 2. [e2e] 回归：选择器移除 + 双路径计划创建可用性
  References: `web/e2e/`（既有用例结构）、本计划 D1
  Acceptance: 脚本/用例断言：① 会话页无 agent 选择器 DOM；② 用户 `@计划员` 可触发起草（复用既有 e2e 的 @ 触发断言模式，或轻量验证成员可达）；③ 主 Agent 经 `@`/notify 联系计划员走同一分派路径（代码级断言 dispatch 无成员身份歧视 + 任选其一实测）；④ 控制台 0 错误。
  QA: happy - 全绿并留证据；failure - 任一不成立即失败。Evidence: `.omo/evidence/no-agent-picker/e2e.txt`。
  Commit: `test(web): cover agent picker removal`
  Recommended task executor category: unspecified-high

## Final verification wave

- [x] F1. 计划合规审计 — Todos 全合入；References 真实存在；删除零残留（grep 证明）。Evidence: `.omo/evidence/no-agent-picker/F1-plan-audit.txt`。
  Recommended task executor category: unspecified-high
- [x] F2. 代码质量 review — 无 `as any`/`@ts-ignore`/死代码/退役说明；无 AB 双轨。Evidence: `.omo/evidence/no-agent-picker/F2-code-quality.txt`。
  Recommended task executor category: unspecified-high
- [x] F3. 真实手工 QA — Playwright 实测选择器消失 + @计划员可用 + 控制台干净。Evidence: `.omo/evidence/no-agent-picker/F3-manual-qa.txt`。
  Recommended task executor category: unspecified-high
- [x] F4. 范围保真 — 仅两文件；未动 server/worker；@ 提及、附件、plan_mode、回退链完好。Evidence: `.omo/evidence/no-agent-picker/F4-scope-fidelity.txt`。
  Recommended task executor category: unspecified-high

## Success criteria

- `cd web && npx tsc --noEmit` exit 0；lint 改动文件干净。
- 会话页输入区无 agent 下拉；`@计划员` 与主 Agent 联系计划员两条路径均可用（同一分派机制）。
- 后端 `opencodeAgentName` 回退链与 `plan_mode` 工具不受影响（未改一行后端代码）。
