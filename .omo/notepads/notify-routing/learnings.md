
## plan prompt-vs-permission fix (2026-09-17)
- Allowlist: `vteam-plan` toolAllows += `vteam_notify_agent` + `vteam_memory_search`
  (after `vteam_group_post`, before `browser`) in BOTH `agent.constants.ts:500-509`
  and `seed.ts:338-350`; `sed` range-diff empty (`PLAN_BLOCKS_IDENTICAL`).
  No `vteam_submit_artifact`; librarian untouched (防环 deny intentional).
- Artifact filter: `blocks.push(ARTIFACT_SUBMISSION_INSTRUCTION)` → guarded by
  `if (!isPlanRole(effectiveRole))` (same `effectiveRole` as memory filter);
  non-plan bytes unchanged. Stale comments ("无 memory_save/search" ×3) narrowed
  to "无 memory_save"/"无 vteam_memory_save" since search is now allowed; MEMORY
  filter stays (save still denied — teaching save would 403).
- NON_MAIN note appended: `定向通知仅可直达主Agent，需触达其他成员时请主Agent中转，`
  `成员间直连调用将被拒绝。` Old substring kept (spec :1705 intact). MAIN path untouched.
- Spec churn: constants exact-value + matrix +1 (also locks librarian no-notify) +
  dispatcher plan-aware (role + agentRole paths) + NON_MAIN new sentences +
  custom-agents snap `jest -u` (diff audited: only plan deny→allow ×2).
  Fixture note: dispatcher `agent` fixture is product (non-plan) so :1647/:6487
  kept passing; only plan-role sites (:1404/:491 dispatch test) needed flips.
- Live: baked rebuild `docker compose up -d --build server` (init auto re-seeds);
  `GET /agent-policies` plan tools ✓; baked-dist `buildSystemInstructions`
  plan-vs-product byte proof ✓; worker `roles.json` was STALE (mtime 00:15) —
  refreshed via `docker compose restart worker` (startup `injectAll()` live pull),
  verified new allows. Re-seed idempotent (policies bytes identical).
  Evidence: `.omo/evidence/notify-routing/{plan-permission-fix.md,agent-policies.json,prompt-proof.txt,roles.json}`
  (dir shared with sibling: their `live-proof.*`/`jest-baseline.log` untouched).
- Suite: baseline 123/2842 green → final 121/123 (mine: all green incl. updated
  snap; 2 red = sibling in-flight platform-mcp notify-routing:
  `team.findUnique` mock gap, disjoint files, not touched). tsc exit 0 both ends.
- Tree dirty-but-intact, no commit/stash; no DB probes created (read-only proofs).

## notify_agent 主 Agent 路由门 + worker gated 名单补齐 (2026-09-17, server-side worker)
- 服务端门位置 (`server/src/platform-mcp/platform-mcp.service.ts`, `notifyAgent` 内目标存在性校验之后、
  `message.create` 之前): self-notify 先判 (`selfInstanceId === targetInstanceId` → 403) 再读
  `team.mainAgentMemberId`; 主为空 → fail-open + warn; 调用方非主且目标非主 → 403。
  身份用 `exec.callerId` (resolveExecContext 已防冒充), 对齐 `hook_cancel` (:761-781)。
  `task.mainAgentInstanceId` 绝不读 (schema.prisma:183 已停写)。
- 新码 `PLATFORM_MCP_ERRORS.NOTIFY_ROUTING_VIOLATION`; controller 403 → JSON-RPC `-32003`,
  message 形如 `[403] PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION <中文指引>`。
- tools/list 照例剥离 zod `.describe` (全字段裸类型, 既有约定) → 字段级描述改只在源码层可验;
  工具级 description 带路由规则, live `tools/list` 已证 `DESC_ROUTING=True`。
- MCP live recipe: `POST /api/v1/platform-mcp` + `x-worker-id` + `X-Worker-Token: compose-worker-token`
  (缺 token 直接 `WORKER_TOKEN_INVALID`)。
- 探针身份: tm_0000000001 (主=tmm_0000000002/PM) + w_compose_worker 会话;
  null-main 团队 tm_0000000007 单成员 → 自插 `team_members` + `sessions` (updated_at 必填, 无缺省)
  双行才走到 fail-open。C 探针回 `triggered:true` (无 403, 行落库) — fail-open 实锤。
- dispatch 副作用: 向无会话目标派发会自动建 session + `task_group_instances` 行 + 目标 turn 回复;
  清理顺序 messages → events → task_group_instances → sessions → team_members
  (两次 FK 1451 即此链)。B 探针 wake 让 tester 跑 10min+ 长 turn; `message_receipts` 零残留;
  `session_idle_scan` cancelled 行按惯例属合法系统数据未删; 他团队行一律未碰。
  终态: markers/sess/member/tgi 全 0, c_0000000001=62 回基线, c_0000000015=0, tm_7 成员回 1。
- 6 个 spec 调 fixture (调用方即主缺省, 断言等价或更强 + 5 新路由用例):
  service.spec (新增`主 Agent 路由门` describe×5: 主→员/员→主放行、员→员 403 且三不调用、
  self 403、null 主 fail-open+warn) / gate / review-dispatch / review-round-open /
  receipt-nudge / plan-hash (后五者仅加 team.findUnique 缺省)。
  教训: 以 `grep -rln "notifyAgent(ctx"` 为准找全调用 spec, 勿凭文件名判断
  (receipt-nudge/plan-hash 初版漏网, 全量跑才暴露)。
- worker 4 文件: policy.ts + role-guard-plugin.ts 手工快照 += `vteam_plan_complete`;
  policy.spec (6→7) + plugin.spec parity 矩阵加一行。
- worker 全量 25/26 (v1-driver.spec 2 败系环境: 真机 opencode 多报 7 个模型; 零 import role-guard,
  无因果)。server 全量基线 123/2842 → 终态 **123/2848 全绿**; 双端 tsc 0。
- 残留缺口: 主为 NULL 的团队 fail-open (tm_0000000007/8/9), warn 可观测, 属决策内缺口。
- 证据: `.omo/evidence/notify-routing/` 下 `jest-baseline.log`/`jest-after.log`/
  `live-proof.sh`/`live-proof-transcript.txt` (sibling 的 plan-permission-fix 文件互未覆盖)。
