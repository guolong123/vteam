# Todo 17 — Config Discovery / `--pure` / Universal Glob Base + Version + Rollback

- Plan: `.omo/plans/vteam-role-behavior-enforcement.md` (Todo 17)
- Date: 2026-09-13
- Repo: `/Users/mac/01work/git-project/vteam`
- opencode version (VERIFIED): **1.18.30** (`~/.opencode/bin/opencode --version` → `1.18.30`, exit 0)
- `worker/Dockerfile:30`: `ARG OPENCODE_CLI_SPEC=opencode-ai` — **unpinned** (each build takes npm latest; pin via `--build-arg OPENCODE_CLI_SPEC=opencode-ai@<ver>` for repro)

---

## 1. Config discovery: `<workDir>/opencode.json` from `directory=<workDir>/tasks/<id>`

**Mechanism (VERIFIED, static):**

- Worker writes ONE `opencode.json` at `<workDir>/opencode.json` via the single-writer
  `ResourceInjector.injectMcpAndAgents()` (`worker/src/resources/injector.ts:307-352`; agent +
  mcp + plugin sections in one read-modify-write).
- Execution passes `directory=<workDir>/tasks/<taskId>` per session: `POST
  /session/{id}/prompt_async?directory=...` (`worker/src/driver/v1-driver.ts:280-286`);
  `GET /agents?directory=` uses the same directory so the listed agent set matches execution
  (`worker/src/exec/exec-server.ts:756-789`, comment: "serve 按 directory 发现 opencode.json
  的 agent 节，per-directory 隔离" — previously measured per-directory isolation).
- opencode serve resolves config per `directory` by searching upward (findUp-style): a task dir
  `<workDir>/tasks/<id>` has no own `opencode.json`, so lookup climbs to `<workDir>/opencode.json`
  where the injector wrote the `agent` section. Reproduced with a node one-liner (tmp workDir +
  `tasks/t_1` + `opencode.json`, upward walk): **PASS — hits `<workDir>/opencode.json`**.

**Live serve probe (UNVERIFIED — reason: starting a live `opencode serve` + session round-trip
was impractical in this task; no serve was spawned):** end-to-end `createSession →
prompt_async(directory=taskDir)` picking up the `agent` section was NOT re-probed here.
Prior art: `exec-server.ts:761` records measured per-directory isolation; full live
re-verification is deferred to Todo 21 e2e.

---

## 2. `--pure` semantics + guard-not-loaded warning

**`isPureMode()` (`worker/src/runtime/opencode-server.ts:310-322`) (VERIFIED, static + unit):**

- Sources: `OPENCODE_PURE` env truthy (`1/true/yes/on/y`, case-insensitive) OR
  `omoEnabled()` returns false (user turned OmO off). Either "off" → spawn adds `--pure`.
- `--pure` = external plugins not loaded (incl. `vteam-role-guard` + OmO) → layer ② guard
  absent: bash bypass, no guard for custom tools, no correction text.
- Native `permission.edit` config (the `agent` section in `<workDir>/opencode.json`) still
  applies under `--pure` — layer ① is config-driven, not plugin-driven (consistent with
  Degradation row 31: "仍生效（仅原生 edit/write 等）").
- Empty/blank `OPENCODE_PURE` is deleted, never passed through (opencode SchemaError guard;
  covered by existing spec).

**Warning (was MISSING → ADDED in this todo):**

- Before: `spawnServe()` pushed `--pure` silently; no "guard not loaded/degraded" log existed
  (grep for `guard.*(未加载|降级|not loaded)` in `worker/src` found nothing in
  `opencode-server.ts`).
- After (`opencode-server.ts`, `spawnServe`): on pure mode, `logger.warn` emits blocking-level:
  `[opencode-server] guard 未加载/降级（--pure）：外部插件不加载，vteam-role-guard 无守卫；原生 permission.edit 仍生效，bash/自定义工具越界不受 guard 拦截`
- Test: `opencode-server.spec.ts` — `OPENCODE_PURE=1 → spawn 带 --pure 且阻断级 guard
  降级告警；非 pure 无告警` (asserts `--pure` in spawn args + warn contains
  `guard 未加载/降级`, and no such warn when pure is off). Suite: **28/28 green**;
  `npx tsc -p tsconfig.json --noEmit` exit 0.

---

## 3. Universal glob `**tasks/*/<subdir>/**` (VERIFIED, node replica of `Wildcard.match`)

Exact replica of opencode 1.18.30 `packages/core/src/util/wildcard.ts`
(`*`→`.*` crossing `/`, anchored `^...$`, `/`-normalized; backslash branch N/A on darwin):

```
PASS | worktree=/                | rel=data/vteam-worker/tasks/t_1/docs/spec.md | glob=**tasks/*/docs/** | match=true
PASS | worktree=/data/vteam-worker | rel=tasks/t_1/docs/spec.md                   | glob=**tasks/*/docs/** | match=true
PASS | worktree=/                | rel=data/vteam-worker/tasks/t_1/tests/case.md | glob=**tasks/*/docs/** | match=false
PASS | worktree=/data/vteam-worker | rel=tasks/t_1/tests/case.md                   | glob=**tasks/*/docs/** | match=false
ABS-GLOB vs rel-input "tasks/t_1/docs/spec.md"                -> NO-MATCH(GOOD)
ABS-GLOB vs rel-input "data/vteam-worker/tasks/t_1/docs/spec.md" -> NO-MATCH(GOOD)
FINDUP: PASS hits <workDir>/opencode.json
```

- One glob hits BOTH worktree bases (non-git `worktree="/"` → `data/vteam-worker/tasks/...`;
  git `worktree=WORK_DIR` → `tasks/...`). Full matrix in Todo 2 spike
  (`.omo/evidence/role-enforcement/glob-base-spike.md`).
- Absolute-path globs rejected: opencode feeds a worktree-relative path, so absolute globs
  never match (verified above) and would leak deploy paths — do NOT add absolute globs.

---

## 4. Rollback procedure (role enforcement → status quo)

1. Unbind: clear `policyId` on template/custom agents (or re-run seed **before** role policies
   existed — baseline seed has no `ep_<role>` policies; re-running current seed re-adds them,
   so unbind must be explicit via API/PATCH or DB).
2. Delete `agent` section: remove injector-managed names from `<workDir>/opencode.json`
   (`agentNames` manifest keys; user-written keys stay) — or run injector neutralization path
   (`/agent-policies` failure → managed keys removed, `roles.json{enabled:false}`).
3. Delete `.vteam-role-guard/` (i.e. `roles.json` + `sessions/`).
4. Delete guard plugin file `<workDir>/.opencode/plugin/vteam-role-guard.ts` + remove its
   `plugin` array entry from `opencode.json` (injector `cleanupByManifest('guardPluginFile')`
   + `removeGuardPluginEntry` do exactly this).
5. Restart worker (serve respawns without `--pure` change; OmO plugin entry untouched).
6. Verify: `GET /agents?directory=<taskDir>` no longer lists `vteam-*`; capabilities report
   `agentPolicies.enabled=false`.

---

## 5. VERIFIED vs UNVERIFIED summary

| Item | Status | Basis |
|---|---|---|
| opencode version 1.18.30 | VERIFIED | `~/.opencode/bin/opencode --version`, exit 0 |
| `OPENCODE_CLI_SPEC` unpinned (`Dockerfile:30`) | VERIFIED | file read |
| `isPureMode()` pure sources + `--pure` spawn | VERIFIED | code read + 28 unit tests |
| guard-not-loaded warning on pure | VERIFIED | new code + new test, tsc exit 0 |
| universal glob both bases + absolute rejection | VERIFIED | node `Wildcard.match` replica, all PASS |
| findUp `<workDir>/opencode.json` from task dir | VERIFIED (mechanism) | injector single-writer + driver `directory` + node upward-walk PASS |
| live serve e2e (session picks up agent section; pure edit/write denial) | UNVERIFIED | no live serve spawned; deferred to Todo 21 e2e |
