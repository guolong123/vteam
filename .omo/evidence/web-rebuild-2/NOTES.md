# web-rebuild-2 取证记录（2026-09-08 ~09:20 CST）

## A. Commits（branch `main`）
- `eb0baa0` refactor(session)!: unify on team sessions（170 files, SU todos 1-15 + RPD todos 1-12）
- `5e07244` fix(chat): dm streaming, history, tab status, group-send follow-ups（session page 246-line diff：loading canonical/agentKeysFor/stale兜底/unread红点 + SU订阅 + RPD入口）
- `9e743d0` chore: stash foreign session work（chat-followups draft + 4 ops scratch files）
- 未提交残留：仅 untracked evidence/sql 目录（compose-deploy, deploy-su-clean, dm-*, group-send-fixes, loading-stuck-fix, remove-project-dimension, session-unification/final-F3 + su6 sql）——符合任务允许范围。

## B. Web rebuild（仅 web，未碰 db/server/worker）
- `docker compose up -d --build web` EXIT 0（见 rebuild.log）
- 镜像：`aiagents-web:latest 5ff199c05bec（08:12）` → `73dd8b727bdc（08:57:00 +0800）`
- 健康：web Up (healthy)，`:13001 → 200`，`:13000 /api/v1/health → {"status":"ok"}`（见 health.txt）
- db/server/worker 未重启（uptime 连续：db 44min / server 18min / worker 43min）

## C. Bundle 新鲜度（stale 排除）
- 服务端 chunk 含 `dm-tab-spin`：`/_next/static/chunks/app/(main)/teams/%5Bid%5D/session/page-0a58d5732c3dd5b0.js` → 旧包猜测排除，新 spinner 代码已上线。

## D. Live proof（:13001，seed-admin 登录 → /teams/tm_0000000001/session）
- `01-spinner-live.png`：他人 P0 回归运行中 live 状态（成员卡“工作中”＋“测试-1 会话运行中…”＋右侧队首执行中）。
- 本人触发 3 次 DM dispatch（架构师-1 私聊 c_0000000007，POST 均 201）→ 全部完成全周期（agent 回复 m_0000000108/0115/0120 落库并渲染，DB senderInstanceId=tmm_0000000003）。
- `02-dm-tab-unread-live.png`：DM tab strip 三个红点（dm-tab-unread-tmm_0000000001/2/3）＋群聊 P0 流量 —— DM tab 状态机制在新包 live。
- Console：仅已知 `/api/v1/plans?taskId=t_xxx → 404` 探针噪音（P0 消息中已声明可忽略）＋无害 GL glScissor warning；无其他 error。

## E. Spinner 截图未捕获 —— 诚实诊断（非 bundle 问题）
- 三次实测：user POST → agent 首回复均为 **~3s**（01:04:25→:28；01:06:35→:38；01:07:46→:49，会话复用快路径）。
- 150ms in-page Mutation 轮询 30s（send 后同 roundtrip，run_code_unsafe）零命中一次 —— 说明该次要么排队超 30s（当时 worker 正处 P0-12/P1 风暴，01:12–01:13 群内 8 条 agent 消息/90s），要么窗口仅 ~3s 且 dispatch 延迟到 poll 之后。
- 代码审计结论（logic 侧可信）：dispatcher 在 dispatch 同步 broadcast `AGENT_LOADING{instanceId: teamMemberId(tmm_), agentId, phase}`（worker-dispatcher.ts:1419/1560，team scope）；页面 `onAgentLoading` 以 `instanceId ?? agentId` 入 `loadingByAgent`；`isTabLoading` 查 `instKey(tmm_)/m.id/tmmAlias` 三路 —— 与 DB 实测 `senderInstanceId=tmm_0000000003` 同域，匹配成立。附带机制（红点/会话运行中/成员卡）全部 live 目击。
- 结论：stale-bundle 排除；spinner 逻辑链完整；缺的是“长 thinking 窗口 ＋ 轮询命中”—— 复用会话 3s 窗口＋MCP 数秒 roundtrip 使抓拍几乎不可能。复现建议：重置某成员会话后立即 cold-start dispatch（30s+ 窗口），或在页内 observer 命中瞬间由脚本自动截图（本任务未做，保持零产品代码改动）。

## F. Footprint 披露（种子团队 tm_0000000001，P0 进行中时段）
- 本人 user 消息：c_0000000007 DM ×3（m_0000000107/0114/0119）＋ 群 c_0000000001 ×1（m_0000000161，误投：当时 active tab 为群聊）。
- Agent 镜像产物：DM 回复 ×3（DM 内）＋ group_post 工具导致的群聊发言（“在” m_0000000109、建议帖及 P1-11/P1-12 跟进 m_0000000134/0142/…/0158、m_0000000140）—— 可能轻微干扰 P0 断言，已在此记录，请 P0 owner 按需清场（未经其确认未删任何行）。
- 未删/未改任何种子行、未动他人团队、未 down/prune。
