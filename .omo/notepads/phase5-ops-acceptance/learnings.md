# Learnings — phase5-ops-acceptance

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## T0 · Git 基线首次提交（M5 前置）

- **实际未跟踪文件数 = 216**（非任务预估的 217），根目录 PNG 实为 **11 个**（非约 99）——任务描述的数量为估算，以 `git status --porcelain` 实测为准。
- **`.playwright-mcp/` 是 240 个运行时调试产物**（console log / page yml 快照 / diff 截图），此前未在忽略清单中，会随 `git add -A` 混入基线——必须加入 `.gitignore`。这是首个「意料之外」的运行时目录。
- **`server/prisma/dev.db`（544KB SQLite 二进制）确认存在**，`.gitignore` 追加 `server/prisma/*.db` + `*.db-journal` 后不再出现于 untracked。
- **远端 xishuhq/master 是 Gitee auto_init 模板 README**（内容与本地 README 完全不同），任意合并方式（rebase / --allow-unrelated-histories）都会触发 README 冲突。本地 README 含真实目录结构说明，保留本地版。
- **合并策略选 rebase（线性历史）**：`git rebase xishuhq/master` 把本地 2 个 commit 平移到 b063933 之上，比 merge 产生的分叉线更符合「git log 干净」要求；本地 commit 未推送过，改写无风险。
- **根目录散落 PNG 归置到 `.omo/evidence/root-screenshots/`** 并用 `.omo/evidence/**/*.png` 忽略：`**` 必须覆盖二级目录（`*` 不匹配 `/`），否则 root-screenshots 下 PNG 会漏网重新出现在 untracked。
- **已跟踪文件仅 5 个**（.gitignore / README.md / .omo 下 3 个 md/txt），.omo 下其余产物（boulder.json / plans / drafts / notepads）随基线首次提交。
- **追加 findings 必须在 commit 之前**：learnings.md 本身会随 `git add -A` 进基线，若 commit 后再追加会产生二次未提交变更，违反「一需求一 commit」规范。
