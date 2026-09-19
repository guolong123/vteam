# Learnings — agent-native-permission-editor

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Todo 1 — assertValidConfig native-permission validation (2026-09-19)

- **Write-path vs emit-path split confirmed by symbol.** `assertValidConfig` is called only from `create()` (POST) and `update()` (PATCH); `canonicalizePermission`/`canonicalizeEditMap` are the emit path used by `buildAgentPolicies()`/`resolveByAgent()`. Injecting the catch-all in `assertValidConfig` leaves `GET /agent-policies` bytes untouched — verified by the 3 frozen-baseline specs (`policy-canonical`, `agent-policies.matrix`, `agent-policies-db-builtin`) staying green and `before-agent-policies.json` sha unchanged (`3b8c5d4b…`).
- **Fail-open proof (worker untouched, read-only).** `worker/src/role-guard/policy.ts` `isEditDenied` only appends the fail-closed branch when `editMap['*'] === 'deny'` (:370), and the caller at :145-147 returns `{action:'allow'}` when `permission.edit` is not a plain object. Both gaps are now closed on the server write path.
- **Catch-all insertion order.** Appending `permission.edit['*']='deny'` puts `*` last; the acceptance shape and `canonicalizeEditMap`'s preferred order expect `*` first. Rebuild the map with `{ '*': 'deny', ...edit }` — preserves all allow globs and gives the canonical first-key position. Emit path still reorders canonically, so ordering here is cosmetic but matches stored-config expectations.
- **`ask` is tri-state-legal.** Included in `PERMISSION_EFFECTS`; pre-existing rows with `ask` remain editable. Do NOT tighten to allow/deny.
- **Symbol keys.** `Object.keys`/`entries` skip symbol keys silently — used `Reflect.ownKeys` in `assertPermissionRuleMap` so a non-string key is rejected (test uses `edit[Symbol('bad')]`).
- **`bash` tri-state validation is safe for built-ins:** all `ROLE_BOUNDARIES[*].bashEffect` values are already `'allow'|'deny'` (never anything else), so no legitimate built-in PATCH is newly rejected.
- **Mutation-check technique that compiles.** A `false && …` guard breaks TS narrowing on the `...edit` spread (`TS2698`). Use a `void (isPlainObject(...) ? ... : false)` no-op instead to neutralize the block while keeping tsc happy.
- **Baseline:** full server jest at todo-1 completion = **132 suites / 3087 tests** green (was 132 / 3073 at HEAD `c3b7ae8`; +14 new tests).
