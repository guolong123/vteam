# Final Wave F2 — Code Quality Review: VERDICT: REJECT (narrow, 2 reds)

Date: 2026-09-07. Plan: `.omo/plans/remove-project-dimension.md` F2.
Raw logs: `.omo/evidence/remove-project-dimension/f2-{server,web}-{lint,tsc}.log`, `f2-grep{1..6}.log`.
Each command captured as `cmd > file 2>&1; echo EXIT:$?`. No product edits made (F2 hygiene scope only).

## 1. Lint + tsc (exit codes)

| Check | Exit | Result |
|---|---|---|
| server `npm run lint` | **0** | 0 errors, 44 warnings (all `@typescript-eslint/no-unused-vars`, none project-related — `grep 'warning.*roject'` zero hits). Full list in `f2-server-lint.log`. |
| server `npx tsc --noEmit` | **0** | clean, empty output (`f2-server-tsc.log`, 0 bytes) |
| web `npm run lint` | **1 RED** | **1 error**, 739 warnings (see §2) |
| web `npx tsc --noEmit` | **0** | clean, empty output (`f2-web-tsc.log`, 0 bytes). No stale `.next/types` ghost encountered — no cache clearing needed. |

## 2. RED-1: web lint 1 error (pre-existing, out of F2 fix scope)

```
/Users/mac/01work/git-project/vteam/web/hooks/use-sse.ts
  92:25  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
```

- Offending code (line 92): `if ((payload as any)?.message?.channelId) return true;`
- Provenance: `web/hooks/use-sse.ts` is **unmodified** in working tree (`git status` clean for this file; last commit `6277ce5`), eslint config untouched → error exists at HEAD, predates this plan.
- F2 rule ("fix ONLY if trivially within lint/tsc hygiene **in touched files**") forbids fixing an untouched file → left as-is, reported here.
- Suggested fix for owner (one token, zero runtime change): `payload.message?.channelId` — `payload` is already typed `{ message?: { channelId?: string }; taskId?: string } & Record<string, unknown>`.

## 3. Orphan-import grep (server/src)

| # | Pattern | Exit | Hits |
|---|---|---|---|
| 1 | `from ['"].*projects/` | 1 (zero hits) | none — `f2-grep1.log` empty |
| 2 | `project-membership.guard` | 1 | none |
| 3 | `project-id.decorator` | 1 | none |
| 4 | `ProjectMembershipGuard` | 1 | none |
| 5 | `myProjects\|my_projects` | 0 | **6 hits — RED-2, see §4** |
| 6 | `resolveTeamProjectIds` | 1 | none |

- `server/src/projects/` directory confirmed deleted (`ls` → No such file or directory). No dead-file references (server lint+tsc green corroborate).
- Unused-import eyeball: 44 server warnings are generic unused-var warnings, zero mention project symbols.

## 4. RED-2: `my_projects` prompt 文案 leftover (violates plan acceptance)

Plan acceptance (T-my_projects removal): "工具描述中'先调 my_projects'文案全部更新". Not met:

- `server/src/chat/worker-dispatcher.ts:316` (comment): `* 主 Agent 接待员身份 + 意图明确→my_projects 查项目再 task_create 建真任务 +`
- `server/src/chat/worker-dispatcher.ts:321` (live agent prompt): `'用户意图明确（含做什么、可执行）→ 先调用 vteam MCP 的 \`my_projects\` 查用户可见项目' +` — instructs the agent to call a **deleted** tool (`platform-mcp` no longer exposes `my_projects`; only non-spec source hit repo-wide).
- `server/src/chat/worker-dispatcher.spec.ts:4716,4720,4853` — **presence**-assertions locking the stale prompt (`expect(out).toContain('my_projects')`), not absence-assertions. Only allowlisted absence-assertion is `platform-mcp.service.spec.ts:4473` (`expect(names).not.toContain('my_projects')` — good).
- Fix = prompt-copy product edit in a touched file → outside F2 "lint/tsc hygiene only / no behavior edits" scope → left as-is, reported here. Owner action: rewrite reception prompt to team-only flow (no project-pick step) and flip those 3 spec assertions to absence-assertions.

## 5. Checkboxes

- [x] server lint exit 0 (0 errors; 44 warnings itemized in `f2-server-lint.log`, none project-related)
- [ ] web lint exit 0 → EXIT 1, 1 pre-existing error (§2)
- [x] server tsc exit 0
- [x] web tsc exit 0 (no `.next/types` ghost; cache untouched)
- [ ] No orphan imports → 5/6 clean; `my_projects` 文案 leftover (§4)

## VERDICT: REJECT

Narrow REJECT: everything the plan touched is lint/tsc-green; the 2 reds both require product-touching edits outside F2 scope — (1) pre-existing `any` in untouched `web/hooks/use-sse.ts:92`, (2) stale `my_projects` reception prompt + 3 presence-assertions contradicting the plan's own "文案全部更新" acceptance. Re-run F2 after owner applies the two suggested fixes; no re-verification of greens needed.

---

## Addendum 2026-09-07 — RED-1 fix + re-verify (authorized follow-up)

Fix (exactly 1 line, identical runtime semantics — `as any` is compile-time-erased; optional chaining on already-typed field):

```diff
-        if ((payload as any)?.message?.channelId) return true;
+        if (payload.message?.channelId) return true;
```

File: `web/hooks/use-sse.ts:92`. `payload` type unchanged: `{ message?: { channelId?: string }; taskId?: string } & Record<string, unknown>`. Nothing else touched.

Re-verify (raw logs `f2r-web-lint.log`, `f2r-web-tsc.log`):

| Check | Exit | Result |
|---|---|---|
| web `npm run lint` | **0** | 0 errors, 739 warnings (was 1 error + 739 warnings; warnings pre-existing, untouched) |
| web `npx tsc --noEmit` | **0** | clean, empty output |

No other red appeared. LSP diagnostics unavailable (typescript LSP not installed per user preference); `tsc --noEmit` exit 0 is the type gate.

F2 gates now: server lint ✓ (EXIT 0), server tsc ✓, web lint ✓ (EXIT 0), web tsc ✓ — **all 4 lint/tsc gates green**. Orphan gate: 5/6 clean; RED-2 (`my_projects` prompt 文案 + 3 presence-assertions, §4 above) remains — product prompt edit, explicitly out of scope for this follow-up.

## VERDICT: REJECT (remainder: RED-2 only)

RED-1 cleared. Single remaining item: `server/src/chat/worker-dispatcher.ts:316/321` reception prompt still routes agents to deleted `my_projects` tool + `worker-dispatcher.spec.ts:4716,4720,4853` presence-assertions. Owner action unchanged: rewrite reception prompt to team-only flow, flip 3 assertions to absence-assertions, then F2 is APPROVE without further re-verification.

---

## Addendum 2026-09-07 — Full F2 re-verify after sibling fixes (read-only, no product edits)

Both fixes confirmed landed in-tree before running (verified by read, not re-applied):
- (1) `web/hooks/use-sse.ts:92` reads `if (payload.message?.channelId) return true;` — one-token fix in place.
- (2) `TEAM_SYSTEM_RECEPTION_INSTRUCTION` (`server/src/chat/worker-dispatcher.ts:319`) rewritten team-direct: 意图明确 → 直接 `task_create` (team by session, no project-pick step); 所在团队不明 → 问团队; 意图不明 → 追问两件事（做什么/验收标准）. Zero `my_projects` hits in non-spec source.

Fresh runs (raw logs `f2v-*.log`, each `cmd > file 2>&1; echo EXIT:$?`):

| Check | Exit | Result |
|---|---|---|
| web `npm run lint` | **0** | 0 errors (grep ` error ` count = 0) |
| web `npx tsc --noEmit` | **0** | clean, 0-byte log |
| server `npm run lint` | **0** | 0 errors, 44 warnings (unchanged from F2 baseline) |
| server `npx tsc --noEmit` | **0** | clean, 0-byte log (corroborates sibling's reported tsc green) |
| orphan grep 1 `from ['"].*projects/` | 1 (zero hits) | empty |
| orphan grep 2 `project-membership.guard` | 1 | empty |
| orphan grep 3 `project-id.decorator` | 1 | empty |
| orphan grep 4 `ProjectMembershipGuard` | 1 | empty |
| orphan grep 5 `myProjects\|my_projects` | 0 | **3 hits, all allowlisted absence-assertions**: `worker-dispatcher.spec.ts:4717,4850` (`not.toContain`), `platform-mcp.service.spec.ts:4473` (`not.toContain`) |
| orphan grep 6 `resolveTeamProjectIds` | 1 | empty |

Spot-checks: no `myProjects` camelCase hits anywhere (grep5 alternation covers both); reception prompt contains no project-pick step; `server/src/projects/` still gone. Sibling-reported dispatcher spec 144/144 not re-run (out of F2 scope — unit suites; F2 gates are lint+tsc+grep only).

Checkboxes: server lint exit 0 ✓ / web lint exit 0 ✓ / server tsc exit 0 ✓ / web tsc exit 0 ✓ (no `.next/types` ghost) / no orphan imports ✓ (5/6 zero-hit + grep5 absence-assertions only).

## VERDICT: APPROVE

All F2 gates green. RED-1 and RED-2 both closed and independently re-verified. No product edits made by this session.
