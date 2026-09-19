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

## Todo 6 — create-agent role picker (2026-09-19)

- **`ROLE_KEYS` (page-local, :393) is the key list; `roles` (tokens.ts) is the label source.** The picker derives its options as `ROLE_KEYS.filter(k => k !== 'plan').map(k => ({key: k, label: roles[k].label}))` plus a leading `null` = 「无」. Do NOT widen `ROLE_KEYS` itself — `toAvatarRole` (:396) and the role colour helpers map over all six including `plan`, and `plan` must stay a *display* role while being excluded from the *create* list.
- **Why `plan` is excluded (verified, not stylistic):** `worker/src/role-guard/policy.ts:172-179` only grants the `task` exception when `agent === 'vteam-plan'` — the literal opencode name. A custom agent's execution name is `vteam-<agentKey>`, so it can never reach that branch; offering `plan` would promise a capability the guard refuses. Five roles + none is the honest set.
- **`undefined`, not `''`, for 「无」.** `create()` does `dto.role ?? null` before `resolveTemplateSource` (agents.service.ts:187), and `resolveTemplateSource` returns null immediately for falsy role (:731-733) → `buildSkeletonConfig`. `''` would still hit `?? null` in DTO-land but the *serialized request body* would carry `role:""`; the spec asserts the key is absent from the POST body, which is the property that survives any future `??`-to-`||`/validation refactor.
- **Skeleton shape to assert (todo 1's catch-all is already in effect):** `permission.edit === {'*':'deny'}` exactly (no `write` key — stripped by `assertValidConfig`), `bash:'deny'`, `task:'deny'`, `tools:{}` — `resolveGuardTools` finds no boundary for `vteam-<agentKey>` → `{}`, and `resolveBashDeny` returns `ROLE_BASH_DENY_PATTERNS` which is **empty** (`agent.constants.ts:264`). Assert `tools` empty, NOT `bashDeny` non-empty.
- **Developer set to assert:** the deep-copied `ep_developer` config carries `edit:{'*':'deny','**tasks/*/**':'allow'}`, `bash:'allow'`, and **27** tool allows. The template row itself is `type='template'`; the new agent's policy is a fresh `type='custom'` row with a new `ep_0000NNNN` id — assert `policyId !== 'ep_developer'` to prove it was a deep copy, not a shared binding.
- **Mutation-check technique that reuses the harness:** comment out the single `role: role ?? undefined,` line, `docker compose build web && docker compose up -d web`, run the *same* spec — test 2 fails at the capability assertion (`Expected: "allow" / Received: undefined`), tests 1/3/4 stay green, proving the assertion is precisely discriminating. Restore with `cp` from a `/tmp` backup and `shasum -a 256` compare (identical: `7c4f4302…`); re-run green. **Never `git checkout --`/`git restore`** — this file has uncommitted work from todos 3/4/5 that run after this one.
- **Container-code verification trick (no rebuild guesswork):** `docker exec aiagents-compose-web sh -c "grep -rl 'create-agent-role' /app/.next"` must list the page server bundle *and* the client chunk before trusting a Playwright run. A stale web image is the failure mode that makes a correct spec look broken.
- **Playwright modal screenshots need a taller viewport:** the create modal is ~700px tall with the role row second-from-last; the default 720px viewport clips it. Set `setViewportSize({width:900,height:980})` + `locator('#agent-role').scrollIntoViewIfNeeded()` before the shot (`data-testid` is on the `<select>`; its id is `agent-role`).
- **Failing tests skip in-test cleanup.** A mutation/red run aborts before the spec's `deleteAgent`, leaving `a_0000NNNN` + `ep_0000NNNN` residue (4 agents + 4 policies here). Sweep with the API after any red run and keep the receipt (`.omo/evidence/agent-native-permission-editor/task-6-cleanup-receipt.txt`); `DELETE /agents/:id` does NOT cascade the policy row — delete both.

## Todo 2 — round-trip bashDeny in PolicyConfigDto (2026-09-19)

- **The whitelist pipe is genuinely the stripper — proved, not assumed.** `main.ts:55-61` runs `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false })`. Before the fix, a PATCH carrying `config.bashDeny` produced a stored config with **no** `bashDeny` key (`hasOwnProperty` false) AND `[123]` resolved instead of 400 (the whole unknown key is stripped *before* per-key validation). Both observables flipped after adding the DTO field. Assert on `Object.prototype.hasOwnProperty.call(storedConfig, 'bashDeny')` — `toEqual` alone is not enough because a stripped key and an `undefined`-valued key are indistinguishable via property access.
- **Spec harness that exercises the real pipe without HTTP.** Instantiate the production-exact `new ValidationPipe({whitelist, transform, forbidNonWhitelisted})` in the spec, call `globalPipe.transform(body, { type:'body', metatype: UpdateExecutionPolicyDto })`, then hand the DTO to a real `ExecutionPoliciesController` wired to a real `ExecutionPolicyService` + in-memory prisma store. This gives a true PATCH→persist→GET round-trip and it fails if either the DTO field is removed or the pipe switches to `forbidNonWhitelisted:true`. Mirror the three switches verbatim from `main.ts` so a future pipe-config change is caught here too.
- **`policy-config.dto.spec.ts` lives next to the DTO** (`dto/` subdir) and is picked up automatically by jest's `testRegex: .*\.spec\.ts$` with `rootDir: src` — no jest config change needed.
- **Adding the field is additive; `assertValidConfig` needed no edit.** todo-1's `assertValidConfig` (:859) validates only `permission`/`correction`/`tools` shape; `bashDeny` passes through untouched and `resolveBashDeny` (:325) already filters to `string[]` at read time. If the plan had wanted DTO-level rejection of a *non-array* `bashDeny`, `assertValidConfig` would need a matching guard — but the task scope was strictly the DTO field, and `@IsArray` at the pipe covers array-shape rejection (400) for both handlers.
- **Guard semantics unchanged.** `ROLE_BASH_DENY_PATTERNS` stays `[]` (`agent.constants.ts:264`); `git diff` on that file is empty. Do NOT "helpfully" tighten it.
- **Module baseline after todo 2:** `npx tsc -p tsconfig.json --noEmit` → exit 0; `npx jest --runInBand src/execution-policies` → **11 suites / 171 tests** green (+1 suite / +3 tests over todo-1's 10/168). Frozen `before-agent-policies.json` (`3b8c5d4b…`) untouched.
- **Mutation-check:** removing the whole `bashDeny` property block reproduces the pre-fix red exactly (2 failed, 1 passed). Backed up to `/tmp/policy-config.dto.ts.final.bak` (`7e197b03…`), restored via `cp` + `shasum -a 256` + `diff -q` → byte-identical. **Never `git checkout --`/`git restore`.**
- **Parallel-work hazard:** `server/src/agents/agents.service.spec.ts` carries todo-7's uncommitted changes. Stage ONLY the two `dto/policy-config.*` paths for this commit; `git add -A` would sweep in another todo's work.

## Todo 7 — prove create-path role inheritance (2026-09-19)

- **The discriminating assertion is the `findUnique({where:{id:'ep_developer'}})` call + field equality.** Reverting `dto.role ?? null` → `null` at `agents.service.ts:187` makes `resolveTemplateSource` early-return (`:731`) so `executionPolicy.findUnique` is never called; the test fails at `Expected: {"where":{"id":"ep_developer"}} / Number of calls: 0`. That call-count assertion is the sharpest mutation signal — the field-equality asserts alone would also catch it, but the call assert localizes the break to the inheritance seam.
- **Expected values are derived, not mirrored.** `seedRolePolicyConfig(agentName)` in the spec re-runs the exact seed.ts:906-920 construction (`buildEditPermission(boundary.writeGlobs)` / `buildReadPermission()` / `boundary.bashEffect` / `task` rule / `Object.fromEntries(boundary.mcpDenies)` / `{...boundary.toolAllows}`) over `ROLE_BOUNDARIES`. This is *not* a mirror of the implementation: the implementation under test reads a mocked DB row, while the expected value is built from the constants — they only agree if create genuinely deep-copies the row. seed.ts mirrors `ROLE_BOUNDARIES` byte-for-byte and `src/prisma/seed.spec.ts` locks that, so the chain has one source of truth.
- **Secondary anchor guards against future drift:** `expect(policyData.config.tools).toEqual(ROLE_BOUNDARIES['vteam-developer'].toolAllows)` ties the result directly to the constant, independent of the derived helper, so a silent bug in the helper can't make both sides wrong together.
- **Anti empty-equals-empty guard:** assert `Object.keys(epDeveloperConfig.tools).length > 0` before comparing, and `not.toEqual({})` after. Without it, a regression that makes create bind `{}` for both role-full and role-less could pass a naive equality.
- **Positive control is the role-less test in the same describe.** It asserts `findUnique` is NOT called and the stored config is exactly the skeleton (`edit:{'*':'deny'}`, `bash:'deny'`, `task:'deny'`, `tools:{}`). Together the pair proves the *difference* is role-driven, not an incidental property of one branch.
- **Mocking note:** `stamp` and `echoAgentCreate` are defined at the top of the `策略装配` describe; the new tests reuse them. `findUnique.mockImplementation` (not `mockResolvedValue`) is needed because the role-less test in the same file expects a call and the surrounding suite mocks leak within a test — `beforeEach` resets to `mockResolvedValue(null)`, so per-test overrides are safe.
- **Baseline after todo 7:** `npx jest --runInBand src/agents src/prisma` = 4 suites / 146 tests green; full `npx jest --runInBand` = **133 suites / 3092 tests** (+1 suite / +5 tests over todo-1's 132/3087… note todo 2 may add suites concurrently); `npx tsc -p tsconfig.json --noEmit` exit 0. Frozen `before-agent-policies.json` (`3b8c5d4b…`) untouched.
- **Parallel-work hazard (reiterated):** this commit stages ONLY `server/src/agents/agents.service.spec.ts`. Todo 2's `dto/policy-config.*` edits are uncommitted in the same worktree — `git add -A` would sweep them in.

## Todo 3 — native glob rule-list editor + four-row wiring (2026-09-19)

- **Render-time `emit()` is a trap — use event-driven commits.** First cut called `onChange` from a `useEffect` on every render (to "always upstream the latest valid view"). That is a feedback loop against parent state and, worse, it would leak the *seed* (`{'*':'allow'}`) into `draftNative` for every agent whose `read` key is absent — turning a display-only default into a persisted one the moment todo 4 lands. Final shape: `updateRow`/`addRow`/`removeRow` call `setRows(next)` + `commit(next)` directly; invalid next-rows are simply not committed (no `onChange`, no parent state change). Server-arrival re-seed stays a guarded effect.
- **The `*` row must be re-injected with the ROW'S OWN default, not a hardcoded deny.** `ruleRowsOf` seeds a missing `*` with `seed['*'] ?? 'deny'`. For `read`, `seed['*']='allow'` — a hardcoded deny catch-all there would display a read-lock that does not exist (worker `READ_TOOLS` always allows) and would emit a deny the user never chose the first time they touched any row. edit keeps deny (mirrors todo 1's server-side injection).
- **Catch-all warning is edit-only.** `worker/src/role-guard/policy.ts` `isEditDenied` is the only place where a `*`-mismatch fails open; `read` has no catch-all concept (`*:allow` IS the READ_TOOLS default). Rendering "opens all writes" on the read row is a false warning. Gated with `name === "edit"`; the spec asserts warn-on-allow + clear-on-deny on the edit row only.
- **`in` on a plain object hits the prototype chain.** `row.effect in toolEffectMeta` returns true for `"toString"`/`"constructor"` — an unknown stored value could be misread as a known chip and then silently mangled. Use `Object.prototype.hasOwnProperty.call(...)`; wrapped in `isToolEffect()`.
- **Unknown-effect discrimination needs an out-of-band fixture.** The API (correctly, per todo 1) rejects any value outside allow/ask/deny, so `ask2` can only exist as a legacy row. The spec injects it with `docker exec aiagents-compose-db mysql ... JSON_SET(...)` then asserts the grey chip (`data-unknown="true"`, `data-effect="ask2"`) AND `data-emitted` still carries `ask2` after an edit cycle. This is the sharpest coercion signal: `normalizeToolEffect('ask2') → 'deny'` (mutation run 2 fails here with `Expected {"*":"deny","legacy":"ask2"} / Received {"*":"deny","legacy":"deny"}`), while a stored `ask` stays green under the same mutation because `ask` is a legal tri-state value for the coercer.
- **Expose the emitted payload, not just a count.** `data-emitted={JSON.stringify(emitted)}` on the editor root makes the *exact* submit-face bytes assertable (`toHaveAttribute("data-emitted", '{"*":"deny","x":"ask"}')`) and `data-committed` gives the duplicate-rejection count check. Both are QA observability attributes on top of the spec-mandated testids — cheap, and they convert "looks right" into an exact-bytes assertion.
- **Row keys must be the index, not `` `${index}:${glob}` ``.** Keying by glob remounts the `<input>` on every keystroke (React sees a new key) → focus loss while typing a new glob. Index keying keeps the DOM node stable; rows are append/remove-only.
- **`data-committed` vs the duplicate case.** Duplicate detection marks BOTH rows in the colliding pair (`rows.some(other => other.glob === glob)`), so the spec must assert `.first()` visibility + `toHaveCount(2)` — a bare `toBeVisible()` on the shared locator is a Playwright strict-mode violation.
- **`effective === null` path:** the section's early return (~:1108) renders the loading/empty branch, so no editor mounts and no draft can exist. Stated in the section comment as required.
- **Tooling:** `scripts/e2e-native-rule-editor.sh` mirrors the todo-6 harness (tmp config → compose web `:13001`, `channel:"chrome"`, JSON reporter at `.t3.report.json`). First cut had the raw-log dump AFTER the `|| fail`, so a red run printed nothing; fixed by capturing `PW_STATUS` then dumping then failing.
- **Mutation proof:** mutation A = restore the presence filter → test 2 rebinds (`Expected 4 / Received 2`); mutation B = `normalizeToolEffect` on the emit path → test 7 rebinds (`legacy` `ask2`→`deny`). Restored via `cp` from `/tmp/todo3-backup/`; pre/post sha256 both `8005e99e…`; rerun 7/7 green. **Never `git checkout --`/`git restore`.**
- **Concurrent-todo hazard (reiterated):** todos 4/5 edit this same file after this one. Stage ONLY `web/app/(main)/agents/page.tsx`, `web/e2e/native-rule-editor.spec.ts`, `scripts/e2e-native-rule-editor.sh` for this commit — `git add -A` would sweep in other todos' worktrees/dirty files.

## Todo 4 — serialize policy writes (one mutation, one gate, ref-built payload) (2026-09-19)

- **The lost-update seam is the payload SOURCE, not the gate.** Pre-todo-4 `policyMutation` built `{permission: effective.permission, correction: effective.correction, tools: {...guardTools}}` from the render closure. Two writes in one render tick both serialize the same pre-first-write `effective`; the second PATCH overwrites the first. The fix is a `configRef` holding the client-authoritative `{permission, correction, tools}` that every payload is built from — the in-flight gate alone would NOT have fixed it, because the gate only prevents overlap, not stale source.
- **Mutation proof must target the real seam (first attempt missed).** Mutating `handleToolChange` to use `effective.permission` left test 1 GREEN: test 1's burst (bash switch → add edit rule) runs entirely through native handlers, never through `handleToolChange`. The discriminating mutation is reverting `currentConfig()` to return the render-closure values (`permission`/`effective.correction`/`guardTools`) instead of `configRef.current` → test 1 fails `Expected: "allow|deny" / Received: "deny|deny"` while tests 2–4 stay green. **Pick the mutation that the failing test actually exercises.**
- **`writePendingRef` matters inside the sync effect.** The `effective`-sync effect must bail when `writePendingRef.current || debounceRef.current !== null`; a bare `writePending` state read inside the effect body is one render behind the ref and can replay a pre-write `effective` over the local draft. Keep both (`writePending` for the disabled props, the ref for the effect + event guards).
- **Debounce must NOT swallow the immediate path's composition.** Native handlers push into `configRef` synchronously and schedule the write 400ms later; a tool toggle calls `flushNative()` first (draft already in ref), then composes on the ref — so bash-then-toggle yields one PATCH containing both. A naive "cancel debounce and use closure" would have dropped the native edit.
- **`pending={!!pendingKey}` → `pending={writePending}` on every control, and delete the per-key `matrixKeyOf(tool)` call site.** Leaving the old `const key = matrixKeyOf(tool)` in the row mapper is dead code (eslint warning) — remove it when switching the prop.
- **Test 1 asserts at a single-tick granularity via `expect.poll` on the stored config**, string-packed `"<bash>|<edit[src/**]>"`. Asserting the two changes separately is racy (a first poll can pass on the bash half while the clobbering write is still in flight); the packed string makes `"allow|deny"` atomic and makes the stale-source mutation deterministic (it polls to `deny|deny` for the full 10s).
- **In-flight gate test needs a held route, not a slow one.** `page.route` + an unresolved promise held for the assertion window, then `release()` in a `finally`; assert `aria-disabled="true"` on a *different* tool row than the one being written, plus the native input `toBeDisabled()` and effect chips `aria-disabled`. The `ToolEffectSelect` disables via `aria-disabled` + `onClick: undefined` (not the `disabled` attr on a span) — `toBeDisabled()` does not apply to it; `native-rule-glob` is a real `<input disabled>` so it does.
- **Todo 3's test 6 is a legitimate contract change, not a weakened test.** It asserted post-reload `ask` (state-only), which todo 4 superseded by persistence; rewritten to poll `GET /execution-policies/:id` → `allow` then re-assert after reload. Comment in the spec states this explicitly.
- **Harness:** `scripts/e2e-policy-serialize.sh` + `web/e2e/policy-serialize.spec.ts` (new, 4 tests), tmp config `.t4.playwright.config.ts`, `channel:"chrome"`, evidence `task-4-serialized.json`. Rebuild required: `docker compose build web && docker compose up -d web` — verify with `docker exec aiagents-compose-web sh -c "grep -rl 'native-rule-editor' /app/.next"` before blaming the spec.
- **Restore discipline:** pre-mutation sha `ca42274a…` (backed to `/tmp/todo4-backup/page.tsx.final`), post-mutation `370237b5…`, restored via `cp` + `shasum -a 256` + `diff -q` → identical. **Never `git checkout --`/`git restore`** (destroys uncommitted work in this file owned by todos 3/5).
- **ACCEPTED residual (recorded in code at the mutation, review fix m4):** the single-page in-flight gate does not close a **multi-client** race — `execution_policies` has no `version`/CAS column, so two browsers (or the raw API) PATCHing the same policy still last-write-wins. Not solved by design; no version column, no migration.
- **Result:** new suite 4/4 green, todo-3 suite 7/7 green (updated test 6), `npx tsc --noEmit` exit 0. Cleanup verified: 0 residue agents/policies.

## Todo 5 — [web] 重启通知 + 一键重启（2026-09-19）

- **传播规则是设计的核心**：策略行（`execution_policies`）是全局的，而 worker 侧 `injectAll()`
  （写 `opencode.json` + `.vteam-role-guard/roles.json`）逐 worker 执行 → 策略 PATCH 广播为 0，
  必须重启**每一个**已注册 worker。重启动作**不筛在线态**：命令经心跳下发，离线 worker 上线后
  仍会收到排队命令；筛掉离线只会留下永不生效的 worker。
- **写盘成功 ≠ 生效**：`policyMutation.onSuccess` 是唯一可靠的「已落库」信号，`setRestartNeeded(true)`
  挂在那里；通知文案必须说「尚未生效」，完成态只说「命令已下发」，绝不宣称已生效。
- **不自动重启**：重启会中断在途会话 → 只提示、由用户显式点击。e2e 用 `page.route` 拦截
  `**/workers/*/restart` 计数为 0 来锁定该行为。
- **零 worker**：不要渲染禁用按钮（死按钮），改渲染空态句（`policy-restart-empty`）。
- **e2e 测试写盘确认的可靠手法**：`expect.poll` 直读服务端 `GET /execution-policies/:id` 的
  `config.permission.bash`，而不是轮询 UI（debounce 400ms + PATCH 在途 + 回读竞态下 UI 断言脆弱）。
- **负断言窗口**：断言「某请求从未发出」时无事件可等，用短 `waitForTimeout(750)` + 计数断言
  （先等一个后置的肯定信号，如按钮仍可见，再等窗口）——避免把 flaky 引入用固定 sleep 监听的误区。
- **restart 端点真实存在，测试必须拦截**：`POST /workers/:id/restart` 经心跳真实排队重启命令；
  本 QA 全程用 `page.route` + `route.fulfill` 本地应答，未向真实 worker 下发任何重启（收据：
  task-5-restart-notice.json 内 `real_restart_avoided_by_route_fulfil: true`；worker 仍 online）。
- **mutation proof 手法**：拷 `page.tsx` 到 `/tmp` → 删 `setRestartNeeded(true)`（4 个测试全红）
  → `cp` 回覆盖 + `shasum -a 256` 与原 sha 逐字节比对 -> 重新 build。**绝不 `git checkout --`**。
- **截图证据**：fullPage 截图会从页顶开始，通知在折叠线下 → `scrollIntoViewIfNeeded()` 先把
  `[data-testid=policy-restart-notice]` 滚进视口再截，否则证据图里看不到本次交付物。

---

## [2026-09-19] todo 9 — policy PATCH must itself broadcast reload-config

**The root cause the plan missed.** `POST /workers/:id/restart` ONLY runs `restartCoordinator`
(serve restart + reRegister) — it NEVER calls `injector.injectAll()` (`worker/src/index.ts:769`
vs `:861`). Only `reload-config` re-injects. `mcp-servers`/`skills`/`tools` services already
broadcast it on change; `execution-policies` did not. So a policy PATCH never reached
`opencode.json` / `.vteam-role-guard/roles.json` no matter how many times you hit restart.
Fix: inject `WorkersService` (REQUIRED, not `@Optional`) into `ExecutionPolicyService` and
broadcast after a successful `update()`.

**Actions that worked (copy these):**
- Module wiring: plain `imports: [... WorkersModule]` — NO `forwardRef` needed. Verified the
  graph has no back-edge (`WorkersModule` deps Realtime/forwardRef(McpServers)/forwardRef(Models),
  none import ExecutionPolicies). Boot logs: `ExecutionPoliciesModule dependencies initialized`,
  0 circular errors. The task said "if Nest reports a circular-dependency error, THEN forwardRef" —
  it did not, so plain import stands.
- **tsc passing does NOT mean all spec construction sites are covered.** There is a 13th site that
  is NOT a `new ExecutionPolicyService(...)`: `agent-policies.controller.spec.ts` builds the service
  through a Nest `TestingModule` provider list. tsc exits 0; only `jest` surfaces
  `Nest can't resolve dependencies of the ExecutionPolicyService (..., ?)`. Always run the full
  jest suite after adding a required constructor dep — grep for `new X(` is insufficient.
- **Discriminating mutation proof is cheap and decisive**: back the file up to `/tmp`, delete the
  one `await this.broadcastReloadConfig();` line, rebuild+redeploy, PATCH a NEW marker
  (`**t9-mut/**`), POST restart, observe count stays 0. Then `cp` back, compare `shasum -a 256`
  (byte-identical), rebuild. Never `git checkout --`.
- Use a FRESH marker per phase (`t9-probe` for the fix, `t9-mut` for the mutation, then clear both
  on restore) so artifact counts are unambiguous and don't collide with prior runs' leftovers.
- Restore via the API's own PATCH with the exact snapshot `name`/`description`/`config` — then assert
  `config == snapshot`, `name == snapshot`, and that both markers are gone from both artifacts.
- Frozen-sha gate is a plain `shasum -a 256 .omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`
  — re-check it after ALL mutations/restores, not only at the end.

**Baseline drift observed:** current full jest is 134 suites / 3101 tests (the native-edit spec +
the 3 new tests), and `agent-policies.controller.spec.ts` was an unlisted 13th ctor site.

## [2026-09-19] todo 8 — end-to-end enforcement + byte-identity (parts b-e)

**The proof is one script: `scripts/e2e-native-edit-enforcement.sh`** (modelled on
`e2e-role-boundaries.sh`: `REPO_ROOT`/`SERVER_URL`/`EVIDENCE_DIR`/`log/pass/fail`/`sha256_of`/
`docker_compose` + cleanup-on-EXIT). It needs NO model/serve — only server + worker.

**Propagation is automatic, and the assertion must NOT depend on a restart.** After the PATCH the
worker re-injects within ~10s (todo-9 broadcast). The script POLLS `<WORK_DIR>/opencode.json`
(`/data/vteam-worker/opencode.json`) via `docker compose exec -T worker cat …` and never calls
`POST /workers/:id/restart`. Observed convergence: iter #2 (~10s), consistently.

**The probe must be an `edit` glob, and it lands in `opencode.json`, NOT `roles.json`.** `edit` is
layer-① only; `roles.json`'s `vteam-product.tools` map is layer-② and does not change. Assert
`roles.json` is still well-formed and `tools` count stays 27 (proves the edit did not corrupt the
guard roles doc) — do NOT assert the glob appears in `roles.json`.

**Frozen-sha gate ran FIRST and LAST** (`shasum -a 256` on
`.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json` == `3b8c5d4b…`), and it
is never written to. The EXIT trap also prints it.

**Byte-identity of the other 6 builtins**: canonical JSON compare of a 7-agent subset of
`/agent-policies` against the frozen baseline (same technique as `e2e-role-boundaries.sh` f2).
`/agent-policies` also carries a custom agent (`vteam-myagent`) — the subset pins only the 7
baseline names, so a custom agent does not break the compare.

**Mutation check (the acceptance criterion):** neutralize ONLY the two-line catch-all injection at
the end of `assertValidConfig` (replace each assignment with `void permission.edit;` — a bare
comment-out breaks TS narrowing on the `...edit` spread, TS2698; `void` keeps tsc exit 0), rebuild
server, run the script → **(e) FAILS** with `edit=None (want {'*':'deny'})`, stored config
`{"bash":"deny"}` (no edit key). Everything else stays green: **(b) does not exercise the
injection** because its PATCH explicitly carries the `'*'` key, and **(d)** is untouched. The
failure is captured verbatim in `task-8-enforcement.txt` Part 2.

**Restore discipline (never `git checkout --`/`git restore`):** snapshot to
`/tmp/t8-eps-final.ts.bak` (sha `c5f50430…`), `cp` back, `shasum -a 256` both sides identical,
`diff -q` identical, `grep -c MUTATION` = 0, `git diff` on the file EMPTY. Rebuild, re-run → green
again. The `[e2e] cleanup:` EXIT-trap also proves `ep_product`/all 7 restored each run.

**(d) `permission.write`:** PATCH `ep_product` with `permission.write='allow'` on top of its snapshot
→ stored `config.permission` has NO `write` key and equals the snapshot permission; a recursive scan
of the emitted `/agent-policies` finds no `write` key anywhere (worker throws at
`opencode-config-builder.ts:111-115` → would neutralize the whole guard). `assertValidConfig`
strips it in place (`delete permission.write`).

**(e) M1:** PATCH `permission={'bash':'deny'}` (no `edit`) → stored `permission.edit == {'*':'deny'}`.

**Restore is first-class and verified three ways** per cycle: probe absent from the injected
artifact, stored `name`/`description`/`config` == snapshot (canonical), and all 7 builtins
byte-identical to the frozen baseline.

**Evidence:** `.omo/evidence/agent-native-permission-editor/task-8-enforcement.txt` (3 parts:
green run → mutation failure → restored green), raw responses under `task-8/`.
**Gate:** `npx tsc -p tsconfig.json --noEmit` exit 0; full `npx jest --runInBand` = **134 suites /
3101 tests** green (baseline unchanged). Part (a) spec `agent-policies.native-edit.spec.ts` 6/6.
Production `server/src/**` + `worker/**` diff empty after the transient mutation was restored.

---

## Todo 10 — restart-notice copy correction (F1+F3 finding, verified live)

**Fact that invalidated the todo-5 copy:** `worker/src/index.ts:769-785` on `reload-config`
does `await injector.injectAll()` (rewrites BOTH `opencode.json` and
`.vteam-role-guard/roles.json`) and THEN `restartCoordinator.requestRestart()`. So for an
ONLINE worker with no active session the policy change applies automatically in ~10-15s —
manual restart is NOT required. F3 observed the artifacts update and the `serve` PID change
(5855→5926→6093→6163) with zero manual restarts. The todo-5 copy ("尚未生效…worker 重启后
才会写入") told users a false requirement.

**Real propagation rule now encoded in the UI (and asserted in the spec):**
1. policy is global, `injectAll()` runs per worker;
2. online worker → auto re-inject (+ serve restart) → effective in ~10-15s;
3. offline worker → applies on next register/start;
4. worker with an ACTIVE session → the `serve` restart is deferred until the session drains.
The restart button stays as an OPTIONAL "立即重启全部 worker" (force it / offline workers),
and save still does NOT auto-restart (spec asserts 0 restart requests on save).

**Mutation-proof recipe that worked (no git checkout/restore):**
- back up the file: `cp <src> /tmp/task10-page.tsx.fixed`; `shasum -a 256` both;
- mutate with a python one-liner asserting the exact new string count == 1;
- rebuild ONLY web (`docker compose build web && docker compose up -d web`) — never
  `--force-recreate` (re-runs `init`, can reseed/revert the DB);
- run the spec → the corrected-copy assertion must FAIL with `toContainText(expected)`
  and Received string showing the old sentence; the other 3 tests stay green;
- restore with `cp /tmp/...backup <src>`; `shasum -a 256` must match byte-identically.

**Pitfall:** `scripts/e2e-policy-restart-notice.sh` deletes its tmp
`web/.t5.playwright.config.ts` on EXIT (trap). A mutation run that does not go through the
script must recreate that tmp config itself, otherwise Playwright exits 1 with
"config does not exist" (a false red that is NOT the discriminating failure).

**Evidence:** `.omo/evidence/agent-native-permission-editor/task-10-notice-copy.png|json`,
`task-10-mutation-proof.txt`, `task-10-cleanup-receipt.txt`. Suites re-run green:
restart-notice 4/4, native-rule-editor, policy-serialize, create-agent-role 4/4.

**Pitfall 2 (evidence file clobber):** `scripts/e2e-create-agent-role.sh` line 40 does
`: >"$E2E_LOG"` — running it TRUNCATES the shared `.omo/evidence/.../e2e.txt` (all prior
suites' sections). The append-only scripts (native-rule-editor, policy-serialize,
policy-restart-notice) are safe. Recovery: `git show HEAD:<path> > <path>` (read-only, NOT
`git checkout --`), then re-append the current run; keep the clobbering suite's own section
in a side file and paste it under the new run header.

---

## [2026-09-19] todo 11 — editor whole-config PATCH must carry `bashDeny` (F2 data-loss, closes todo 2's invariant)

**The defect (F2, orchestrator-verified):** the editor's payload type was `{permission, correction,
tools}` and `EffectivePermission.bashDeny` was declared but never read — so every save silently
dropped `config.bashDeny` (the exact field todo 2 / `6b057f7` added to the DTO precisely to survive
whole-config writes). Latent today (no seeded policy carries it, `ROLE_BASH_DENY_PATTERNS=[]`), but
real data loss for API-created policies.

**The trap the task text had wrong — verify the server BEFORE coding the presence check.** The brief
said to include `bashDeny` "only when present" with `Array.isArray(bashDeny)` as the discriminator.
Empirically (live `GET /agents`):
`GET /agents → effectivePermission.bashDeny` is **ALWAYS present and ALWAYS an array** — `[]` when
the stored config lacks the key — because `resolveBashDeny(config.bashDeny)` falls back to
`ROLE_BASH_DENY_PATTERNS` (`execution-policy.service.ts:330-334`). `Array.isArray` is therefore
always true and would have materialised `bashDeny: []` into EVERY PATCH, failing the mandated
negative control (`'bashDeny' in config === false`). The correct discriminator is
**`Array.isArray(x) && x.length > 0`**. General rule for this codebase: a *resolved* effective
value ≠ the *stored* config value — never infer key-presence in the store from a resolved DTO.

**Implementation (all in `web/app/(main)/agents/page.tsx`):**
- `EffectivePermission.bashDeny`: `unknown` → `string[]` (server guarantees the type).
- `PolicyConfigPayload` gains `bashDeny?: string[]`.
- Sync effect + `currentConfig()` fallback: conditional spread
  `...(Array.isArray(bashDeny) && bashDeny.length > 0 ? { bashDeny } : {})`.
- Both write paths (native-debounce, tool-toggle) build `{...cur, …}` → extra keys survive; verified
  by reading AND behaviourally (test 5).
- **Deliberate deviation from todo 4's fence** "Must NOT change the payload shape": that fence
  predates todo 2's field; todo 2's whole-config-preservation mandate supersedes it for this ONE key.
  Endpoint and `{config:{…}}` envelope unchanged.

**Mutation proof (discriminating, decisive):** removed ONLY the sync-effect conditional spread
(python replace asserting count==1), rebuilt web, re-ran the suite → test 5 fails with
`Expected: "deny|[\"rm -rf /\"]" / Received: "deny|undefined"` (the field dropped = pre-fix behaviour)
while tests 1-4 stay green — proving the assertion is real and discriminates exactly this defect.
Restore by `cp` from `/tmp` + `shasum -a 256` (byte-identical, `1e95db7a…`), marker grep == 0,
rebuild, re-run green. Never `git checkout --`/`git restore`.

**Playwright idiom that worked:** one test, two API-created policies (one with `bashDeny`, one
without) on two QA agents; edit an UNRELATED permission through the real UI (add an `edit` glob /
toggle bash), then poll the stored config with a single string compare
`` `${edit}|${JSON.stringify(cfg.bashDeny)}` `` against
`` `deny|${JSON.stringify(["rm -rf /"])}` `` for the positive case, and `expect("bashDeny" in cfg).toBe(false)`
for the negative control. Cleanup both in one `finally`.

**Evidence gotcha (re-confirmed):** `scripts/e2e-create-agent-role.sh:40` truncates the shared
`e2e.txt`. Recover prior content with `git show HEAD:<path> > <path>` (read-only, NOT
`git checkout --`) and re-append the run sections; keep each suite's own log in a side file before
running the truncating suite.
