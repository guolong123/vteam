# Role Enforcement — Todo 2 Glob Base Spike

- Plan: `.omo/plans/vteam-role-behavior-enforcement.md` (Todo 2)
- Date: 2026-09-13
- Repo: `/Users/mac/01work/git-project/vteam` @ `2fb188a`
- Installed opencode: **1.18.30** (`opencode --version`)
- Verdict: **universal root-agnostic glob `**tasks/*/<subdir>/**` adopted**. Absolute-path globs and `git init` rejected.

---

## 1. `Instance.worktree` behavior (installed opencode 1.18.30)

Source-of-truth (verified byte-identical between tag `v1.18.0` @ `32696c425fc0fa1ec285389346cfa1fbe22b670a`
and tag `v1.18.30` @ `3104c1428ec91f809e5ab86631300de41eb6952e`):

- `packages/opencode/src/project/project.ts` (fromDirectory):
  ```ts
  const worktree = data.id === ProjectV2.ID.make("global") && !data.vcs ? "/" : data.directory
  return { project: result, sandbox: data.vcs ? data.directory : worktree }
  ```
- `packages/core/src/project.ts` (`ProjectV2.resolve`):
  ```ts
  const repo = yield* git.repo.discover(input)
  if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }
  return { ..., directory: repo.worktree, vcs: { type: "git", store: repo.commonDirectory } }
  ```

=> `InstanceContext.worktree` = `result.sandbox`:

| Case | `Instance.worktree` | `Instance.directory` |
|---|---|---|
| WORK_DIR is **NOT** a git repo | **`"/"`** (literal POSIX root; even on Windows) | resolved WORK_DIR |
| WORK_DIR **is** a git repo | **git top-level** (`git rev-parse --show-toplevel`); if WORK_DIR is the repo root, `worktree === WORK_DIR` | resolved WORK_DIR |

Note: `directory` is always the launch dir; only `worktree` is git-root/"‌/". A failed `git rev-parse`
falls back to `path.dirname(.git)` or is treated as non-git (`/`).

### Runtime corroboration (installed 1.18.30 `project` table in `~/.local/share/opencode/opencode.db`)

```
$ opencode --version
1.18.30

# non-git dir (/private/tmp/ocspike-nongit2): opencode debug config → fallback "global" project
$ sqlite3 -header "$DB" "SELECT id, worktree, vcs FROM project WHERE id='global' OR worktree LIKE '%ocspike%';"
id|worktree|vcs
global|/|

# git repo WORK_DIR (/Users/mac/01work/git-project/vteam): its own project, worktree = git root
$ sqlite3 -header "$DB" "SELECT id, worktree, vcs FROM project WHERE worktree='/Users/mac/01work/git-project/vteam';"
id|worktree|vcs
d6178fe41ff28b5142042e04c67e64f7bac93186|/Users/mac/01work/git-project/vteam|git
```

Observation: non-git → `worktree = "/"` (`vcs` NULL); git repo → `worktree = <git root>` (`vcs = git`).
Both confirm the source-derived table above.

---

## 2. The matched string: `path.relative(Instance.worktree, absoluteFilePath)`

`permission.edit`/`permission.read` globs are matched against a **relative** path, not the raw tool input
and not the absolute path. Sources (opencode 1.18.x):

- `packages/opencode/src/permission/index.ts` — `evaluate()` uses
  `Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)`; `edit`/`write`/`apply_patch` map to permission key **`edit`**, `read` to **`read`**.
- `tool/edit.ts`, `tool/write.ts`, `tool/read.ts`:
  `patterns: [path.relative(instance.worktree, filePath)]`
- `tool/apply_patch.ts`: `fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))`

Consequence for a task dir under WORK_DIR:

| WORK_DIR | matched string for `/data/vteam-worker/tasks/t_1/docs/spec.md` |
|---|---|
| non-git (`worktree="/"`) | `data/vteam-worker/tasks/t_1/docs/spec.md` |
| git with WORK_DIR = repo root (`worktree=WORK_DIR`) | `tasks/t_1/docs/spec.md` |

Both are hit by `**tasks/*/docs/**` (the `**` prefix is `.*`, which is allowed to be empty).

---

## 3. `Wildcard.match` semantics (opencode 1.18.30)

`packages/core/src/util/wildcard.ts` (used by the permission service):

```ts
export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
```

- escapes regex specials, then `*` → `.*` (crosses `/`), `?` → `.`; anchored `^...$`.
- backslashes normalized to `/`; case-sensitive on macOS/Linux.

---

## 4. Empirical hit/miss for the universal glob (node replica of the exact `match()`)

Command: `node /var/folders/.../T/opencode/glob-spike.mjs` (script uses `path.relative(worktree, abs)` then the
exact `Wildcard.match` above). Raw output:

```
node v24.14.0 platform darwin
WORK_DIR = /data/vteam-worker

HIT  | A non-git docs
      worktree   = "/"
      abs        = /data/vteam-worker/tasks/t_1/docs/spec.md
      pattern    = "data/vteam-worker/tasks/t_1/docs/spec.md"
      glob       = "**tasks/*/docs/**"
      match()    = true
MISS | A non-git docs miss prototypes
      worktree   = "/"
      abs        = /data/vteam-worker/tasks/t_1/docs/spec.md
      pattern    = "data/vteam-worker/tasks/t_1/docs/spec.md"
      glob       = "**tasks/*/prototypes/**"
      match()    = false
HIT  | B git docs
      worktree   = "/data/vteam-worker"
      abs        = /data/vteam-worker/tasks/t_1/docs/spec.md
      pattern    = "tasks/t_1/docs/spec.md"
      glob       = "**tasks/*/docs/**"
      match()    = true
MISS | B git docs miss tests
      worktree   = "/data/vteam-worker"
      abs        = /data/vteam-worker/tasks/t_1/docs/spec.md
      pattern    = "tasks/t_1/docs/spec.md"
      glob       = "**tasks/*/tests/**"
      match()    = false
HIT  | B git dev nested
      worktree   = "/data/vteam-worker"
      abs        = /data/vteam-worker/tasks/t_1/src/a/b.ts
      pattern    = "tasks/t_1/src/a/b.ts"
      glob       = "**tasks/*/**"
      match()    = true
HIT  | C absolute input docs
      worktree   = "/"
      abs        = /data/vteam-worker/tasks/t_1/docs/spec.md
      pattern    = "data/vteam-worker/tasks/t_1/docs/spec.md"
      glob       = "**tasks/*/docs/**"
      match()    = true

worktree=/"  input pattern matches GLOB_DOCS : true
worktree=WORK_DIR input pattern matches GLOB_DOCS : true
```

- `**tasks/*/docs/**` matches `tasks/t_1/docs/spec.md` **and** `data/vteam-worker/tasks/t_1/docs/spec.md`.
- Wrong subdir (`prototypes`/`tests`) correctly misses.
- An absolute path input is **not required**; opencode always feeds a worktree-relative path.

---

## 5. Decision

- **Adopted**: `writeGlobs` use the universal root-agnostic form `**tasks/*/<subdir>/**` (derived by
  `taskSubdirGlob()` / `taskAllGlob()` in `agent.constants.ts`). Same glob works for both worktree bases,
  so no WORK_DIR detection or per-worktree branching is needed.
- **Rejected: absolute-path globs** — the matcher receives a worktree-relative path, so absolute globs never
  match (and would leak the deploy path into configs).
- **Rejected: `git init` on WORK_DIR** — unnecessary; the universal form already handles the non-git
  `worktree="/"` case without initialising a repo (which would alter task dir semantics and side effects).
- Layer ① edit permission map is derived as `{"*":"deny", ...writeGlobs:"allow"}` via `buildEditPermission`;
  `read` map is `{"*":"allow"}`.
