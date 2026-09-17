# Reply-Join Prompt Proof (2026-09-17)

## Edits made

### 1. `server/src/chat/worker-dispatcher.ts` — `GLOBAL_BASE_LINES`
Appended a new line after 【通知重发】:
```
【@ 定向机制｜回执】vteam_notify_agent 新增 type 与 stage 参数（默认 type=answer、stage=process）：answer+process=常规进度汇报，不唤醒主Agent；answer+end=本次派发完工，清除回执，主Agent在所有派发均完工时一次性唤醒；question/help=需主Agent立即介入，中断唤醒，不计为完工。进度汇报不再按条唤醒，完工必须传 stage=end。
```

### 2. `server/src/chat/worker-dispatcher.ts` — `NON_MAIN_AGENT_NOTE`
Appended after the routing rule:
```
回执节奏：进度汇报用 vteam_notify_agent（type=answer, stage=process，不唤醒主Agent）；完工必须传 stage=answer+end（清除回执，主Agent在所有派发完工后一次性唤醒）；遇阻塞/决策/依赖缺失用 type=question 或 help（立即中断唤醒主Agent，不计完工）。
```

### 3. `server/src/chat/worker-dispatcher.ts` — `MAIN_AGENT_INSTRUCTION`
Appended after FR-11:
```
唤醒节奏：你不在每条进度汇报时被唤醒；仅当某成员传 stage=answer+end（派发完工）且你所有外派均回执完毕时，平台一次性唤醒你确认进度；成员传 type=question/help 则立即中断唤醒你。因此唤醒后先汇总所有已收回报再行动，不要逐条处理。
```

### 4. `server/prisma/seed.ts` — 4 roles (product, architect, developer, tester)
Appended in `## 回执铁律` after `回执必@派发人`:
```
- 回执参数：进度汇报 type=answer+stage=process（不唤醒主Agent）；完工必须 stage=answer+end（主Agent汇总唤醒）；阻塞用 type=question/help（立即唤醒主Agent）。
```

## Rendered-prompt proof

### Sub-agent (developer, isMainAgent=false)
- `回执参数` ✓ (from prompt field)
- `answer+process` ✓
- `answer+end` ✓
- `question/help` ✓
- `不唤醒主Agent` ✓
- `立即唤醒主Agent` ✓
- `回执节奏` ✓ (from NON_MAIN_AGENT_NOTE)
- `@ 定向机制｜回执` ✓ (from GLOBAL_BASE_LINES)

### Main agent (product, isMainAgent=true)
- `唤醒节奏` ✓ (from MAIN_AGENT_INSTRUCTION)
- `不在每条进度汇报时被唤醒` ✓
- `所有外派均回执完毕` ✓
- `question/help 则立即中断` ✓
- `@ 定向机制｜回执` ✓ (from GLOBAL_BASE_LINES)

## Spec status
- No spec edits required (all existing assertions use `toContain`)
- `npx tsc --noEmit` exit 0
- Full suite: 123 suites / 2858 tests green (unchanged from baseline)
