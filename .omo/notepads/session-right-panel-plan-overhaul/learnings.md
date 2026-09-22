# Learnings — session-right-panel-plan-overhaul

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## L1 · 门禁脚本会改写源码：`npm run lint --prefix server` = `eslint --fix`
`server/package.json:15` 的 lint 脚本带 `--fix`。当作"验证门禁"跑它会**自动改写 76 个无关文件**（本会话发生过一次，已 `git checkout -- server/src` 回滚）。
**正确做法**：验证用 `npx eslint "{src,apps,libs,test}/**/*.ts"`（无 `--fix`）；要格式化只对**自己改的文件**跑 `--fix`。

## L2 · 该仓库整体不满足自己的 prettier 配置（预存债）
基线 `b418103` 下 `platform-mcp.tools.ts` 就有 202 个 `prettier/prettier` error，全仓约 817 个。
**正确做法**：用 `git show <base>:<path> | npx eslint --stdin --stdin-filename <path>` 做**基线对比**，只对"我们新增的 error"负责（本次新增 30，已清零）。

## L3 · 容器跑的不是当前代码
`:13000` 的 server 容器是构建期快照（本次旧镜像 10:02，而代码提交在 20:00+）。**任何"真实链路"验证前必须先确认容器镜像是否包含本次改动**：
`docker exec <c> sh -c 'find dist -name "*<新文件>*"'`。
重建：`docker compose build <svc> && docker compose up -d <svc>`（Dockerfile 首行指向私有 registry `docker.ketaops.cc`，偶发 EOF 需重试）。

## L4 · `reject`/`accept` 会出队队首（promoteNextInTx）
在 tm_0000000001 上调 `reject` 会把 `current_task_id` 推到下一个 queued 任务并**删掉其队列行**，且**无法经公开 API 恢复**（enqueue 仅 pending、cancel 仅 queued）。
**真实链路 QA 若需触发 pending_review，务必选一个队列为空/独立的团队**，或事后用 DB 事务精确恢复。

## L5 · playwright 环境
`web/playwright.config.ts` baseURL 硬编码 `:3001`（本地 dev，不自启 webServer）、`channel: chrome`。`pages`/`docs` 项目依赖 `setup`（seed-admin 真实登录 → `.auth/user.json`）。默认 `npm run test:e2e` 只跑 6/22 个 spec，16 个是**孤儿**（不在任何 project 内）。

## L6 · 「保持共享组件不被修改」的约束会把问题挤到外层
计划 T18 写了「只改外层容器布局，保持 `TaskStatusActions` 组件本身不被修改」。执行者照做，在外层套 `grid 1fr1fr`；
但该组件根容器是 `flexDirection:column`（子按钮被 stretch 成全宽），整个竖排块只占第 1 列 → 按钮变成上下堆叠、各占半宽。
**教训**：当视觉目标需要改变子组件内部排布时，"不许动子组件"的约束是错的；正确做法是给共享组件加**可选 prop**（默认值保持既有调用方行为），而不是在外层硬套布局。
