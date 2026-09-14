# Issues — vteam-role-behavior-enforcement

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## Todo 2 — pre-existing red model-catalog spec

- At baseline `2fb188a`, `agent.constants.spec.ts` was already RED (6 failures): the production
  `STATIC_AVAILABLE_MODELS`/`TEMPLATE_DEFAULT_MODELS` were intentionally emptied (dynamic worker-reported
  catalog; see `seed.spec.ts:78`), but the spec still asserted 16 static models / `opencode/big-pickle`
  defaults. Unrelated to role enforcement.
- Since the spec file is in Todo 2 scope and the gate requires green, the stale `模型目录 seed 预置` block was
  realigned to the documented dynamic reality (static catalog empty, `buildModelSeedRows()` → `[]`,
  `TEMPLATE_DEFAULT_MODELS` → `{}`). No production model code was touched.
- `ROLE_BOUNDARIES` deliberately does NOT use the git-only names `git_fetch`/`git_push` in any `toolAllows`
  (per Permission matrix); they remain in `VTEAM_GIT_TOOL_NAMES` for the matrix self-check (Todo 24).
