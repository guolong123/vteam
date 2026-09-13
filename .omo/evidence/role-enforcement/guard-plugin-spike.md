# Todo 18 — Guard Plugin (`vteam-role-guard`) Discovery / Hook-Coverage Spike

- Plan: `.omo/plans/vteam-role-behavior-enforcement.md` (Todo 18)
- Date: 2026-09-13
- Repo: `/Users/mac/01work/git-project/vteam`
- opencode version: **1.18.30** (from Todo 17 evidence; `worker/Dockerfile:30` unpinned)

---

## 1. Plugin discovery dir used

- **Official discovery (docs)**: project plugins live in **`.opencode/plugins/` (plural)**,
  global in `~/.config/opencode/plugins/`; `opencode.json` `plugin` array entries are
  loaded explicitly (package names like `oh-my-openagent@latest` or paths).
- **Choice**: guard file is written to **`<workDir>/.opencode/plugin/vteam-role-guard.ts`
  (singular — Todo 15 single-path scheme, `GUARD_PLUGIN_REL`) and registered as an
  **explicit relative entry `./.opencode/plugin/vteam-role-guard.ts`** in `opencode.json`
  `plugin` array. Explicit-array registration does NOT depend on the plural discovery
  dir, so the singular path is safe; fallback = absolute path entry (same regex cleanup).
- Cleanup matches any entry containing `vteam-role-guard` (`ROLE_GUARD_ENTRY_RE`).

## 2. Hook signature (opencode 1.18.30 docs)

- Plugin factory: `export const VteamRoleGuard = async (ctx) => ({ "tool.execute.before": … })`,
  `ctx` provides `{ project, client, $, directory, worktree }`.
- `"tool.execute.before": async (input, output)` with
  `input = { tool: string, sessionID: string, callID: string }`,
  `output = { args: any }` (mutable). **Deny = `throw new Error(<correction>)`**
  (opencode blocks the call and surfaces the message to the model).
- `<workDir>` resolution (three anchors): ① plugin's own injection location
  (`import.meta.url` → up two levels from `.opencode/plugin/`); ② `ctx.directory`
  upward findUp (covers `directory=<workDir>/tasks/<id>` execution dirs, Todo 17
  discovery); ③ fallback `ctx.directory || process.cwd()`. First anchor whose
  subtree contains `.vteam-role-guard/roles.json` (else `opencode.json`) wins.
- Arg keys assumed (Todo 18 plan): `edit`/`write` → `filePath` (+`path` compat),
  `apply_patch` → `patchText`, `bash` → `command` — handled by the inlined
  `extractEditTargets`, unparseable → allow (layer ① decides).

## 3. Render choice

- **Render-inline snapshot, NOT `toString()`**: `policy.ts` helpers are module-private,
  so `toString()` would only capture the 5 exported shells. The emitted module embeds a
  faithful hand-aligned copy (markers `<vteam-role-guard:decision-begin/end>`); equivalence
  with `worker/src/role-guard/policy.ts` is locked by a **20-case parity matrix**
  (`role-guard-plugin.spec.ts`: pass-through ×4, fail-closed ×1, read/edit/bash/task ×8,
  passthrough/browser/allowlist ×7) — any `policy.ts` branch change without snapshot sync fails.
- Emitted module imports only `node:fs` / `node:path` / `node:url`; zero opencode/server imports
  (worker iron rule holds on both sides).

## 4. Hook coverage — static reasoning (LIVE RUN: UNVERIFIED)

- `tool.execute.before` fires **before every tool execution** (opencode `session/prompt.ts`
  call sites; docs list no per-tool opt-out) → builtin (`read`/`edit`/`bash`/`task`),
  custom (`.opencode/tools/*.ts`: default export = filename, named = `<file>_<export>`,
  e.g. `git_clone`), and MCP tools all reach the hook.
- **Open question for Todo 21 e2e (UNVERIFIED)**: the exact runtime `input.tool` string for
  platform MCP tools — allowlist uses real exposed names `vteam_<action>` (Todo 12/20).
  If the runtime prefixes them (e.g. `mcp__vteam__<action>`), mapped sessions would
  fail-closed-deny them (safe direction; layer ① `permission.<real-name>` still applies).
  Confirm actual runtime names live and align the allowlist if needed.
- `sessionID` for serve-created sessions maps to Todo 19's
  `.vteam-role-guard/sessions/<sessionID>.json`; absent file → pass-through (verified in
  disk-harness simulation; writer itself is Todo 19, out of scope here).

## 5. Verification (this todo)

- `worker/src/resources/role-guard-plugin.spec.ts`: **10/10 green** (render validity via
  `typescript.transpileModule` zero errors, byte-stable render, 20-case parity, disk-harness
  deny/allow/pass-through, injector write+register+idempotence+neutralize).
- `worker/src/resources/` full dir: **65/65 green** (incl. updated `injector.spec.ts`
  `(a)(b)` plugin-array expectations).
- `cd worker && npx tsc -p tsconfig.json --noEmit` exit 0.
