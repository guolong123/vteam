# task-6 before/after note — web role identity off `Agent.role`

Mode: **BEFORE/AFTER** on the live stack (web :13001, server :13000, seed-admin/Admin@123456).
BEFORE ran against the todo-5 build (containers up before any edit); AFTER ran after
`docker compose up -d --build web` (which also rebuilt the server) and the server API
was re-probed to prove the new seam was actually live.

## Files in this directory

| file | what it is |
|---|---|
| `before.txt` | full Playwright run log BEFORE (todo-5 build), 6 passed |
| `after.txt` | full Playwright run log AFTER (todo-6 build), 6 passed |
| `before-facts.txt` | extracted BEFORE DOM facts (the 4 marker blocks) |
| `task-6-role-proof.spec.ts.txt` | the probe spec (deleted from `web/e2e/` after the run) |
| `task-6-auth.setup.ts.txt` | login setup for the probe (origin-bound to :13001) |
| `playwright.task-6.config.ts.txt` | the probe config (deleted after the run) |
| `task-6-smoke.spec.ts.txt` / `task-6-taskspage.spec.ts.txt` | touched-page smoke probes (deleted after) |
| `checker-pre-regen.txt` | checker BEFORE manifest regeneration: OBSERVED 148 / UNMAPPED 22 (drift only) |
| `checker-post-regen.txt` | checker AFTER: OBSERVED 148 / UNMAPPED 0 |
| `team-members-after.png` | team detail member rows AFTER (avatar + badge) |
| `session-members-after.png` | session page member panel AFTER |
| `task-drawer-after.png` | task detail drawer AFTER |

## BEFORE/AFTER equality (seeded data)

Marker blocks extracted from both logs and diffed mechanically
(`difflib.unified_diff` on the 37 fact lines): **IDENTICAL — 0 differences**.

- **Agent list rows** (`/agents`, 10 rows): `data-role` per row + visible text. Templates render
  role-coloured avatars (`product/architect/developer/tester/plan`, plus `librarian →
  developer` neutral fallback since `librarian` is not a theme key). Custom rows
  (`a_0000000001`, `a_0000000002`, `a_0000000004`) render `developer` neutral both before and after.
- **Avatar theme colours** (5 templates): computed `background-color` / `border-top-color`
  per role are byte-equal BEFORE and AFTER, e.g. product `rgb(240, 253, 250)` /
  `rgb(153, 246, 228)`, tester `rgb(255, 251, 235)` / `rgb(253, 230, 138)`.
- **Team member rows** (`/teams/tm_0000000001`, 7 rows): `avatar=<role>` per member
  (architect/developer/developer/plan/product/project_manager/tester) unchanged; badge text unchanged.
- **Add-member option labels** (`add-member-agent-select`): 10 options byte-equal. Templates show
  `(product) … (plan)`, `知识管理员 (librarian)`; custom rows show `(custom)`, **not** the agentKey.
- **Session page**: member avatars `architect, developer, developer, plan, product,
  project_manager, tester` — unchanged role identity.
- **Team tasks page**: avatar role set `["architect","developer","plan","product"]` (mixed roles
  preserved; the `a_`-prefix derivation is the only source now that the map is gone).

## Missing-role neutral fallback (no crash)

Custom agents have `role: null` BEFORE and `role: <agentKey>` AFTER. The probe asserts:
`[data-agent-id="a_0000000001"]` avatar is `data-role="developer"` AFTER the seam change —
same neutral fallback as BEFORE — and `/agents` still renders (`agent-list-item` visible, no
error boundary). This is the deliberate `toAvatarRole` unknown-key fallback, not an accident.

## API-level seam proof

`GET /api/v1/agents` BEFORE: custom row `a_0000000001 role=None, agentKey=myagent`.
AFTER: `role=myagent, agentKey=myagent`. Templates unchanged (`role === agentKey` for all 7).
Container `dist` verified: `role: agent.agentKey` ×2, `role: agent.role` ×0.

## Grep proof (todo acceptance)

```
$ grep -rn "Agent\.role" web/ --include=*.ts --include=*.tsx | grep -v e2e/
web/app/(main)/agents/page.tsx:409: * （agent-role-decommission todo 4：`Agent.role` 写路径已移除，且全局
web/app/(main)/agents/page.tsx:2257:      // `Agent.role` 写路径已移除，whitelist 管道会静默剥离该键 → 新 Agent 静默落骨架。
```

Both remaining hits are comments only (doc mention of the removed write path). Zero code reads.

## Checker delta

- BEFORE manifest regeneration: `OBSERVED: 148 keys` / `UNMAPPED: 22` (pure line drift; the
  manifest is line-keyed).
- AFTER regeneration with the checker's own grep pipeline: `OBSERVED: 148` / `UNMAPPED: 0`, exit 0.
- Negative control: synthetic `probe.ts` containing `Agent.role` outside the repo via
  `--extra-dir` → `OBSERVED: 149` / `UNMAPPED: 1`, exit 1 (checker still catches new reads).
- Manifest shrink: 150 → 148 keys (the 5 `AGENT_ID_ROLE` maps removed; `TeamMembersPanel`'s
  `toRole`/`roleOptionsOf` `.role` reads remain and shift lines only).

## Deviations from the brief (both preserve rendered output)

1. **`teams/[id]/tasks/page.tsx` had no `a_`-prefix derivation** (the brief assumed one
   followed the map). Deleting the map alone would have flipped every seeded avatar to
   `developer`. Fix: import the already-exported `toRole` from `TeamMembersPanel` (S4-safe:
   no new constant, no `tokens.ts` edit) — verified role set stays mixed.
2. **S3 used `a.type === "template" && a.role` instead of the literal
   `ROLE_KEYS.includes(a.role)` expression.** `librarian` is a valid template role but is not in
   `ROLE_KEYS`; the literal expression would render `知识管理员 (template)` where BEFORE was
   `(librarian)`. The type-gated form is byte-identical to the old `a.role ?? a.type` for every
   live row (proven by the OPTIONS block equality) and needs no new constant.

## Gates

- `cd web && npx tsc --noEmit` → 0
- `cd server && npx tsc -p tsconfig.json --noEmit` → 0
- `cd server && npx jest --runInBand src/agents` → 3 suites / 115 tests pass
- `cd server && npx jest --runInBand` → **140 suites / 3236 tests pass** (baseline match)
- `cd worker && npx jest --runInBand` → 26 suites / 688 tests pass (unchanged)
- frozen sha `before-agent-policies.json` = `3b8c5d4b…` (unchanged)
