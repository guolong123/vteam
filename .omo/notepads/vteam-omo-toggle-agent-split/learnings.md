# vteam-omo-toggle-agent-split learnings

## Todo 2 — remove duplicated opencode native agent section from agents page (2026-09-14)
- Deleted from `web/app/(main)/agents/page.tsx` only (3 hunks, -225 lines total):
  - import line (old L39): `OpencodeAgentItem, isSelectableOpencodeAgent` from TeamMembersPanel — grep proved
    zero other references in the file, so the whole import line was removed (no other symbols on it to keep).
  - query block (old L2321-2337 + doc comment): `opencodeAgentsQuery` (`GET /agents/opencode`) and derived
    `opencodeAgents` filter line.
  - JSX block (old L2564-2769): entire `data-testid="opencode-agent-section"` div (header + degraded badge +
    hint + skeleton + empty state + agent map). Outer left-panel `</div>` kept.
- Grep proof of zero residue for `opencode-agent-section|opencodeAgentsQuery|opencodeAgents|OpencodeAgentItem|`
  `isSelectableOpencodeAgent|opencode-agent-item|/agents/opencode|opencode-agents` → no matches.
- Remaining `opencode` mentions in the file (permission-alignment comments, agentKey convention) are unrelated
  and untouched; no orphaned helpers left behind (`isPrimary`/`modeLabel` were inline in the deleted map).
- `TeamMembersPanel.tsx` NOT touched — shared `OpencodeAgentItem`/`isSelectableOpencodeAgent` exports still live
  there for the worker detail card (Todo 1).
- Verify: `cd web && npx tsc --noEmit` exit 0; `npx next lint --file 'app/(main)/agents/page.tsx'` clean except
  pre-existing `deleting` unused-var warning at 1059:187 (untouched code).
- Evidence: rebuilt web (`docker compose build web && docker compose up -d --force-recreate web`), Playwright
  (chrome channel) login admin/admin123 → `/agents`: `opencode-agent-section` count 0, heading absent, vteam
  list (5 template agents + detail panel) renders, 0 console errors.
  Screenshot: `.omo/evidence/omo-agent-split/agents-page.png`.
# vteam-omo-toggle-agent-split — learnings (Todo 1: worker detail)

## 2026-09-14 — toggle 解耦 + opencode Agents 独立卡（done）
- 改动：`web/app/(main)/workers/[id]/omo-panel.tsx`（去掉 5 处 `enabledNow &&` 门控：
  configPath 行、保存/重置按钮、isPending、degraded、主配置块；新增导出组件
  `OpencodeAgentsPanel`）、`web/app/(main)/workers/[id]/page.tsx`（并列渲染新卡）。
- 新卡：`data-testid="worker-detail-opencode-agents"`，queryKey
  `["opencode-agents", "worker", workerId]`，只过滤 `hidden`（subagent 保留并标「子Agent」），
  mode 徽标 主Agent/子Agent/通用 + 原生/自定义徽标，degraded/空 → 「未获取到（worker 离线或版本不支持）」。
- PATCH 语义保持原样：toggle 仍走 `saveMutation.mutate({ enabled: next })`
  （wire body `{agents:{}, enabled}` 不动）。实测 server 对 `{"enabled":false}`（无 agents）回 400，
  所以「只发 {enabled}」不可行——保持现状即正确契约。
- 验证：`npx tsc --noEmit` exit 0；`npx next lint --file page.tsx --file omo-panel.tsx` 零警告。
- 证据 `.omo/evidence/omo-agent-split/worker-panel.png`：toggle OFF（aria-checked=false）时
  `omo-disabled-hint` + `omo-expand` + 14 个 `omo-agent-row-*` + 10 个 `opencode-agent-row-*` 全可见。
- live 数据会漂：同一 worker 先后返回 22 agents（5 hidden）与 13 agents（3 hidden）；
  截图时刻可见 10 行与 API `visible:10, degraded:false` 一致——断言时以 API 为准，不要 hardcode 数量。
- 截图技巧：详情页滚动容器是内层 `worker-detail-root`（overflowY auto），`fullPage` 抓不到；
  需把该节点及向上 8 层祖先的 overflow/height 拍平 + `setViewportSize` 拉高视口后截 viewport。
- 操作后把 `enabled` PATCH 回 true（现场复原），避免影响其他 Todo/演示。
