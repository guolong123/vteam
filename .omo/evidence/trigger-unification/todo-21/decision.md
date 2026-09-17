# todo-21 双写退出决策 — 选 (a)：v1 永久保留内存 veto（已确认不删）

裁决人：计划作者（2026-09-17）。零代码改动：只改计划文档 decision 10 + todo 21 勾选。

## 结论

选 **(a)**。`lastActivityAt` 内存 map（dispatcher `lastActivityAt` + ingress `sessionActivity`）
永久保留为 veto/计时器，DB 列仍是 source of truth（双写不删任何 map）。

## 证据（(b) 的两个前件皆不成立）

1. **发布周期数为零**（`git-log.txt` 收据）：
   - `git tag` 输出为空 → 从未发布任何版本。
   - `git log --oneline -3 -- .omo/plans/trigger-unification.md` 输出为空 → 计划文件本身从未提交。
   - `git status -sb` → `## feat/docs-artifacts-merge` 单分支 + 全树未提交 WIP（含 todo 1 的 eager ticker）。
   - 「1 个发布周期 = todo 1 独立上线后的下一个版本」→ todo 1 尚未独立上线，分母不存在，(b) 的时间前件无法满足。诚实结论：不能宣称周期已走完。
2. **分叉遥测不存在**：`分叉|diverg` 全库 grep 仅命中 `tasks.controller.ts:440` /
   `plan-lifecycle.service.ts:74` 的 plan-file 展示提示，无任何 `sessionActivity`
   内存↔DB 分叉告警机制 → (b) 的质量前件无从验证。
3. 若将来重提退役，必须先补分叉遥测 + 走完一个发布周期，另开新 todo（已写入 decision 10）。

## veto 存续确认（F2 约束）

- `worker-dispatcher.ts:1069` `pendingBySession`、`1090` `activeExecutions` 均存在且被
  `scanIdleSessions`（`pendingBySession` 否决 DB 行）/`markSessionIdleDead`
 （`isAgentExecuting` 只读否决）实际引用；`isAgentExecuting`（1144-1155）本体语义未动
  （缺记录/TTL 过期 → null，否则返回集合），仍是纯内存快路径，未 DB 化。
- `worker-event.ingress.ts:205` `sessionActivity` + `241` `touchSessionActivity`
  双写（map + `persistSessionActivity` fail-open）原样保留。
- 本 todo 未删除/改动任何生产代码（`git status` 新增项仅计划文档 + 证据目录）。

## 验证

- `npx tsc --noEmit` exit 0（`tsc-final.txt`，终局树实测；注：中途一次 exit 2 系 sibling
  todo-20 在飞 `hook.service.ts` 半写状态，属已知并发 transient，其落地后重跑即 0）。
- 针对性：`worker-dispatcher.spec.ts` + `worker-event.ingress.spec.ts` 297/297
 （含 todo-7「内存 Map 为空但 DB 有 stale running 行」DB-alone 判死用例 → DB 仍是 source of truth，
  stale_state 探针成立；`isAgentExecuting`/`assertWorkerTask` 相关用例全绿 → 语义零漂移）。
- 全量：123 suites / 2822 tests 全绿，与基线逐字一致，零回归（`jest-after.txt`）。
  已知 flake（`platform-mcp.controller.spec.ts skill_create` Parse Error）本轮未出现。
- dirty_worktree：未 revert/stash/commit；禁区 `server/src/triggers/**`、`event.constants.ts` 零触碰。
