# 计划：Worker 详情 OmO 开关与 agent 列表分离 + agent 页移除原生 agent 区块

## TL;DR (For humans)

Worker 详情页把「OmO 插件开关」与「OmO 模型配置 / opencode agent 列表」解耦：开关只控制插件启停，不再隐藏下方内容；并在下面新增一张独立的只读「opencode Agent 列表」卡（按该 worker 取真实 opencode agent）。同时删除 Agent 管理页里已重复的「opencode 原生 Agent」区块。

## 决策来源（用户确认）

- 用户原话：「worker详情里面的omo编排插件开关和下面的opencode agent配置分开显示，现在是开关开启后才显示agent信息，我希望开关只控制是否开启omo插件，下面再增加一个opencode agent列表展示，同时agent详情里面的opencode原生agent内容删掉」
- 数据源选择：用户选 **A** = `GET /agents/opencode?workerId=<当前worker>`（opencode 内核真实 agent，含 `vteam-*` 与原生），带 mode/native 徽章。
- 沿用约束：保持代码干净、不留退役说明、不做 AB 双轨。

## 现状（已实测）

- `web/app/(main)/workers/[id]/omo-panel.tsx`：`omo-toggle` 控制 `enabled`；**整个配置区被 `enabledNow` 包裹**（`{enabledNow && !config?.degraded && config && (…)}`），关掉后 agent 卡片整块消失，仅剩一行「已关闭」提示。
- `omo-config` 实测返回：`bundled:true`、`enabled:false`、`available`(14)、`registered`(13，含 6 个 `vteam-*`)、`runtime`(含 `native` 标记)。
- `GET /agents/opencode?workerId=` 实测：`degraded:false`，13 个 agent（7 原生 + 6 `vteam-*`），字段 `name/description/mode/native/hidden`。
- `web/app/(main)/agents/page.tsx`：`opencode-agent-section`（约 2565–2776 行）+ `opencodeAgentsQuery`（2328–2337）+ 导入（第 39 行 `OpencodeAgentItem`/`isSelectableOpencodeAgent`）为唯一使用点。

## 冻结设计

### D1 Worker 详情（`omo-panel.tsx`）
- `omo-toggle` 仅提交 `{ enabled }`；不再门控下方内容。
- OmO 模型配置（`omo-expand` + `AgentCards`）**恒可展开/编辑**，与开关状态无关；关闭时保留一行提示「插件已关闭：serve 以 `--pure` 启动，不加载 OmO；已有 N 项模型配置保留」。
- 新增独立卡片 `worker-detail-opencode-agents`：`GET /agents/opencode?workerId=<workerId>`，只读；过滤 `hidden`（系统内部 agent 不展示），保留 `subagent`（标「子Agent」）；行内含 name + mode 徽章（主Agent/子Agent/通用）+ native/自定义 徽章 + description；`degraded`/空态各给提示。
- 新卡与 OmO 卡同级（`page.tsx` 中 `<OmoPanel/>` 之后或作为独立 section），不依赖 `enabled`。

### D2 Agent 管理页（`agents/page.tsx`）
- 删除 `opencode-agent-section` 整块（含 loading 骨架 / 空态 / 列表 map）。
- 删除 `opencodeAgentsQuery` 与 `opencodeAgents` 派生。
- 删除第 39 行对 `OpencodeAgentItem` / `isSelectableOpencodeAgent` 的导入（确认无其它使用点）。
- 不改动 vteam Agent 列表/详情其它逻辑。

## Todos

- [ ] 1. [web] worker 详情：OmO 开关仅控插件 + 新增独立「opencode Agent 列表」卡
  References: `web/app/(main)/workers/[id]/omo-panel.tsx:108-387`（OmoPanel 主体与 `enabledNow` 门控）、`omo-panel.tsx:604-669`（AgentCards）、`web/app/(main)/workers/[id]/page.tsx:655-659`（OmoPanel 挂载点）、`web/src/components/teams/TeamMembersPanel.tsx:14-32`（`OpencodeAgentItem`/`isSelectableOpencodeAgent`）
  Acceptance: `omo-toggle` 关闭后 OmO 模型配置区仍可见可展开；新增 `data-testid="worker-detail-opencode-agents"` 独立卡，调 `/agents/opencode?workerId=<id>`，只读渲染（过滤 hidden，含 mode + native 徽章 + description），不随开关消失；degraded/空态有提示。
  QA: happy - Playwright：开关关闭 → 模型配置仍在 + agent 列表仍在；开关开启 → 同上且插件态为已开启。failure - 关掉开关后任一区块消失即失败。Evidence: `.omo/evidence/omo-agent-split/worker-panel.png`。
  Commit: `feat(web): decouple omo toggle from agent list and show opencode agents`
  Recommended task executor category: visual-engineering

- [ ] 2. [web] agent 管理页删除「opencode 原生 Agent」区块与相关查询/导入
  References: `web/app/(main)/agents/page.tsx:2565-2776`（opencode-agent-section）、`:2328-2337`（opencodeAgentsQuery/opencodeAgents）、`:39`（导入）
  Acceptance: `opencode-agent-section` 与 `opencodeAgentsQuery`/`opencodeAgents` 全删；第 39 行导入移除或仅保留仍被使用的符号；无 `opencodeAgents` 残留引用；页面其余功能（列表/详情/创建/克隆/权限三态）不受影响。
  QA: happy - `npx tsc --noEmit` exit 0；Playwright 打开 /agents：不再出现「opencode 原生 Agent」标题，无 console 错误。failure - 残留引用或 TS 报错即失败。Evidence: `.omo/evidence/omo-agent-split/agents-page.png`。
  Commit: `refactor(web): remove duplicated opencode native agent section from agents page`
  Recommended task executor category: visual-engineering

- [ ] 3. [e2e] 回归：worker 详情分离 + agent 页移除
  References: `web/e2e/`（现有 Playwright 用例结构）、`.omo/evidence/omo-agent-split/`
  Acceptance: Playwright 用例断言：① worker 详情页开关关闭时模型配置区与 opencode agent 列表均可见；② 开关切换正确落到 `PATCH /agents/omo-config`；③ agent 页不存在 `opencode-agent-section`；④ 两页 console 0 错误。
  QA: happy - 用例全绿并留证据；failure - 任一断言不成立即失败。Evidence: `.omo/evidence/omo-agent-split/e2e.txt`。
  Commit: `test(web): cover omo toggle decoupling and agent list`
  Recommended task executor category: unspecified-high

## Final verification wave

- [ ] F1. 计划合规审计 — Todos 全合入；References 真实存在；无残留引用。Evidence: `.omo/evidence/omo-agent-split/F1-plan-audit.txt`。
  Recommended task executor category: unspecified-high
- [ ] F2. 代码质量 review — 无 `as any`/`@ts-ignore`/死代码/退役说明；无 AB 双轨。Evidence: `.omo/evidence/omo-agent-split/F2-code-quality.txt`。
  Recommended task executor category: unspecified-high
- [ ] F3. 真实手工 QA — Playwright 实测开关分离（关/开两态）、新 agent 列表内容、agent 页区块已删。Evidence: `.omo/evidence/omo-agent-split/F3-manual-qa.txt`。
  Recommended task executor category: unspecified-high
- [ ] F4. 范围保真 — 仅动上述两文件（+e2e）；未改 server/worker；未动 vteam Agent 其余功能。Evidence: `.omo/evidence/omo-agent-split/F4-scope-fidelity.txt`。
  Recommended task executor category: unspecified-high

## Success criteria

- `cd web && npx tsc --noEmit` exit 0；`npx next lint` 改动文件干净。
- 实测：worker 详情开关关闭时，OmO 模型配置区与 opencode agent 列表**均可见**；开关只影响插件启停（PATCH `enabled`）。
- 实测：agent 页不再有「opencode 原生 Agent」区块，且无 console 错误。
