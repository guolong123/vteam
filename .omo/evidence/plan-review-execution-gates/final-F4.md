# F4 Scope Fidelity — 三事回归剧本重演报告 (final-F4)

- Plan: `.omo/plans/plan-review-execution-gates.md` Final verification wave → F4
- Date: 2026-09-16 (UTC)
- Mode: verification only — **no product code changes** (probe spec deleted after run; `git status` shows no new files)
- Harness: unit/service-level only (mocked Prisma/Realtime/Dispatcher). No live stack, no live services/data touched.
- Workdir: `/Volumes/SSD-Data/01work/git-project/vteam`; jest runs from `server/` with `npx jest --runInBand`.

## Verdict summary

| # | Incident | Mechanism under test | Result |
|---|----------|----------------------|--------|
| A | m_426 architect reply without @PM missed | receipt pairing: `MessageReceiptsService.ack` exactly-once clear + `kind='wake'` exempt dispatch path | **PASS** |
| B | m_526 duplicate urge after reply | dispatch gate: issue state-lock → `reason='duplicate'` + `origMessageId`, no dispatch | **PASS** |
| C | m_446 single-receipt revision attempt | convergence gate: `ReviewRoundGateService.requestRevision` refuses 1/3 with 待 N/N hint, no version bump | **PASS** |

## Replay A — m_426 (architect reply w/o @PM still wakes PM exactly once)

Incident: architect m_426首轮 REJECT + 5 follow-ups all without `@PM` → PM never woke (docs 31 §1).

New-mechanism mapping (docs 31 §3.2): reply clears the dispatcher's pending receipts via `ack`
(pending→acked, idempotent), the clear emits `receipt.acked` once (team:+channel: frames = the
single wake chain with summary), repeat clears are no-ops; the wake itself travels
`dispatchAgentMention(kind='wake')`, which is throttle-exempt (`isThrottleExemptKind('wake')`)
and plan-gate-exempt.

### A1 — existing suite (no modifications, filter only)

Command:

```bash
cd server && npx jest --runInBand src/chat/message-receipts.service.spec.ts --testNamePattern "acked"
```

Outcome: `Tests: 2 passed` —

- `pending→acked 清账并向 team: + channel: 广播 receipt.acked（零丢失）`
  asserts `MessageReceiptsService.ack('mr_1')` → `prisma.messageReceipt.update` called with
  `{where:{id:'mr_1'}, data:{status:'acked'…}}`, `realtime.broadcast` contains
  `receipt.acked` on both `{type:'team'}` and `{type:'channel'}` with payload
  `{receiptId, taskId, teamId, status:'acked'}`.
- `已 acked 幂等：不再写库不再广播` asserts second `ack('mr_1')` →
  `prisma.messageReceipt.update` NOT called, `realtime.broadcast` NOT called (exactly-once).

### A2 — wake path taken (filter only)

Commands:

```bash
cd server && npx jest --runInBand src/platform-mcp/platform-mcp.service.spec.ts --testNamePattern "wake"
# → 1 passed: 内部 wake 免节流：配额耗尽后 kind=wake 仍触发（不咨询不记账，零丢失）
cd server && npx jest --runInBand src/chat/mention-throttle.spec.ts --testNamePattern "wake"
# → 2 passed: 内部 wake/round-notify 豁免节流 + 突发豁免回归（3 评审占满 pair 预算后 wake 仍零丢失）
```

Exact asserts: `isThrottleExemptKind('wake') === true`; `notifyAgent(kind='wake')` triggers
`dispatchAgentMention` even with exhausted quota (message still published + dispatched).

### A3 — throwaway incident-faithful probe (deleted after run)

File `server/src/__f4-probe__.spec.ts` (created, run, `rm` deleted; receipt: `git status` clean):

- Seeds ONE pending receipt `mr_426` (PM `tmm_pm` → architect `tmm_arch`, `messageId m_425`).
- Invokes exact service method `MessageReceiptsService.ack('mr_426')` (reply-without-@ path).
- Asserts: `messageReceipt.update` ×1; `receipt.acked` broadcasts ×2 (team: + channel: frames);
  second `ack` → update still ×1, broadcasts still ×2 (no second wake); `isThrottleExemptKind('wake')` true.
- Outcome: `Tests: 2 passed` (A probe + C probe in one file). **PASS**

## Replay B — m_526 (duplicate urge after reply blocked with origMessageId)

Incident: PM recorded "架构视角无回执" and re-urged (m_526) although architect had replied (docs 31 §1, docs 32).

Mechanism: `PlatformMcpService.notifyAgent` → `checkIssueDispatchAllowed` (server/src/platform-mcp/platform-mcp.service.ts:1193):
`in_progress` + same `assigneeInstanceId` ⇒ `{allowed:false}` + prior `messageReceipt.messageId`
as `origMessageId`; `notifyAgent` returns `{triggered:false, reason:'duplicate', origMessageId}`
and never calls `dispatchAgentMention` (lines 1083-1102).

Command (existing suite, filter only, no modifications):

```bash
cd server && npx jest --runInBand src/platform-mcp/platform-mcp.service.gate.spec.ts --testNamePattern "duplicate"
```

Outcome: `Tests: 1 passed, 23 skipped` —

- `in_progress + 同 assigneeInstanceId → reason=duplicate + origMessageId，不触发`:
  seeds `issue={status:'in_progress', assigneeInstanceId:'tmm_tester'}` +
  `messageReceipt.findFirst→{messageId:'m_0000000100'}` (the original dispatch = m_526's prior urge),
  invokes exact service method `service.notifyAgent(ctx, {...baseArgs, issueId})`,
  asserts `result.triggered===false`, `result.reason==='duplicate'`,
  `result.origMessageId==='m_0000000100'`, `workerDispatcher.dispatchAgentMention` NOT called.
- Adjacent matrix (same file, green in full run): open/换人/终态放行, 读错 fail-open. **PASS**

## Replay C — m_446 (single-receipt revision refused with 待 N/N hint)

Incident: planner revised on a single architect receipt before convergence (m_446 class; docs 33 §3.3-§3.4).

Mechanism: `ReviewRoundGateService.requestRevision` (server/src/issues/review-round-gate.service.ts:165):
only `complete` + converged ledgers pass; otherwise throws
`修订被拒：…待 ${receivedCount}/${expectedCount}…` — version untouched (read-only gate, no
`applyRoundUpdate` call on this path).

### C1 — existing suite (filter only)

```bash
cd server && npx jest --runInBand src/issues/review-round-gate.service.spec.ts --testNamePattern "修订请求被拒"
```

Outcome: `Tests: 1 passed` —
`2/3 修订请求被拒并提示 exact 待 N/N（m_446 类行为被拦）`: two `recordVerdict` (m_446/m_447),
`requestRevision` rejects with `/待 2\/3/`. **PASS**

### C2 — incident-exact 1/3 probe (throwaway, deleted after run)

Same `server/src/__f4-probe__.spec.ts` run (`Tests: 2 passed` total):

- Constructs ledger state: `createLedger({round:1, planVersion:{v0.3}, expected:[arch,dev,test]})`
  embedded in issue `is_446`; invokes exact `gate.recordVerdict(is_446, {member:tmm_arch, REJECT, m_446, v0.3})` → 1/3.
- Invokes exact `gate.requestRevision('is_446','tmm_plan')` → asserts rejects `/待 1\/3/`.
- Asserts no version bump: issue description bytes identical before/after (`store.get` unchanged),
  still contains `"version": "v0.3"`, status stays `collecting` (no `complete` transition). **PASS**

## Commands/asserts index (all service-level, no live dispatch)

| Replay | Exact service call | Assertion | Evidence |
|--------|-------------------|-----------|----------|
| A | `MessageReceiptsService.ack('mr_426')` ×2 | update ×1; `receipt.acked` ×2 (team+channel); 2nd ack zero new calls | jest `message-receipts.service.spec` (2 passed) + probe (passed) |
| A | `isThrottleExemptKind('wake')` / `notifyAgent(kind='wake')` | exempt true; dispatch taken under exhausted quota | jest `platform-mcp.service.spec` (1 passed) + `mention-throttle.spec` (2 passed) |
| B | `PlatformMcpService.notifyAgent(ctx,{…issueId})` | `triggered:false`, `reason:'duplicate'`, `origMessageId:'m_0000000100'`, `dispatchAgentMention` uncalled | jest `platform-mcp.service.gate.spec` (1 passed) |
| C | `ReviewRoundGateService.requestRevision('is_446','tmm_plan')` @1/3 | throws `/待 1\/3/`; ledger bytes unchanged; version `v0.3`; no `complete` | jest `review-round-gate.service.spec` 2/3 case (1 passed) + 1/3 probe (passed) |

## Hygiene

- `git status --porcelain` (pre-run): recorded; only pre-existing modifications present.
- Probe `server/src/__f4-probe__.spec.ts`: created → run green → `rm` deleted → post-run
  `git status --porcelain -- server/src/__f4-probe__.spec.ts` empty (no trace left).
- No product code, specs, plan, or docs edited. No commits. No live services/data touched.
- Deliverable: this file only (`.omo/evidence/plan-review-execution-gates/final-F4.md`).
