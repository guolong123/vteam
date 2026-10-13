# LEARNINGS

## [LRN-20261009-002] knowledge_gap

**Logged**: 2026-10-09T00:00:00+08:00
**Priority**: high
**Status**: pending
**Area**: config

### Summary
本机 `node`/`npm`/`npx` 不在默认 PATH，需前缀 `$HOME/.nvm/versions/node/v22.15.0/bin`。

### Details
执行 server 侧 prisma/jest/tsc 与 web 侧 build/lint 时，默认 PATH 找不到 node 系列命令（Todo 1 执行中实测，`npx prisma migrate status` 等命令需显式加前缀或先 `export PATH="$HOME/.nvm/versions/node/v22.15.0/bin:$PATH"`）。版本为 v22.15.0（nvm 安装）。

### Suggested Action
所有跑 node 工具链的 shell 命令前先 `export PATH="$HOME/.nvm/versions/node/v22.15.0/bin:$PATH"`，或直接用绝对路径前缀。派发子任务时在 prompt 里带上这条，避免每个任务重复踩坑。

### Metadata
- Source: error
- Related Files: server/package.json, web/package.json
- Tags: node, nvm, path, toolchain
- Recurrence-Count: 1
- First-Seen: 2026-10-09
- Last-Seen: 2026-10-09

---

## [LRN-20261009-001] correction

**Logged**: 2026-10-09T00:00:00+08:00
**Priority**: critical
**Status**: pending
**Area**: infra

### Summary
在本环境（OhMyOpenCode/Sisyphus）中 `tools.task` 实际不会执行任务，派发子代理必须用顶层 `subagent` 工具。

### Details
尝试通过 Code Mode 的 `tools.task({subagent_type: "momus", ...})` 派发 Momus 评审：
1. 前台调用（run_in_background=false）挂死 30 分钟后报 `Poll inactivity timeout`，会话 `ses_...` 随即丢失（session_read 返回 Session not found）；
2. 改后台调用返回了一个看似正常的 `bg_...` 任务 ID，但据用户确认该任务实际并未运行（假任务）。
用户明确纠正："tools.task 实际上并不会跑，要用 subagent 直接派发"。
正确的派发方式是顶层 `subagent` 工具（`subagent(agent=..., description=..., prompt=..., background=true)`），返回真实会话并在完成时收到通知。

### Suggested Action
凡需派发 explore/librarian/momus/oracle 等子代理，一律用顶层 `subagent` 工具；Code Mode `tools.task` 仅在目录中存在，但本环境不执行——不要用它，也不要在 `execute{}` 代码里间接调用它。

### Metadata
- Source: user_feedback
- Related Files: n/a
- Tags: subagent, tools.task, delegation, opencode
- Recurrence-Count: 1
- First-Seen: 2026-10-09
- Last-Seen: 2026-10-09

---
