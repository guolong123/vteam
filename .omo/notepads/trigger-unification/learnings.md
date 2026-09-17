# Learnings — trigger-unification

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## todo-14: /system landing + nav browser proof (2026-09-17)
- Landed state confirmed on disk before touching anything: `nav-dock.tsx` NAV_ITEMS 8 entries ending `{ key: "system", label: "系统管理", icon: "⛭" }`; `app-shell.tsx` KEY_TO_PATH/CMDK_NAV_PATH/PAGE_TITLE have `system`, NAV_VISIBLE `system: isPlatformAdmin`, ROUTE_GUARD keeps legacy users/roles/memories. Did NOT re-edit registries.
- Created ONLY `web/app/(main)/system/page.tsx` (thin placeholder, copied `models/page.tsx` shell shape: `"use client"`, root `flex:1` + tokens, T15 no fixed/100vh). testids: `system-manage-root` / `system-manage-title` / `system-manage-hint`.
- Rebuild command: `docker compose up -d --build web` from repo root, then waited for `aiagents-compose-web` healthy + `curl localhost:13001/login` = 200, hard-reload in browser before asserting (stale_state probe).
- Exact selectors used (Playwright MCP): `[data-testid="rail-icon"]` + `data-nav`/`aria-label` attrs (collapsed rail), `[data-testid="nav-item"]` (expanded panel, CSS `:hover` on `[data-testid="rail-bar"]` + 600ms wait opens it), `[data-testid="nav-item"][data-nav="system"]` click → `/system`, `[data-testid="rail-icon"][data-active="true"]` highlight check, `[data-testid="cmdk-trigger"]` → `[data-testid="cmdk-item"] span.navcmdk-item-label` for nav-group labels, `cmdk-search input` fill for search probe.
- Admin (`admin`/`admin123`) dock+cmdk = 8 entries ending 系统管理, zero trace of 用户管理/角色权限/记忆管理; member (`seed-member`/`Admin@123456`) dock+cmdk = 7 entries, no `system`; member GET `/system` → ROUTE_GUARD redirects to `/teams`.
- e2e harness note: `playwright.config.ts` baseURL is `localhost:3001` (dev server, NOT compose :13001). Local dev needs `API_PROXY_TARGET=http://localhost:13000 npm run dev -- --port 3001` (middleware default `localhost:3000` is dead → login POST 404s otherwise). Ran `npx playwright test --project=pages e2e/pages.spec.ts`: **14 passed / 3 failed**.
- Verbatim e2e assertions todo 17 must update (`web/e2e/pages.spec.ts`, test "8-10/17 导航变体"):
  - L187 `// 报告中的具体回归点：搜「记忆」必须命中「记忆管理」`
  - L188 `await page.getByTestId("cmdk-search").locator("input").fill("记忆");`
  - L189 `await expect(page.getByTestId("cmdk-item").first()).toBeVisible();`
  - L190 `await expect(page.getByTestId("cmdk-item").first()).toContainText("记忆管理");`
  - Live probe confirms: filling 记忆 now yields 0 cmdk-items (expected fallout of removing `memories` from NAV_ITEMS). L171 comment mentioning 记忆管理 is comment-only.
- `web/e2e/reference/testids.ts` nav-reference check: L23/261/276 are generic `"rail-icon"` entries (no label coupling, no update needed); L369 documents `/users` route entry which stays valid until todo 17 moves pages. No hardcoded 用户管理/角色权限/记忆管理 nav labels anywhere in testids.ts.
- The other 2 e2e failures are PRE-EXISTING, unrelated to todo 14: `team-session zero-task` L139 `team-right-empty` + `skills` L211 `search-input` — both testids have ZERO matches in `web/src` (grep verified), i.e. source drift from other WIP; my change only ADDS `web/app/(main)/system/page.tsx`.
- `cd web && npx tsc --noEmit` exit 0; `npm run build` exit 0 with `○ /system` in route table. Did NOT touch `web/e2e/**`; did NOT delete users/roles/memories pages; tree left dirty-but-intact.

## todo-1: eager ticker restart proof (2026-09-17)
- Working DB invocation (MySQL not host-mapped; compose default creds, root .env has no MYSQL_ROOT_PASSWORD override):
  `docker compose exec -T db mysql -uroot -paiagents-root aiagents -e "SQL"`
  (compose `DATABASE_URL` = `mysql://root:${MYSQL_ROOT_PASSWORD:-aiagents-root}@db:3306/aiagents`; grep `server/.env` is stale placeholder — trust `docker-compose.yml` + live `docker compose exec -T server env`.)
- Observed tick latency: row `tmr_qatodo1` (fire_at 01:51:05, restart 01:53:05Z) was `fired`, attempts=1, last_error=NULL by 01:55:14Z — i.e. picked up within ~2 ticks of the 30s default interval (container took ~1min to rebuild+start; first 30s tick after Nest ready claimed it). `receipt_nudge` handler no-op'd cleanly on `{}` payload.
- Module-init ordering note: ticker now starts in `TimerService.onModuleInit` via `ensureTicker()`, but `receipt_nudge` / `review_round_timeout` handlers register in their own modules' `onModuleInit` — Nest does not guarantee order across modules. An overdue row whose `kind` has no handler yet is claimed then marked `failed` with `lastError='no handler for kind ...'` (loud, not silent) — accepted behaviour for todo-1; a later retry/backoff policy (if wanted) belongs to a future todo, not this one.
- Spec pattern that worked: `TIMER_SCAN_INTERVAL_MS` is read lazily by `scanIntervalMs()`, so per-test `process.env` reassignment works despite the file-top `='0'`; `resyncIdPrefix` issues its own `findMany({where:{id:{startsWith:'tmr_'}}})` — mock `findMany` must dispatch on `args.where.id.startsWith` vs `args.where.status` or `onModuleInit` tests see phantom due rows.

## Todo 15 — /system 二级导航壳 (2026-09-17)

### 从 Dock 逐字复用的 CSS 值 (nav-dock.tsx → system-sidebar.tsx, class 前缀 sysnav-)
- 选中: `background: rgba(13,148,136,.1); color: #0F766E(#0F766E); font-weight: 600`
  (Dock 常量 NAV_ACTIVE=#0D9488 / NAV_ACTIVE_DEEP=#0F766E, 本文件同名同值)
- 指示条: `width: 3px; height: 18px; border-radius: pill(999); background: #0D9488`,
  `position: absolute; left: 0; top: 50%; translateY(-50%)` (Dock 版 left:-8px 相对 rail 图标, 侧栏版改为 left:0 贴项左缘)
- hover: `background: rgba(15,23,42,.05); color: neutral[900]`; 图标 `opacity .9→1` 规则同 Dock
- dark: `.dark .sysnav-item:hover { background: rgba(255,255,255,.06); }` (verbatim, 仅改前缀)
- 行高: Dock 式 `padding: 8px 10px` + `min-height: 36px` (fontSize.md=13px, fontFamily.body, gap 2px, radius.md=10px); 容器 `width: 208px` 精确值, `bg surface / border-right border`

### 断点行为 (实测, @media max-width:1023px)
- 768px 硬重载后: sidebar 变 688×53 顶部横行 (4 项同 y=68, x=92/187/295/403), section label 隐藏,
  指示条转底部 (18×3px 居中), `.syslayout-wrap` 切 column, content 全宽 688×787 无挤压裁剪
- 1280px: sidebar 208×840 左侧常驻; 临界即 1024px (≥1024 侧栏, ≤1023 pill 行)

### 新增 selectors (data-testid / data-*)
- `system-sidebar` (aside) / `system-sidebar-label` / `system-sidebar-item` ×4
  (`data-nav`=triggers|users|roles|memories, `data-active` 由 usePathname 派生, 前缀匹配 `href` 或 `href/`)
- `system-section` (分栏壳) / `system-content` / `system-breadcrumb` (+ `system-breadcrumb-current`)
- 导出供复用: `SYSTEM_NAV_ITEMS`, `SYSTEM_SIDEBAR_WIDTH=208`, `systemActiveKey()`, `systemCrumbLabel()`
  (注意: Next layout 文件禁止具名导出 — crumb helper 必须放 system-sidebar.tsx, layout 只留 default)

### 陷阱
- /system/triggers 等子路由在 todo16/17 落地前是硬 404 (segment layout 不渲染); QA 选中态时用过
  临时 scaffold (`system/triggers/page.tsx`, 截图后已删, 最终树无残留, 删后需 `rm -rf web/.next` 否则
  tsc 报 stale `.next/types/validator.ts` 找不到已删模块)
- /system 本体 (todo14 占位页) 无激活项、面包屑仅"系统管理" — by design, 非 bug

## todo-17: users/roles/memories → /system/* 搬迁 + 旧路径重定向 (2026-09-17)
- 搬迁方式: `mkdir -p system/{users,roles,memories}` 后 `git mv` 三页 (git 记为 R 重命名, 内容逐字节保留)。
  三页 import 全是 `@/` 别名 (grep `from ".'` 零命中), 搬迁零改写 — 已验证非假设。
- 重定向: 照抄 `providers/page.tsx` 模式 — 旧目录各留一个 `redirect("/system/*")` 瘦页
  (server component, 无 "use client")。未建 `next.config.ts` redirects 块。
  build 后路由表自证: `/system/{users,roles,memories}` 为全量页 (5-10kB),
  `/users` `/roles` `/memories` 为 138B stub (与 `/providers` 同尺寸, 同为重定向页)。
- `system-sidebar` 前缀匹配零改动生效: 实测 `/system/users|roles|memories` 各自
  `data-active="true"` + 面包屑 `系统管理 › 用户管理/角色权限/记忆管理`。
- e2e (`pages.spec.ts`, dev :3001): 修改前 14 passed / 3 failed → 修改后 **15 passed / 2 failed**。
  修好的 1 个 = 8-10/17 导航断言 (搜「记忆」命中「记忆管理」已按 todo-14 意图改写为:
  导航组 8 项且以「系统管理」收尾 + 搜「系统」命中「系统管理」+ 搜「记忆」无「记忆管理」项;
  11/17 与 15/17 追加 `toHaveURL(/\/system\/(roles|users)/)` 即旧路径即重定向覆盖)。
  剩下 2 个为不相关的预存失败, 未动: zero-task `team-right-empty` (L139),
  skills `search-input` (L222, 该 testid 在 `web/src` 零命中, 源码漂移)。
- `testids.ts` 路由清单同步: `/roles`→`/system/roles`, `/users`→`/system/users`
  (PAGE_SMOKE 键同改; guard.spec.ts 的 `/roles` `/users` 未动 — 服务端 redirect 先于
  客户端守卫触发, 最终仍落 `/login`, 本次未跑 guard 项目, todo-18 顺手可验)。
- `tsc --noEmit` exit 0 (搬迁前先 `rm -rf web/.next`); `npm run build` exit 0。
- 浏览器证据: `.omo/evidence/trigger-unification/todo-17/` 6 张
  (`{users,roles,memories}-page.png` + `{users,roles,memories}-redirect-landing.png`);
  旧 URL 断言的是最终 URL (防 misleading 200)。
- 附带: 本地 dev 仍跑在 :3001 (`API_PROXY_TARGET=http://localhost:13000 npm run dev -- --port 3001`),
  compose :13001 镜像是旧的 (未重 build, 无需)。

## todo-2: timers → triggers 单表改名 + TriggerService 三形态 (2026-09-17)
- 迁移命令 (server 容器是 baked 镜像、无 bind mount, 故先 docker cp 再 deploy):
  `docker cp server/prisma/migrations/20260919000001_rename_timers_to_triggers aiagents-compose-server:/app/prisma/migrations/20260919000001_rename_timers_to_triggers`
  `docker compose exec -T server sh -c "cd /app && npx prisma migrate deploy"`
  → `Applying migration 20260919000001_rename_timers_to_triggers … All migrations have been successfully applied.`
  事后 `migrate status` = `Database schema is up to date!` (54 migrations)。
- 改名/回填序列 (全部同 migration.sql, additive only, fire_at 未删):
  `ALTER TABLE timers RENAME TO triggers` → 12 个 `ADD COLUMN`
  (due_at/scope_type/scope_id/owner_instance_id/interval_ms/next_fire_at/guard_key/skip_reason 可空;
  fire_count/busy_retries `INTEGER NOT NULL DEFAULT 0`; max_fires/expires_at 可空)
  → `UPDATE triggers SET due_at = fire_at WHERE due_at IS NULL`
  → `CREATE INDEX idx_triggers_status_due_at ON triggers(status, due_at)` (旧 idx_timers_status_fire_at 随改名保留)。
- 实测行数与任务描述不符: live 库 timers 表是 **19 行** (非 2 行), 全部 receipt_nudge;
  迁移后 `COUNT(*)=19`, `due_at IS NULL`=0, `due_at<>fire_at`=0 (逐行 due_at=fire_at, 证据 db-before/after.txt)。
- 读路径 Oracle 安全项写法: Prisma `dueAt: { not: null, lte: now }` (+ `orderBy dueAt + take 100`);
  claim 侧同形。写侧 schedule 双写 fireAt+dueAt。
- 改名兼容垫片 (零消费者改动, 无 shim 文件需改 importer):
  `trigger.service.ts` 新文件放 TriggerService; `timer.service.ts` 只剩 `export * from './trigger.service'`;
  `export type TimerService = TriggerService` + `export const TimerService = TriggerService`
  (同引用 → `@Inject(TimerService)` token 一致, timers.module 只需 providers/exports TriggerService)。
  唯一被迫碰消费者的点: TriggerFireContext 新增可选 `dueAt?/fireCount?`
  (可选而非必填, 否则 receipt-nudge/review-round-timeout spec 的 `{id,kind,payload}` 字面量编译不过;
  基座永远填充, todo-5/6 迁移消费者时再收紧)。
- schedule 白名单是破坏点: spec 里 `schedule('test_kind',…)` 全部改为 `'receipt_nudge'`
  (fire 路径不校验 kind, 故 fireDue 旧测试 keeping 'test_kind' + registerHandler 配对不动)。
  spec mock 技巧: makePrisma 建一份 delegate 同时挂 `timer`/`trigger` 两键 (同引用),
  旧 `prisma.timer.*` 断言零改; 只改了 query 形状断言 (dueAt+take) 与 fired 终态 (+fireCount)。
- TS 坑: `if ('expire' in outcome)` 在 `void | TriggerOutcome` 上直接编译不过
  (`in` 需 object) → 抽 `isExpireOutcome/isRescheduleOutcome` 先 `typeof === 'object'` 收窄。
- Live 端到端: 插 `tmr_probe_todo2` (pending, due_at=NOW) → ~50s 后 `fired, fire_count=1, attempts=1, lastError=NULL`
  → 已 DELETE, 表回 19 行。随后 `docker compose up -d --build server` (旧 baked 码查 timers 表,
  改名后必须重 build; server /health ok, Up healthy)。
- 全套件: 基线 117 suites/2664 tests 全绿 → 终态 **118/2674 全绿** (+8 trigger 新行为测试 +2 constants;
  dedup 逐字节断言在 trigger.constants.spec.ts)。
  插曲: 终态首轮 1 个失败 (`platform-mcp.controller.spec.ts skill_create` 报 `Parse Error: Expected HTTP/` —
  与本次 diff 无关的 supertest 瞬态, 单跑 27/27 过, 全量重跑即 118 全绿)。
- 证据: `.omo/evidence/trigger-unification/todo-2/`
  (migration.sql/db-before.txt/db-after.txt/db-index.txt/jest-baseline.log/jest-after.log/tsc-after.txt)。
- tmr_ 前缀冻结: TRIGGER_ID_PREFIX='tmr', resync 走 `prisma.trigger`; 未动 resyncIdPrefix, 未引 trg_。

## todo-4: 白名单补全 + outcome 归一 + shim 退役 (2026-09-17)
- 最终白名单 (6 kind, `server/src/common/constants/trigger.constants.ts`):
  `receipt_nudge` / `review_round_timeout` / `progression_patrol` /
  `session_idle_scan` / `hook_fire` / `hook_poll` (后四者 todo-8/9/11 消费, 先声明防 churn)。
  头注释已更新 (todo-2 的"handler 接线归 todo-4"即本 todo)。
- outcome 归一结论 (verified, 非假设): `fireOne` 内 `outcome = await handler(ctx)`
  (`trigger.service.ts:408-410`) → `isExpireOutcome` (:421) / `isRescheduleOutcome`
  (:432) 皆先 `typeof === 'object'` 收窄 → void (undefined) 落透所有分支, one-shot
  在 :484-491 落 `fired`, interval 行在 :447-483 按 now 重算回 pending。
  即 **void ≡ {done:true} ≡ fired** (one-shot)。显式 spec 锁定
  (`trigger.service.spec.ts` 三形态 describe 新增 3 用例):
  `handler 返回 void → 视为 done 落 fired` / `handler {done:true} → fired` /
  `逾期 one-shot 只触发一次 (dueAt 远过去 → fired, data.dueAt/nextFireAt 皆 undefined, 不追补)`。
- 基座强制已覆盖 (既有 + 新增, 共 8 强制/语义用例): maxFires claim 前 cancelled
  (handler 未调用, updateMany 未调用) / expiresAt claim 前 cancelled /
  rescheduleAt 过去钳制 now+jitter(0..30s) / interval `now + intervalMs + jitter` /
  guard false 留 pending + skipReason / 未知 kind schedule 抛错不落库 /
  未注册 guardKey schedule 抛错。
- fire 路径不校验白名单是故意的 (stale 兼容): `dueRow` kind=`'test_kind'`
  (白名单外) + `registerHandler('test_kind')` 照常 fired —— 所有 fireDue 旧用例即证明;
  `registerHandler` 对白名单外 kind 运行期仍允许 (`trigger.service.ts:147-149`
  注释明示), 未知 kind 无 handler 时 fireOne 落 `failed` + `no handler for kind` 大声暴露。
  schedule 入口仍是唯一白名单强制门 (未知 kind → loud throw)。
- shim 已退役 (非 defer): 8 处 importer 全是单行 import 路径机械改写
  (`../timers/timer.service` → `../timers/trigger.service`,
  spec 内 `./timer.service` → `./trigger.service`), DI token 零风险——
  `TimerService`/`TimerFireContext` 等别名仍在 `trigger.service.ts:599-614`
  以 doc-commented `@deprecated` 形式保留 (同引用, token 一致)。
  改动文件: chat/{receipt-nudge.handler,review-round-timeout.handler}.ts,
  platform-mcp.service.ts, 上述 4 个对应 spec, timers/trigger.service.spec.ts
  (由 timer.service.spec.ts `mv` 改名); `rm server/src/timers/timer.service.ts`;
  `timers/` 目录名/`tmr_` 前缀/DB 表均未动; `timers.module.ts` 未动
  (todo-2 已直连 trigger.service)。grep 证无残留:
  `timers/timer.service|from './timer.service'` 在 server/src 零命中。
- 消费者未迁移 (todo-5/6 范围): receipt-nudge / review-round-timeout 两 handler
  仍 `Promise<void>` + `TimerFireContext` 别名, 仅 import 路径改变, 编译与行为不变。
- 全套件: 基线 **118/2674 全绿** → 终态 **118/2677 全绿** (+3 outcome 新用例, 零回归;
  本轮无 supertest 瞬态)。`npx tsc --noEmit` exit 0 (基线/终态皆 0)。
- 证据: `.omo/evidence/trigger-unification/todo-4/`
  (tsc-baseline.txt/tsc-after.txt/importers-before.txt/importers-after.txt/jest-after.txt)。
- 工作树保持 dirty-but-intact (68 条 status, 均为先前计划残留 + 本 todo 改动, 未 commit/stash)。

## todo-7: Session.lastActivityAt 双写 + DB 侧空闲检出 (2026-09-17)
- 双写站点 (3 处, 内存 map 全保留, veto 语义不变):
  - `worker-event.ingress.ts:241 touchSessionActivity` → map + `void persistSessionActivity` (`session.update({lastActivityAt:new Date()})`, catch→warn, 永不抛, controller 恒 202)。
  - `worker-dispatcher.ts:startPendingWatchdog` (~3593 map set 后) → `void persistSessionActivity` (同形 helper, dispatcher 私有)。
  - `worker-dispatcher.ts:handleSessionActivity` (~3618 刷新分支) → 同上; 终态分支 (completed/非 running) 只删 map, 不写 DB (status 过滤已够)。
- 检出与否决 (`scanIdleSessions` ~3642): 内存环不变 → 新增 `findMany({where:{status:'running',lastActivityAt:{lt:cutoff}},take:100})`,
  去重 + `pendingBySession` 否决后并入同一 `markSessionIdleDead` 链; DB 异常 catch→warn, fail-open。
  `markSessionIdleDead` 首部加 activeExecutions 只读否决 (`isAgentExecuting(workerId,team:teamId)?.has(teamMemberId)` → warn + return,
  不删追踪, TTL 30min 后否决自动失效)。`isAgentExecuting` 本体零改动。
- 重启安全要求扫描常驻: 构造末尾 `this.startIdleScan()` (原来只靠 watchdog 惰性启动, 重启零 dispatch 则永不 tick)。
  `startIdleScan` 注释由"惰性"改为"常驻 + 惰性兜底"; `onModuleDestroy` 清理不变。
- env 注入死胡同 (实测结论): compose 置 `AGENT_IDLE_TIMEOUT_MS: "0"`, 但 `ConfigModule.forRoot({isGlobal:true})`
  无 validation/coerce, `config.get` 返回 string → dispatcher `typeof === 'number'` 恒 false → compose 下恒为默认 30min。
  即数字 env 旋钮在 compose 生效不了 (pre-existing, 不在本 todo 修)。e2e 证明改用 40min-stale 行 + 默认 30min 阈值。
- Live 证明 (server 重 build 含本 todo 代码, 新进程 maps 为空):
  - 插 `s_probe_todo7_stale` (running, activity=NOW-40min) + `s_probe_todo7_dual` (running, activity=NULL)。
  - `POST /api/v1/worker/events` (X-Worker-Token=compose-worker-token) `session.updated{sessionId:s_probe_todo7_dual,status:running}` → 202,
    dual 行 `last_activity_at` NULL→`02:33:03` (双写实锤)。
  - ~45s 后 (60s tick 内): stale 行 running→failed (`updated_at 02:33:48`), dual 行仍 running (新鲜不误杀),
    `status='running' AND last_activity_at < now-30min` COUNT=0。
  - 清理: `DELETE ... WHERE id IN (both)` → `probe_remaining=0` (收据 db-cleanup.txt)。
- Spec 诚实改动 (行为变了, 断言跟着变, 非回归): dispatcher mock 加 `session.findMany=[]`;
  `不判死` 用例的 `update not.toHaveBeenCalled` 改为只过滤 `data.status==='failed'`;
  ingress mock 加 `session.update`, 新增 fail-open 用例 (reject→仍 true + 内存计时在);
  dispatcher 新增 `todo-7 双写 + DB 侧空闲检出` describe ×6 (双写×2/DB 检出判死/pending 否决/active 否决/findMany fail-open)。
- 基线 vs 终态: 基线 tsc exit 2 (sibling todo-5/6 在飞: platform-mcp.service TimerService/dedupKey) + jest 117/118 suites·2675/2677
  (review-round-timeout.spec 2 败, 同属 sibling) → 终态 (sibling 落地后) **tsc exit 0, 120/120 suites·2708/2708 全绿**
  (suite 数涨是 sibling 新 triggers controller/service spec; triggers.controller.spec 在全量跑中有一次孤立 FAIL,
  单跑即过, 属已知 supertest/顺序 flake 家族, 重跑即 120 全绿)。`isAgentExecuting` 相关 platform-mcp 3 specs 261/261 过, 零改动。
- 证据: `.omo/evidence/trigger-unification/todo-7/`
  (tsc-baseline.txt/tsc-after.txt/jest-after.txt/db-probe-insert.txt/db-dual-write.txt/db-reap.txt/db-cleanup.txt/db-show-columns.txt)。
- 迁移: `20260919000002_session_last_activity_at` (`ADD COLUMN last_activity_at DATETIME(3) NULL` +
  `CREATE INDEX idx_sessions_status_last_activity(status,last_activity_at)`); 烘焙镜像 recipe
  (`docker cp` + `migrate deploy`) 一次过。本地 `npx prisma generate` 罢工 (报 envelope `No command registered`),
  改走 `./node_modules/.bin/prisma generate` 即好 (npx 解析问题, 非 prisma 版本问题)。
- 工作树 dirty-but-intact (77 条, 含 sibling 持续 WIP), 未 commit/stash; 禁区文件
  (receipt-nudge/review-round-timeout/platform-mcp.service) 零触碰。

## todo-5/6: receipt_nudge + review_round_timeout → TriggerOutcome 迁移 (2026-09-17, 同 worker 一次做完)
- 改动 4 文件, 语义逐字保留 (MIGRATION 非 refactor):
  `chat/receipt-nudge.handler.ts` / `chat/review-round-timeout.handler.ts`
  (import 切新名 + `handle: Promise<TriggerOutcome>` + 全路径 `{done:true}`),
  `platform-mcp.service.ts` (TimerService→TriggerService import/Inject/type 同引用零风险;
  两处 schedule dedup 改走 `buildTriggerDedupKey(TRIGGER_KIND.*)`),
  `review-round-timeout.handler.spec.ts` (仅 2 处 `toBeUndefined`→`toEqual({done:true})`,
  合同更新非弱化: 仍断言不抛 + 新增精确 outcome)。
- outcome 映射 (全部 `{done:true}`, 零 `{expire:true}`——expire 落 cancelled,
  与原 one-shot fired 语义不等价, 故禁用; 基座 void≡{done:true}≡fired):
  receipt_nudge: 缺receiptId(warn)/行缺失或非pending(ack-race)/同消息已催/被指派人冷却中/
  正常nudge(dispatch kind=nudge + recordAutoNudge)/升级(expireAfterAutoNudge + 升级通知)
  → 6 路径全 `{done:true}`。MAX_AUTO_NUDGES=1 / NUDGE_COOLDOWN_MS /
  isMessageAlreadyNudged / isAssigneeMuted / expireAfterAutoNudge 逐字保留, 冷却不统一。
  review_round_timeout: 缺issueId(warn)/读issue失败(warn)/无账本/旧轮(payload.round≠ledger.round,warn)/
  非collecting/gate未装配(warn)/checkTimeout成功或抛错(warn吞)/终点 → 8 路径全 `{done:true}`。
  gate.checkTimeout 委托逐字保留; 本路径零 notifier 调用 (grep 自证), 绝不自动放行。
- dedup 逐字节等价: 两 legacy builder 改为委托 `buildTriggerDedupKey` (导出名不变);
  spec 锁 `receipt_nudge:tm_1:mr_0000000001`(经新 builder 的 call-site 路径) /
  `receipt_nudge:tm_1:mr_9` / `review_round_timeout:{issueId}:2` 全绿。
  TriggerFireContext dueAt?/fireCount? 未动 (消费者不读, 不 churn)。
- 别名选择: 一致切新名 (TriggerService/TriggerFireContext/TriggerOutcome);
  spec 内 `{provide: TimerService}` 保留 (@deprecated 同引用, 零 DI 风险, 不 churn spec)。
- 重启证明 (core criterion #1, live DB, 2026-09-17 ~02:32Z):
  rebuild (`docker compose up -d --build server`, baked 镜像) → 插 3 探针 (due=NOW-5min):
  `tmr_probe56_restart`(真 pending mr_0000000001)→**fired**(fire_count=1, nudge_count 0→1,
  last_nudged_at 落库, 即同输入→同时机→同动作); `tmr_probe56_bogus`→fired (warn 零副作用);
  `tmr_probe56_cancel`→保持 cancelled (fire_count=0/attempts=0, 永不触发)。
  清理: DELETE 探针 + 重 SELECT, 探针 0 行, 表回 19 行 (收据见 db-after.txt)。
  副作用诚实记录: mr_0000000001 被正常催办一次 + channel c_0000000007 落一条催办 mention
  (handler 设计动作, 非污染; 探针 trigger 行已清)。
-  adversarial: cancel(上) / stale(acked+expired 无行可指, 用单元 spec 的 ack-race 用例覆盖, 绿) /
  misleading(以 DB transition 为准, 非日志) / dirty_worktree(4 文件外零碰, 未 commit/stash)。
- 套件: 基线 tsc 0; 迁移后 tsc 0 + 6 相关 spec 88→89 全绿;
  全量首轮 117/118 (唯一失败系并发 workstream 正写的 worker-dispatcher.spec 看门狗用例,
  该文件零 import 本 diff, 其间 diff 从 12 行涨到 122 行且一度不可编译——外因实锤, 未碰);
  终轮 **120/2708 全绿 exit 0** (并发方补 2 suites +31 用例并修好其 spec)。
  证据: `.omo/evidence/trigger-unification/todo-5/` + `todo-6/`
  (tsc-after.txt/db-before.txt/receipt-before.txt/db-after.txt/dedup-proof.txt/jest-after.log;
  todo-5 的 jest log 系 117/118 首轮, todo-6 系 120/2708 终轮)。

## todo-22: GET/DELETE /api/v1/triggers REST 底座 (2026-09-17)
- 端点契约 (todo-16/18 直接消费, 全局前缀 /api/v1):
  - `GET /triggers?scopeType=&scopeId=&taskId=&teamId=&status=&kind=&page=&pageSize=`
    → 200 `{items,total,page,pageSize}` (tools/memories 同分页契约: 缺省 page=1/pageSize=20, 上限 100)。
    非法 status/kind/page → 400 (DTO @IsIn/@IsInt, 非 500); 未知查询 param 被 whitelist 剥离。
  - 项字段 (白名单, 无 payload/dedupKey): `id,kind,status,dueAt,nextFireAt,scopeType,scopeId,
    ownerInstanceId,fireCount,skipReason,lastError,attempts,createdAt` + 派生 `source`.
  - `DELETE /triggers/:id` → 200 当前行 (已 cancelled/fired 幂等直返, 不重写终态, 不 409);
    未知 id → 404 `TRIGGER_NOT_FOUND`。
- `source` 唯一映射点: `triggerSourceOf()` in
  `server/src/common/constants/trigger.constants.ts` (hook_fire/hook_poll→agent, 其余→system,
  未知 kind→system 展示 fail-closed; controller/service 禁止第二份名单) + `TRIGGER_API_ERRORS`
  (TRIGGER_NOT_FOUND / TRIGGER_TEAM_SCOPE_REQUIRED / TRIGGER_SYSTEM_READONLY / TRIGGER_FORBIDDEN)。
- 服务端 authz (决策 5, `server/src/timers/triggers.service.ts`, 不靠 UI 隐藏):
  - 列表: admin 全局; 成员缺 teamId → 403 TEAM_SCOPE_REQUIRED (fail closed);
    成员+所属 teamId → 归属 OR 约束 (scope team直标 / payload.teamId / owner∈本团队 tmm_);
    成员+非所属 teamId → 200 空集 (对齐 chat 频道列表不泄漏存在性)。
  - 取消: admin 全放; 成员系统项 → 403 SYSTEM_READONLY; 成员 agent 项需行归属团队成员 → 否则 403 FORBIDDEN。
    归属解析 scope→owner所在团队→payload.teamId→payload.taskId经任务 (resolveTriggerTeam)。
  - REST JWT 身份是 userId, 无法与 tmm_ 逐字相等——逐字 owner 复核归 MCP hook_cancel (todo-12,
    callerId 即 tmm_); REST 侧所有权域=归属团队 (server-side team_user_members 证明)。
    含义: 团队成员可取消本团队 agent 项 (todo-18 需要), 系统项仅 admin (团队 Tab 只读)。
- MySQL JSON path 坑 (live 抓到, 单元 mock 盖不住): Prisma `path` 原样进 JSON_EXTRACT,
  必须 `$.` 前缀 (`'$.teamId'`), 否则 3143 Invalid JSON path → 500。
  类型侧 Prisma 6.19 `path?: string` (数组编译不过)。teamId/taskId 双条件必须独立 AND 子句
  (同 key spread 会覆盖, 静默丢过滤 = 越权/漏数)。
- 文件: 新增 `timers/triggers.service.ts` + `triggers.controller.ts` + `dto/query-triggers.dto.ts`
  + 两 spec; 改 `timers.module.ts` (加 controllers/providers, 保留 TimerService 重导出)
  + `trigger.constants(.spec).ts` (source 映射+用例)。未碰 sibling 的 5 个文件。
- curl recipe (todo-16/18 复用, 见 `.omo/evidence/trigger-unification/todo-22/curl-proof.sh`):
  `POST /api/v1/auth/login {username:admin,password:admin123}` 取 accessToken →
  `GET /triggers?status=fired&page=1&pageSize=5 -H "Authorization: Bearer <jwt>"`;
  成员用 seed-member/Admin@123456 (非 admin, 零团队归属: 越权探针理想账号)。
- Live 证据: transcript 含 headers/status (server 访问日志亦有 403/200/404/400/401 行);
  DB 地面真值 JSON_EXTRACT 计数与 API total 逐字一致 (19/19/19);
  探针 `tmr_probe_todo22` (pending hook_poll, owner tmm_0000000001) insert→member 403→admin 200
  cancelled (SELECT 确认)→重删 200→DELETE 物理清理→SELECT 0 行; 403 命中的系统行 status 未变。
- 套件: 基线 tsc 0 + jest 118 suites/2440 tests (3 失败全系 sibling 在改 review-round-timeout.handler
  的 TS2552, 非我文件); 终态 tsc 0 + **120/2708 全绿** ( sibling 修好其文件; +2 suites/+24 用例系本 todo,
  其余增量系并发方)。证据: `.omo/evidence/trigger-unification/todo-22/`
  (tsc-baseline/after, jest-baseline/after, docker-build*.log, db-before, curl-proof.sh,
   curl-transcript.txt, curl-transcript-fix.txt)。树保持 dirty-but-intact, 未 commit/stash。

## todo-18: 团队会话右侧 触发 Tab (2026-09-17)
- testids: `task-subtab-triggers` (仅新 tab 加 testid, 旧 tab 保持无 testid 不动) /
  `trigger-row` (+`data-trigger-id`/`data-source`/`data-status`) /
  `trigger-cancel` (agent 行取消按钮; ConfirmDialog 用同前缀派生
  `trigger-cancel-modal/-cancel/-confirm`, 与行按钮无碰撞) /
  `trigger-skip-reason` / `trigger-empty` / `trigger-list-error` / `trigger-cancel-error`。
- 查询键 + 失效: `triggersQueryKey(taskId, teamId)` =
  taskId 有值 ? `["task", taskId, "triggers"]` : `["team", teamId, "triggers"]`;
  badge 与面板调同一 hook (`useTaskTriggers`) 同 key 共享缓存、单次请求。
  作用域: taskId 优先 (`GET /triggers?taskId=&page=1&pageSize=100`), 无 task 回退 teamId。
  会话页实时桥无 trigger 事件族, 故沿用 30s `refetchInterval`
  (与 plan-steps/artifacts 同节奏); 取消成功后 `invalidateQueries` 同 key;
  导出了 `triggersQueryKey`/`TriggerItem` 供会话页将来接事件失效时复用。
- 权限: 系统行无取消按钮 (plan decision 5, 后端二次强制); 仅 agent 行渲染取消 →
  ConfirmDialog → `api.delete('/triggers/:id')`, 403/404 经 `isApiError` 进
  `trigger-cancel-error` (role=alert)。400/403 列表态 (非法 filter /
  TRIGGER_TEAM_SCOPE_REQUIRED) 走 `trigger-list-error`, `retry: false` 防空转。
- 行渲染: kind · 状态 pill (pending 待触发 #F59E0B / firing 触发中 #0D9488 /
  fired 已触发 #10B981 / cancelled 灰 / failed #DC2626) + `nextFireAt ?? dueAt`
  (`zh-CN` 本地串, 缺失"—") + 来源 (系统/Agent) + `触发 {fireCount} 次` +
  skipReason 有则另起一行 (data-testid `trigger-skip-reason`)。
  样式逐字复用本文件既有 row/card/badge (subTabStyle / neutral/space/radius/
  fontSize/fontFamily tokens, 零新视觉)。
- 实测探针 (事后已物理清理, 表回 21 行含 sibling 新 progression_patrol 行):
  插 `tmr_probe_t18_sys` (receipt_nudge/system/pending/skipReason=probe: cooldown active)
  + `tmr_probe_t18_agent` (hook_poll/agent/pending), payload
  `{"teamId":"tm_0000000001","taskId":"t_0000000001"}`, due +1d (ticker 不认领)。
  `GET /triggers?taskId=t_0000000001` → total=2, source agent/system 各一。
  浏览器 (compose :13001, admin, `/teams/tm_0000000001/session` → 任务主 Tab →
  触发子 Tab): badge `触发2` → 点 agent 行取消 → ConfirmDialog →
  确认后 badge `触发1`, agent 行 data-status=cancelled, 系统行始终无取消按钮
  (1 行 1 取消按钮, cancelIds=[tmr_probe_t18_agent])。
  DELETE 系软取消 (cancelled, 幂等 200 直返), 非物理删除。
- 坑:
  - 首轮 tsc 报 `.next/types/validator.ts` 引 sibling 在飞的 `/system/triggers`
    (stale .next, 同 todo-15 陷阱) → `rm -rf web/.next` 后 tsc exit 0。
  - `npm run build` 与 `:3001` dev server (sibling 在用) 共享 `.next` 会偶发
    ENOENT race (500.html rename / _ssgManifest open 各一次) → 等 racing
    `next build` 进程退出后重跑即 exit 0 (勿杀 sibling dev)。
  - 触发 Tab 藏在"任务"主 Tab 下 (默认"团队"), QA 须先点任务主 Tab。
  - console 仅 SSE `/events` 500/ERR_INCOMPLETE_CHUNKED_ENCODING (预存 infra
    抖动, 与本 tab 无关, 无 trigger API error)。
- 验证: `cd web && npx tsc --noEmit` exit 0; `npm run build` exit 0。
  证据: `.omo/evidence/trigger-unification/todo-18/`
  (`triggers-tab-active.png` / `trigger-cancel-confirm.png` / `triggers-after-cancel.png`)。
  仅改 `web/src/components/teams/TeamRightPanel.tsx` (+167/-2), sibling
  (nav-dock/app-shell/task-status-actions/system-sidebar) 零触碰, 未 commit/stash。

## todo-16: /system/triggers 触发器列表/管理页 (2026-09-17)
- 唯一新增文件 `web/app/(main)/system/triggers/page.tsx` (骨架照抄
  `system/memories/page.tsx`: 300ms 防抖搜索 + TanStack Query + ConfirmDialog;
  注意 `(main)/memories/page.tsx` 已是 todo-17 的 redirect stub, 真骨架在
  `system/memories/page.tsx`)。容器换 PageWindow(`triggers-root`) + 共享
  Pagination(`triggers-pagination`) + EmptyState。shell/layout/sidebar 零改动。
- testids (与 todo-18 同名, 不同路由无碰撞, 未来 e2e 可跨页复用选择器):
  `triggers-root/list/count/loading/error/retry`, `trigger-kind-tabs/tab`
  (`data-kind`), `trigger-source-tabs/tab`, `trigger-search`,
  `trigger-team-scope` (成员团队范围 select), `trigger-row`
  (+`data-trigger-id/data-kind/data-status/data-source`), `trigger-id/kind/
  status/source/due/scope/owner/fire-count`, `trigger-skip-reason`,
  `trigger-detail` + `trigger-detail-drawer/-close/-skip-reason/-last-error`,
  `trigger-cancel`, `trigger-cancel-error`, `confirm-cancel-trigger-modal/
  -cancel/-confirm`。
- filter→API 映射: kind Tab 全部→不带 kind / 定时→`kind=hook_fire` /
  条件→`kind=hook_poll` / 事件→预留类型不发请求直接 EmptyState
  (后端无对应 kind, 传任意值必 400, 故零请求零报错)。
  source 筛选: 后端无 source 参数 → system/agent 时 `page=1&pageSize=100`
  取回后按服务端 `source` 字段客户端过滤+客户端分页 (绝不重算 source);
  搜索框同理 (后端无 keyword 参数, 按 id/kind/scope/owner/skipReason/
  lastError 客户端过滤)。source=全部+无关键字时走服务端分页 (20/页)。
- 共享 StatusBadge 不可用: 其 props 类型 StatusKey 仅任务四态, 传触发器五态会
  类型崩+`statusColors[x]` undefined 运行时崩 → 本页用同视觉式本地 pill
  (`STATUS_META`: 待触发青/触发中蓝/已触发绿/已取消灰/失败红)。
- 成员 team-scope 403 处理: `isAdmin = roleName==="admin"`; 非 admin 未选团队时
  query `enabled:false` + 渲染选择器 (候选来自 `teamsApi.list({page:1,
  pageSize:100})`) + EmptyState 明示"全局列表仅管理员可见";
  残留 `TRIGGER_TEAM_SCOPE_REQUIRED` 兜底为可读提示+重试, 不渲染 raw error。
  cancel 可见性: 仅 pending/firing 行, 且非 admin 的 system 行不渲染按钮
  (UI 隐藏仅体验, 服务端 403 SYSTEM_READONLY 强制, 错误码经 isApiError 原样展示)。
- 实时: `useRealtimeEvents` (receipt.acked/expired + round.complete/stale →
  invalidate ["triggers"]) + 15s `refetchInterval` 兜底 + 30s tick 重算"还有 X"。
  Row 时间: `formatDue` 取 `nextFireAt ?? dueAt`, 终态直接结论 (已触发/已取消/
  触发失败), 未来"还有 XhYm"/过去"已到期 X"。
- 实测 (compose :13001, repo playwright CLI 因 MCP 浏览器被 sibling 占用;
  脚本 `web/qa-t16-triggers.mjs` 跑完已删, 树无残留):
  admin 列表 20 行/共 24 (含 todo-18 探针行, 其后 sibling 清理, curl 复核回 21,
  live 抖动属正常), sidebar 触发器 `data-active=true`, 面包屑`系统管理›触发器`;
  来源=系统过滤后 20 行全系统; 定时 Tab 0 行 (curl 证 `kind=hook_fire` total=0,
  真空非 bug); 非法 kind/status → API 400 已 curl 实锤, UI 侧事件 Tab/错误态覆盖;
  skipReason 行渲染"未触发原因" (探针 `probe: cooldown active`);
  cancel 对话框打开后按 Esc 关闭, 零 mutation (两 pending 行原样保留);
  member (`seed-member`) 访 `/system/triggers` → ROUTE_GUARD 直接 replace 到
  `/teams` (`triggers-root` 0 个) —— 成员根本到不了本页, 取消 affordance 无从谈起,
  team-scope 选择器为纵深防御 (guard 若放宽即生效), 服务端 403 已由 todo-22 锁定。
- 构建: tsc exit 0; `npm run build` exit 0 (`○ /system/triggers` 5.5kB)。
  途中两插曲皆非本页问题: (1) 尾段 `Collecting build traces` ENOENT
  `_not-found…nft.json` (同 todo-18 记的共享 .next race, 重跑即 0);
  (2) `docker compose up -d --build web` 首轮 `npm run build exit 1` +
  次轮 daemon `removal … already in progress` (sibling 并发 rebuild, sleep 后重跑即
  healthy + `curl :13001/login` 200)。
- 证据: `.omo/evidence/trigger-unification/todo-16/` (`admin-list.png` /
  `filter-applied.png` / `cancel-dialog.png` / `member-view.png`)。
  树 dirty-but-intact, 未 commit/stash; QA 脚本已删。

## todo-9: 首字 watchdog durable 化（TriggerService 侧车，2026-09-17）
- kind 选择: 复用 `TRIGGER_KIND.SESSION_IDLE_SCAN` (白名单内唯一的会话存活类 kind),
  payload `{reason:'first-token', scope, agentId, sessionId, workerId, teamMemberId, dispatchedAt}`
  作鉴别。不新增 kind = 不 churn 白名单与 todo-22 REST source 映射
  (未知 kind 在展示侧归 system, 新增反而要动映射表)。handler 首行即
  `isFirstTokenTriggerPayload` 鉴别, 非首字载荷 no-op `{done:true}`, 与未来同 kind
  空闲扫描载荷共存。dedupKey per-dispatch 唯一
  (`session_idle_scan:<scope:agentId>:<sessionId>:first-token:<ms>:<rand>`)——
  schedule 对既有 dedupKey 幂等直返, 同会话多轮分派必须各有新行。
- 接线 (platform-mcp.service.ts 同款 optional sidecar):
  构造参末尾 `@Optional() @Inject(TriggerService) private readonly triggers?`,
  注册包 try/catch warn; ChatModule 已 import TimersModule 故生产有值,
  单测/旧装配缺席时仅内存 timer 生效。schedule/cancel 全 best-effort
  (catch→warn, 永不抛, 不阻断分派)。`PendingDispatch` 加可选 `triggerDedupKey`
  (仅落库成功才挂载, 失败则无行可取消)。
- veto 交互: `pendingBySession`/`pending`/`activeExecutions`/`failedSessions`/
  `lastActivityAt`/`isAgentExecuting` 零语义改动 (只读 + 原有删/增点不变)。
  收割体抽为 `reapFirstTokenDeadline` (内存 timer 与 trigger handler 共用,
  逐字原行为: pending 删 + failedSessions.add + unregisterExecution +
  追踪退出 + emitError + 广播 first_token_timeout)。另加同键旧轮残留 guard
  (timer 与 handler 双侧校验 `entry.sessionId === sessionId`)。
- 首字到达取消: `clearPendingWatchdog`/`clearPendingWatchdogBySession` 末尾
  `void cancelFirstTokenTrigger(dedupKey)`; 同键重注册先 cancel 旧行。
  `persistSessionActivity(sessionId, at?)` 加可选显式时间戳, watchdog 起点传
  同一 `dispatchedAt` (DB 写入值 == payload 值, `>` 比较不把起点误判为到达)。
- 重启判定 (handler, 内存缺席时): session 行缺失/非 running → 跳过;
  `lastActivityAt > dispatchedAt` → 首字到过 → 跳过 (关键防误杀);
  DB 异常 → fail-open 跳过; 否则收割 (failedSessions.add + 注销 + 广播,
  Session 行状态不写——与原语义一致)。
- 重启证明 (live, 2026-09-17 ~02:45-02:47Z, baked 镜像重 build 后):
  插 `s_probe_todo9` (running, activity=NOW-70s) + `tmr_probe_todo9`
  (pending, due=NOW-60s, dispatchedAt == activity ms) → `docker compose restart server`
  (内存全空) → ~30s 内该行 `fired, fire_count=1, attempts=1, lastError=NULL`,
  新进程日志 `WorkerDispatcher agent a_developer agent 无响应（60s 无事件回流）`
  (收割执行实锤, 非仅行终态)。清理: 双 DELETE → 0/0 行, 无 first-token 残留。
  残留缺口诚实记录: 探针行系手工直驱 TriggerService (按任务书允许的 fallback),
  未走真实 pre-first-token dispatch + kill 窗口; 但 handler 注册可达性由
  fired (非 `no handler for kind` failed) 自证。
- 附带 live 证据 (真实流量, 非探针): 重启后 `tm_0000000006/s_0000000016` 真实分派
  经新代码落 `tmr_0000000025` (due 02:49:17), 首字 +149ms 到达
  (lastActivityAt 02:48:17.160 > dispatchedAt …011) → durable 行 `cancelled`,
  会话正常 idle, 零误收割。该 cancelled 行系合法系统数据, 未删除。
- 数字: 基线 tsc 0 + 120/2708 全绿 → 终态 tsc 0 + **120/2729 全绿**
  (+8 本 todo 用例: 注册/schedule 形状/双 clear 取消/重注册换键/内存收割/
  重启收割/已到不杀/它载荷+DB fail-open; 另 +13 系并发方)。
  中途全量跑两次孤立失败 (5 suites→1 suite, 失败 tests 恒 0;
  单跑即过, 含 sibling 在改的 task-progression.scheduler.spec), 属已知 flake 家族,
  第三轮 120 全绿。platform-mcp 8 suites/326 全绿零改动。
  证据: `.omo/evidence/trigger-unification/todo-9/`
  (tsc-after/jest-after/restart-proof/restart-reap-logs/db-cleanup/
  live-cancel-proof/worktree)。树 dirty-but-intact, 未 commit/stash;
  禁区 `task-progression.scheduler.ts` 零触碰。

## todo-8: task-progression → TriggerService interval 迁移 (2026-09-17)
- rounds 持久化位置: **trigger.fire_count** (rounds ≡ fireCount)。基座每次触发后
  `fireCount+1` 落库, interval 行回 pending + `nextFireAt = now + intervalMs + jitter`。
  拒绝把 rounds 放 payload——payload 需 handler 手写 update, 而 fireCount 是基座原生计数,
  零额外写、claim 前后双强制直接可用。
- maxRounds 映射: **maxFires = maxRounds**(schedule opts), 基座 claim 前
  (`fireCount>=maxFires→cancelled`, handler 不执行) + 触发后 (`fireCount+1>=maxFires→cancelled`)
  双重熄火。实测 maxFires=6: 第 6 次触发后行直接 cancelled, 与旧 `rounds>=maxRounds→注销` 逐轮等价。
- 冷却否决去向: **guard `progression_cooldown`** (condition 形态)。guard=false → 留 pending
  + skipReason, ticker 下轮(30s)复核, 不消耗轮次; 谓词内异常 → fail-open 返回 true
  (与旧 scan veto `try{}catch{}` 一致)。仍查 `isSessionPending`/`getLastActivityAt`,
  零删除。handler 内保留 race 窗口复核, 命中则跳过 dispatch 但返回 void
  (基座仍计一次 fireCount——保守偏向防空转, 该分支罕见)。
- 双写镜像: 内存 `loop` 保留 (decision 10 过渡期; isRegistered/patrolNow/scan 沿用,
  旧 spec 16 用例零改全绿)。自主 setInterval 扫描退役 (与 ticker 双驱动会重复下发 wake),
  scan() 保留为按需例程。restoreInProgressTasks 转数据修复: register 触发器侧幂等——
  pending 行保留 fireCount, 终态行 delete+重建, 缺失行新建。
- dedupKey: `progression_patrol:task:<taskId>` (`buildTriggerDedupKey` 组装, 一任务一行)。
  unregister → `cancel(dedupKey)` (行留 cancelled)。注意 schedule 幂等返回既有行**不看状态**——
  cancelled 行会吞掉重建, 故 register 必须先查行状态 (pending 留 / 终态删后重建)。
- DI: TriggerService 经 `@Optional()` 注入 (旧 spec 无 provider 照常 resolve);
  TasksModule 新增 imports TimersModule (TimersModule 仅依赖 RealtimeModule, 无环)。
- 重启证明数字 (live, t_0000000011/tmr_0000000024): register 后 fire_count=0 →
  强制到期触发后 fire_count=1/pending/next=now+20min → `restart server` 后
  **fire_count=1 原样保留** (旧代码重启即 0) → mark-pending-review 后 cancelled。
  清理收据: probe task/trigger/session/message/memory/plan/event 全 0,
  tm_0000000006.current_task_id 回 NULL, tm_0000000001 队列回 5 行原位。
  清理坑: `teams.current_task_id` FK 必须先置 NULL 再删 task 行 (分两批)。
- 探针副作用诚实记录: 强制触发跑了真 dispatch (主成员 wake + agent 回复 + 2 条 memory),
  均已按行删除; 频道 c_0000000013 (team_group) 为既有行, 未动。
- 套件: 基线 tsc 0 + 120/2708 → 终态 tsc 0 + **120/2729** (+14 本 todo, +7 并发 sibling, 零回归)。
  证据: `.omo/evidence/trigger-unification/todo-8/` (tsc-after.txt/jest-after.log/
  db-before-restart.txt/db-after-fire.txt/db-after-restart.txt/db-after-unregister.txt/
  db-cleanup.txt/proof.md)。
- zsh 坑: `echo ===` 触发 `=` 命令路径展开 (`zsh: == not found`)——证据命令里用 `---`。

## todo-10: dispatch→running lag PoC — PASS, graceMs=90s (2026-09-17)
- Verdict: **PASS** (P99_upper=2214ms <= 30s; 90s >= P99+60s=62.2s)。`all_idle` 可 auto-wake, graceMs=90s。
- 数字 (n=101 real paired samples, LIVE worker w_compose_worker online):
  L_upper (message.created_at→running event.created_at, 同 DB 时钟零 skew, 严格上界):
  P50=75ms P90=163ms **P99=2214ms** max=2407ms mean=187;
  L_exact (trigger.payload.dispatchedAt→running): P50=13ms P90=26ms P99=119ms max=121ms。
  真值 ∈ [exact, upper] (exact 漏 server→worker transit 约 ms 级 + ≤20ms 时钟差; upper 含 inbound routing)。
- 方法 (零插桩零 rebuild, 三假设 H1 日志插桩否决/H2 历史挖掘否决/H3 新鲜受控分派选中):
  临时 probe team tm_0000000010 (5 成员各一模板 agent) + 101×POST /channels/:id/messages 单成员 mention,
  每 dispatch exactly 一次真实模型 turn (pong 回复, running→idle 正常流转);
  driver 逐会话 idle 门控 + 单 in-flight, 2s 轮询, 75s deadline (首字 watchdog 60s+15s);
  配对经 DB ground truth 独立重推 (101/101 单配对, 零 double-fire, 零 censored; probe session.updated 共 202=101 running+101 idle 自证)。
- 尾部归因: slow-5 全真 (4 个来自初始 4 路并发 burst 的 worker-accept 串行化约 2s + 1 个后台负载 2.4s)——
  upper 含 accept 排队、exact 不含, bracket 行为符合设计。
- 清理收据: realtime_events 1529 + messages 404 (101 user+101 agent 群 + 202 私聊镜像) + triggers 101
  (cancelled 首字行) + sessions 5 + channels 6 (1 群+5 私) + task_group_instances 10 + tum 1 + members 5 + team 1
  全按 ID 删除; 事后 teams 6/members 19/sessions 9/channels 16 回基线, memories 46/artifacts 40/issues 28/aq 2 不变,
  probe id 零残留。注意两坑: (1) dispatch 会镜像消息到成员私聊频道 + 落 task_group_instances 行 (删 members 前先清);
  (2) team id 会复用 (tm_0000000010 曾是 e2e 旧 team, 其 team.changed/deleted 旧行保留, 只删 probe 自己的 create 行)。
  驱动脚本全放 /tmp (已删), repo 内仅报告; 生产代码零触碰 (故无 rebuild/回滚)。
- 局限: ≤4 路 burst + 常态 live 流量下测得; 更重并发未测 (+60s 缓冲吸收约 25×P99, 够用)。
  证据: `.omo/evidence/trigger-unification/todo-10/` (report.md/method-note.md/samples.json/db-baseline.txt)。

## todo-11: agent-hook 域（time + all_idle，经 kind:wake 同会话唤醒，2026-09-17）
- 表: `hooks`（迁移 `20260919000003_agent_hooks`，烘焙镜像 recipe `docker compose cp`
  + `migrate deploy` 一次过）。列: id(hks_)/scopeType/scopeId/ownerInstanceId/kind/
  wakeText(TEXT)/target(JSON)/status/dueAt?/graceMs?/expiresAt/dedupKey(uniq)/
  fireCount/parentHookId?/rootTaskId?/lastError/skipReason?/timestamps。
  索引: (status,dueAt) fire 口径 / (status,scopeType,scopeId) 归属 /
  (status,kind) poll 口径。无 FK（逻辑关联，todo-3 从 payload.hookId +
  `hook_fire:hook:<hookId>` 双向回查）。
- `graceMs` 常量: `HOOK_ALL_IDLE_GRACE_MS_DEFAULT = 4min`
  （`server/src/triggers/hook.constants.ts`，env `HOOK_ALL_IDLE_GRACE_MS`，
  Number() 归一——ConfigService 不 coerce，todo-7 教训）；plan 区间 3–5min 内取值，
  终值等 todo-10 PoC 的 dispatch→running lag 分布测量。poll 间隔
  `HOOK_POLL_INTERVAL_MS_DEFAULT = 30s`（env 同名），busy 重试 60s。
- 全局 `hook_poll`（N×1 非 N×M）: 一域一行 interval 触发器
  （dedup `hook_poll:global:all_idle`，onModuleInit 幂等确保，无 maxFires/expiresAt
  的 daemon 行），一 tick 取 pending all_idle ≤100 行逐个评估，同 tick 至多唤醒
  ONE 个（`HOOK_POLL_WAKES_PER_TICK=1`），其余排队等下轮。静默谓词 =
  scope 内零 running 会话 AND now-max(lastActivityAt)>=grace（running 行
  NULL 活动也判忙，fail-closed；零候选会话即静默）。
- 注册 `registerHook`：1 hook 行 + 1 hook_fire 行同 `$transaction`（time:
  dueAt=到期；all_idle: dueAt=expiresAt 纯兜底，唤醒权在 poll）。fire 行**不设**
  基座 expiresAt（基座 claim 前取消会绕过 handler 致 stranded pending）——过期一律
  handler 侧 `now>=expiresAt → expired` 结算；veto 重排越过 expiresAt 改判 expired。
  wakeText 截断 2000 + 前缀 `[hook:<kind> <id>]`，kind:wake 豁免门禁。
- 否决: DB running 会话 + `isSessionPending` + `isAgentExecuting(workerId,
  team:<teamId>)`（只读复用，todo-7 同款）；命中必写 skipReason（plan 硬性）。
- 血缘: `parentHookId` 指向上游，`rootTaskId` 继承不重置（parent 链首→parent
  任务→本次 target）；`expireTaskHooks(taskId)` 按 rootTaskId 标 expired 只标不删
  （resetAfterComplete 调用方归 todo-3，本服务留方法+单元锁定，未接 tasks.service）。
- live 抓到的真 bug: Nest 跨模块 onModuleInit 无序 → HookService 先跑时 tmr_
  计数器未续号，`schedule()` 取到已存在的 tmr_ id 撞 PRIMARY，poll 行建失败
  （仅 warn，被吞）。修: HookService.onModuleInit 自助
  `resyncIdPrefix(prisma.trigger, 'tmr')`（seed 只升不降，重复调用安全）+ 单元锁定。
- live 证明（探针全清，0/0/0）: time 到期 → trigger fired(1/1/NULL) + hook fired +
  真 wake（developer 在原会话 s_0000000003 跑完一轮回 ack，session 回 idle）；
  running 目标 → skipReason 落库 + 零分派 + fire 行重排 60s，idle 恢复后次轮自动唤醒
  （veto→retry→wake 全链）；all_idle 长 grace 轮询 6 次零误唤醒；cancelled 对永不触发；
  全局 poll 行 fire_count 递增。全套件基线 120/2729 → 终态 **121/2771 全绿**
  （+42 本 todo，零回归；tsc exit 0）。证据 `.omo/evidence/trigger-unification/todo-11/`。
- 残留缺口（诚实）: `[hook:kind id]` 前缀只在单元锁（live 日志不打 prompt 原文）；
  poll 唤醒的 live 未单独跑（与 fire 共用 tryWake，fire 侧已真 wake）；hook_register/
  hook_cancel MCP 薄封装归 todo-12（本服务 API 已按此塑形）。

## todo-12/13: hook_register/hook_cancel MCP 薄封装 + seed/registry 三路同步 (2026-09-17)
- 工具契约 (`platform-mcp.tools.ts`, append 在 git_repos_list 后, controller 无改):
  - `hook_register`: `{taskId?, teamId?, selfInstanceId!, kind!: time|all_idle, wakeText!: min1 (服务端截断 2000), targetInstanceId?, dueAt?: ISO, delayMs?: +ms, expiresInMs?: +ms (缺省 24h), graceMs?, dedupKey?}` + 双 refine (task-or-team 沿 REQUIRE_TASK_OR_TEAM_MSG; time 需 dueAt/delayMs 二选一且互斥, all_idle 禁止带) ——畸形经 tools/call 报 -32602, 不进 service。
  - `hook_cancel`: `{taskId?, teamId?, selfInstanceId!, hookId?, dedupKey?}` + 双 refine (task-or-team; hookId/dedupKey 至少其一)。
  - `ownerInstanceId` 与 `channelId` 故意不在 schema 内: 前者取自 `resolveExecContext` 的 `callerId`, 后者服务端按执行上下文解析群聊频道 (findTaskGroupChannel/findTeamGroupChannel) ——客户端传即冒充/跨频道, 故不收。`target` 面 = 可选 `targetInstanceId` (缺省调用方自身; 显式传须落在执行团队成员内, 否则 403)。
- 服务端 (`platform-mcp.service.ts`, HookService 经 `@Optional() @Inject`, 无新增模块边——ChatModule 已 export, PlatformMcpModule 已 import, live 自证注入成功):
  - register: resolveExecContext (未知 scope 400 / 跨任务冒充 403, 与他工具同语义) → scope 取自 exec (task→task:id, team→team:id) → due 语义校验 (400) → 目标成员同团队校验 (403) → `hooks.registerHook` (其 loud throw 包一层转 400, HttpException 直透) → 回 `{hookId,status,kind,dueAt,expiresAt}`。
  - cancel: resolveExecContext → hook 双查 (id→dedupKey, miss 则 404 HOOK_NOT_FOUND 新增码) → `resolveHookTeamId` (team 直取 / task 经 teamIdOfTask / 兜底 owner 成员行; 不可解或 ≠ 执行团队 → 403) → owner 逐字相等放行, 否则查 `team.mainAgentMemberId === callerId` (agent 平面 admin 等价, MCP 无用户 JWT 故不能按 REST 查用户角色) 否则 403 → `hooks.cancelHook` (终态幂等直返)。
  - PLATFORM_MCP_ERRORS 新增 `HOOK_NOT_FOUND`; 死常量 `PLATFORM_MCP_TOOLS` (零引用) 未碰。
- 三路同步 (exact lines, 均 append 尾部): `server/prisma/seed.ts:65-66` VTEAM 镜像 + `:152-153` product + `:318-319` PM + `:1160-1161` vteamTools 两行 (`tl_vteam_hook_register/cancel`, 复用既有 upsert loop, 无改动); `agent.constants.ts:144-145` + `:314-315` product + `:480-481` PM。ROLE_SERVER_GATED 未动 (hook 非主实例专属, 走 owner 模型)。
- 授权面 (default deny): 仅 `vteam-product` (产品负责人 + README 默认主 Agent 选项) 与 `vteam-project_manager` (流程协调; seed 示例团队 mainAgentMemberId=tmm_0000000002 即 PM) allow; architect/developer/tester/plan/librarian 保持 deny (唤醒需求经 notify_agent 被他人唤醒, 无自助 delay 必要)。`defineBoundary` 补集自动推导 mcpDenies, 矩阵 spec 零改全绿。
- 附带 spec 改动 (行为变, 非弱化): `agent.constants.spec` 26→28; controller.spec 工具表 26→28 + hook schema 断言 (required/projection, descriptions 照例 drop); 新 `platform-mcp.service.hook.spec.ts` 18 用例 (register 8 / cancel 6 / schema 4); seed.spec 加 hook 两行断言; `agent-policies.custom-agents.spec.ts.snap` +24 (diff 审计仅新工具 deny/allow 行, `jest -u`)。
- 基线 tsc 0 + 121/2771 → 终态 tsc 0 + **122/2790** (+19, 零回归)。
- Live (baked 重 build, server healthy, 探针全清 0/0): tools/list 28 项含 hook_*; PM (tmm_0000000002, 有会话) register → `hks_0000000001` (owner=caller, scope task:t_0000000001) + 配对 `tmr_0000000132` hook_fire; 非 owner (developer tmm_4) cancel → 403; 跨团队 (tm_2 成员 on tm_1 task) register → 403; kind:event / 缺 scope → -32602; 2500 字 wake → DB 2000 (cap 实锤); owner cancel → cancelled, 重 cancel 幂等 200。
- 角色面 live: `GET /agent-policies` (admin JWT) product/PM guard tools allow ×2, developer/plan 缺席 (=deny) 且层① permission 显式 deny ×2。
- Seed 幂等: `node dist/prisma/seed.js` ×2, tools 255→255, hook 行恒 2。
- 清理收据: hooks/trigger 探针行 DELETE 后 0/0 (`db-cleanup.txt`); hook.service.ts/hook.constants.ts 零触碰; 树 dirty-but-intact, 未 commit/stash。
- 证据: `.omo/evidence/trigger-unification/todo-12/` (tools-list/register-ok/cancel-ok+idempotent/4 probe/db-row/cleanup/build/jest-tsc) + `todo-13/` (role-allowlist-live/seed-run1+2)。

## todo-19: hook anti-runaway guardrails（6 道 rail，2026-09-17）
- 常量（`server/src/triggers/hook.constants.ts`，ms 类沿用 `resolveHookMs` Number() 归一 + `_ENV` 键，计数类新增 `resolveHookCount` 正整数归一；todo-7 教训）：
  - #1 `HOOK_MIN_DELAY_MS_DEFAULT=60_000`（env `HOOK_MIN_DELAY_MS`）+ `HOOK_MIN_DELAY_SKEW_MS=1000`（调用链路耗时容差，恰卡 60s 边界的合法注册不被几 ms 误杀；秒级自唤仍拒）。
  - #2 `HOOK_DEFAULT_TTL_MS=24h`（canonical 值；todo-12 `hook_register` 侧已有同值本地 `HOOK_DEFAULT_EXPIRES_MS`，未动禁区文件）+ `HOOK_MAX_TTL_MS_DEFAULT=7d`（env `HOOK_MAX_TTL_MS`，`expiresAt-now` 超此/已过去一律 loud 拒绝）。
  - #3 `HOOK_SCOPE_PENDING_CAP_DEFAULT=20`（env 同名，`findMany take cap+1` 代替 count，命中 `(status,scope)` 复合索引）。
  - #4 `HOOK_TASK_WAKE_BUDGET_DEFAULT=5`（env 同名；fired+pending 血缘行计数，cancelled/expired 不计；注册拒 + fire/poll 改判 expired 双重熄火）。
  - #6 `HOOK_BUSY_MAX_RETRIES_DEFAULT=10`（env 同名；间隔沿用 `HOOK_BUSY_RETRY_MS_DEFAULT=60s`）。
  - `HOOK_LINEAGE_WALK_LIMIT=12`（回溯跳数上限，预算 2 倍 + 余量）+ `HOOK_WAKE_SIMILAR_MIN_LEN=16`（短词不判相似）。
- 环检测算法（`HookService.detectHookCycle`，图感知三层，注释 + 报告双述）：
  1) 链深：祖先数 >= 预算（5）→ 拒（新 hook 将是第 N+1 代）；2) 同任务（同非空 rootTaskId）：自环（同 owner+同 target+逐字同 wakeText）或 A↔B 对穿（祖先 owner==本次 target 且祖先 target==本次 owner，且要求真交替 A≠B——自指 hook 续注册不是 ping-pong，此条件系既有 todo-11 续注册用例失败一次后补上，见下方）；3) 跨任务回退（root 不同，多见于无 task 的 team 域链；parent 链继承 root，故有 parent 时恒同任务）：只认对穿回显 + 归一化相似（相等/长包含），同对复现不拦（合法复用，失控由链深规则切断），cancelled 祖先不参判。
- 自指误伤实录：首版对穿无 A≠B 条件 → 既有 `被唤醒轮内续注册` 用例（owner tmm_1/target tmm_1 自唤）被误判对穿而红；补 `crossDirected` 后 42/42 回绿。教训：自唤是常见形，对穿必须要求真交替。
- A↔B ping-pong  textured 证据：单测构造 H1(owner tmm_A→target tmm_B, task t_1) + 新注册(owner tmm_B→target tmm_A, parent=H1) → `对穿环` 拒绝，无事务（`$transaction` 未调用）；跨任务 team 域回显 + 相似长文本 → `复读环` 拒绝。
- cross-task false-positive 证据（per-task 隔离成立）：① t_old 纵有 5 行满预算，t_new lineage 为空 → 新注册放行且 `rootTaskId=t_new`；② expired 旧链（t_old，自指）+ 不同目标（t_new）+ 不同长文本 + parent 挂旧链 → 放行（继承 root=t_old 下同任务判据全不中：目标不同→非自环，A==B→非对穿）。
- busy 梯证据：否决写 `skipReason` + `busyRetries:{increment:1}` 同一 update（0→1 重排 `rescheduleAt`）；9→10 改判 `expired` + `lastError~/重试满 10 次/`；fire 侧 lineage 6>5 改判 `expired`（`预算耗尽`，零分派）；poll 侧梯满同样 expired（skipReason 照写）。
- 落库支撑：迁移 `20260919000004_hook_guardrails`（`hooks.busy_retries INT NOT NULL DEFAULT 0` + `idx_hooks_root_task_status(root_task_id,status)`，加法-only，已 `docker cp` + `migrate deploy` 进 live 库并 DESCRIBE/SHOW INDEX 验证）；`schema.prisma` 同步 + `./node_modules/.bin/prisma generate`（npx 仍报 envelope 无命令，沿用 todo-7 recipe）。`expireTaskHooks`/`resetAfterComplete` 未动（只标 expired 不删，环链不断）；未碰 `worker-dispatcher.ts`/reconciler/event/MCP/UI。
- 套件：基线 tsc 0 + 122/2790 全绿 → 终态 tsc 0 + **123/2822 全绿**（+17 本 todo；多出 +1 suite/+15 系并发方落子，零失败）。Hook spec 42→59 全绿。证据 `.omo/evidence/trigger-unification/todo-19/`（jest-baseline.log/jest-after.log/tsc-after.txt/hook-spec-tests.txt）。
- 残留缺口（诚实）：无 parent 链的跨任务 fresh ping-pong（每次换新 root，无血缘可溯）hook 层不可见—— lineage 机制定义使然；残余风险由 scope cap 20 + TTL 7d 封顶总成本，未做全局 pair+text 记忆（那是 reconciler/todo-3 的事，本 todo 不越界）。

## todo-3: hook↔trigger reconciler 自愈（启动即跑 + 15min 周期，2026-09-17）
- 文件（4 新 + 1 改，均 ≤125 pure LOC；hook.service.ts / worker-dispatcher.ts 零触碰）：
  `server/src/triggers/trigger-reconciler.service.ts`（编排薄层：onModuleInit→resync tmr_→await reconcileOnce→ensureInterval；re-export 常量供 spec）/
  `trigger-reconciler.support.ts`（常量 + HookRowLike/TriggerRowLike + ReconcileCtx 单对象传参 + claimExpireHook + emitReconcile best-effort + P2002/isUnique + describeError）/
  `trigger-reconciler.direction-a.ts` / `trigger-reconciler.direction-b.ts` /
  `trigger-reconciler.service.spec.ts`（15 用例）；改 `server/src/timers/timers.module.ts`（providers += TriggerReconcilerService，注释记无循环依赖）。
- 孤儿发现缝（todo-11 迁移注释即 seam）：`hook.findMany({status:pending, take:500})` → 一次 `trigger.findMany({dedupKey:{in:hook_fire:hook:<id>}})` 回查；方向 B 反查 `trigger.findMany({kind:hook_fire, status:fired, take:500})` → `payload.hookId` → hook。全局 `hook_poll:global:all_idle` daemon 行 kind 过滤天然排除。
- 修复语义：A（pending hook + fire failed/cancelled/缺失）→ 过期则 claim-expire hook，否则重建 pending fire 行（due：time 取 hook.dueAt，all_idle 取 expiresAt；ticker 认 overdue 即刻触发）；B（fired fire + pending **time** hook，markFired 写丢即 wake 已分派 → 补 fired，过期则 expired；all_idle fired+pending 系 poll 正常态，跳过）。cancelled fire + pending hook 同 missing 处理（REST 手动取消触发器侧残留）。永不 DELETE hook 行。
- claim 机制（mirror fireOne `updateMany where {id,pending,dueAt<=now}` 仅 count===1）：过期/B 用 `hook.updateMany where {id, pending}`；failed/cancelled 用 `trigger.deleteMany where {dedupKey, status}`（认领+清理合一）；缺失行靠 dedup 唯一键（P2002=败者静默）。每次修复必 `RealtimeService.emit('trigger.reconcile', {direction,action,hookId,triggerId,prevTriggerStatus})`（事件名刻意不进 EVENT_TYPES 白名单，零 churn；spec 锁逐字节）。
- 启动+周期：onModuleInit 内 await（有界：健康库 2 小查询；失败 catch→error 不阻断 boot）→ `setInterval(15min, env TRIGGER_RECONCILE_INTERVAL_MS, 0=停周期但启动照跑)` + `.unref()` + tick 吞错（workers.service markStaleWorkersOffline 同款）。spec 锁启动先于首周期（order=['reconcile','interval']）。
- Boot 实测（live，baked 重 build）：空库启动 pass 5ms → 3 孤儿 pass 48ms（A=2 B=1）→ 收敛后重启 2ms（A=0 B=0，live 幂等）；restart→healthy ≤16s（含容器+全 Nest，常驻开销可忽略）。探针：hks_probe_t3a（缺失→tmr_0000000132 pending + re-armed-missing）、hks_probe_t3b（failed→认领替换 tmr_0000000133 pending + re-armed/prevTriggerStatus=failed 告警）、hks_probe_t3c（fired+pending→hook fired + settled-fired）；事件 ev_0000020188/89/90。
- 协作实录：中途 tsc exit 2 + 9 suites 编译红（sibling todo-19 在飞 hook.service.ts：nowMs 先用后声明 + busyRetries 未落 schema），经 git status/mtime 定界为外因，未碰禁区；其 11:32 落地后 tsc 0 + 全量 **123/2822 全绿**（122/2790 基线 + 本 todo 15 + sibling 17）。SIZE_OK 诚实记录：首版单文件 338 pure LOC 超 250 → 拆四文件（service 95/support 88/A 125/B 86）。
- 坑：zsh `echo ===` 触发 `=` 路径展开（todo-8 已记，复犯一次，改 `echo ---`/无前缀）；会话 cwd 保持 server/ 时 evidence 相对路径漂移 → 一律绝对路径。
- 清理收据：hooks/triggers/reconcile 事件探针 0/0/0（db-cleanup.txt），表回 hooks 0 / triggers 26；树 dirty-but-intact，未 commit/stash。
- 证据：`.omo/evidence/trigger-unification/todo-3/`（tsc-baseline/after.txt, jest-baseline.log, jest-after.log, docker-build.log, db-before/orphans-before/orphans-after/cleanup.txt, restart-at.txt, server-reconcile-lines.log）。

## todo-21: 双写退出决策 — 选 (a) v1 永久保留（已确认不删），2026-09-17
- 裁决：**(a)**。decision 10 已改写为终局表述（含裁决日期 + 双前件不成立的依据 + 将来重提需另开 todo），todo 21 勾选并指向 decision 10。零生产代码改动（只碰计划 .md + 证据目录）。
- (b) 不成立的双证据：① `git tag` 为空 + 计划文件 `git log -- <plan>` 为空 + 全树单分支未提交 WIP → todo 1 未独立上线，发布周期数为零；② `分叉|diverg` 全库 grep 仅命中 plan-file 展示提示（tasks.controller:440 / plan-lifecycle.service:74），根本不存在 `sessionActivity` 分叉告警机制 → (b) 的质量前件无从验证。
- veto 存续（F2）：`pendingBySession`（dispatcher:1069）/`activeExecutions`（:1090）存在且被 scanIdleSessions/markSessionIdleDead 实际引用；`isAgentExecuting`（1144-1155）纯内存快路径语义未动；ingress `sessionActivity`（:205）+ `touchSessionActivity`（:241）双写原样保留。
- stale_state 探针（单元级，免 live rebuild）：`worker-dispatcher.spec` + `worker-event.ingress.spec` 297/297（含 todo-7「内存 Map 为空但 DB 有 stale running 行」用例 → DB 仍是 source of truth）。
- 验证：全量 **123/2822 全绿**（与基线逐字一致，`jest-full.log`）；`tsc --noEmit` 基线及计划改后各 exit 0 一次。终局前最后一次 tsc 撞上 sibling todo-20 在飞（`hook.service.ts:915/937` 调尚不存在的 `this.emitTriggerLifecycle`，禁区文件，未碰）→ exit 2，属 todo-3 同款并发 transient，已在 decision.md 如实记录；禁区 `server/src/triggers/**` / `event.constants.ts` 零触碰。
- 坑：bash `workdir: server/` + 相对路径 `".omo/..."` 会写飞（server/.omo 不存在；证据必须用仓库根绝对路径）。另 `npx tsc` 在仓库根会命中错误的 tsc shim（"not the tsc you are looking for"），必须在 server/ 下跑。

## todo-20: trigger 生命周期可观测事件 fired/expired/skipped (2026-09-17)
- 事件名 + 载荷 (`server/src/common/constants/event.constants.ts`, EVENT_TYPES 28→31):
  `trigger.fired` / `trigger.expired` / `trigger.skipped`。payload 五件套
  `{hookId, kind, scopeType, scopeId, ownerInstanceId}` + 按事件附加
  (`fired:{status,fireCount}` / `expired:{status,skipReason,reason}` /
  `skipped:{status:pending,skipReason,busyRetries}`)。scope 沿 hook 归属
  (team/task 直标, 其余 global), 单行发射 (receipt 双发 team+channel 不适用——
  历史只记一次)。
- 发射位 (domain, 非基座, 三理由): (1) 基座 TriggerService 无 RealtimeService
  依赖, 加必填依赖会 churn 全部手工作坊式 `new TriggerService` spec;
  (2) UI 要的是 hook 上下文 (hookId/skipReason), 基座只有 trigger 行;
  (3) poll 每 30s 扫 100 行, domain 侧可精确只在终态/首轮否决发射,
  基座发射控不住 no-op tick 噪音。通用 kind (receipt_nudge 等) 已有各自域事件,
  基座不动。
- 接线: HookService 构造末 `@Optional() @Inject(RealtimeService)` (todo-9
  sidecar 同款, 旧 5 参手工作坊 spec 零改; ChatModule 已 import RealtimeModule,
  无循环依赖)。`emitTriggerLifecycle` best-effort (失败 warn, 行终态照结算;
  reconciler `emitReconcile` 同款语义)。
- skipReason 三路径覆盖 (UI 读 `triggers`+`hooks` 两表, 此前缺两处):
  veto/skip 经 noteBusyRetry (本来就有, 加发射) / timeout-expiry 与
  target-invalid 经 settleHook 统一补写 `skipReason=reason`
  (此前只写 lastError, UI 的 skipReason 列 NULL 即此缺口) /
  expireTaskHooks 批量 updateMany 同加 skipReason (无逐行发射, bulk 有界)。
  busyRetries: busy 路本来就写 (noteBusyRetry increment), 无需加, 只验证。
- 有界规则 (MUST NOT 违项): `trigger.skipped` 仅首轮否决发射
  (noteBusyRetry current==0), 后续同因重排只写列; poll `!quiet`/fail-open
  continue 零发射; all_idle fire 兜底 no-op 零发射; 非 pending 早返零发射
  (stale 不 double-emit, 单测锁定)。
- 死码: 删 `writeSkipReason` (有定义零调用, noteBusyRetry 已取代)。
- markFired 坑 (live 抓到): update 返回的是递增后行, payload 用
  `hook.fireCount` 即终值, `+1` 会 off-by-one (首轮 live payload fireCount:2,
  修后 :1)。
- Live 教训: veto 探针的目标会话必须 `status=running + lastActivityAt=NOW`
  (stale running 行会被 todo-7 空闲扫描先判 failed, 变成 target-invalid 路径;
  首轮 veto 探针即因此走成 expired)。session 恢复原值
  (idle + activity=NULL 原样)。
- 副作用诚实记录: 每次真 wake 派发各落 1 条 `session_idle_scan` 首字 sidecar
  行 (todo-9 机制) + 群镜像消息; 群消息按 id 删, sidecar 行按 todo-9
  先例保留 (合法系统数据, pending 行自收敛为 fired-noop)。
- 套件: 基线 tsc 0 + 123/2822 → 终态 tsc 0 + **123/2831 全绿** (+9 本 todo)。
  证据: `.omo/evidence/trigger-unification/todo-20/`
  (tsc-after/jest-baseline/jest-after/docker-build×2/db-survey/db-watermarks/
  db-probe-insert/db-proof/db-round1-*/db-round2-*/db-cleanup)。

## F1-fix: D12-1 DB-NOW + D14-1 单副本注释 (2026-09-17)

- D12-1 路径: **DB-NOW 实现, 非 plan 修订** — decision 12 可按字面兑现且不
  破坏固定时钟测试要求, 故无修订理由。`fireDue(now?: Date)` 双路径:
  无参=生产 (`$queryRawUnsafe` select + `$executeRawUnsafe` claim, 皆
  `due_at <= NOW(3)`, `now` 取自同库 `SELECT NOW(3)`); 显参=测试缝
  (`fireDueAt`, 原函数体逐字搬迁, 25 个既有用例零改全绿)。
  原子 claim 等价: raw UPDATE 影响行 `=== 1` ⟺ `updateMany.count === 1`;
  NULL 安全等价: 两处 raw WHERE 均带 `` `due_at` IS NOT NULL `` (decision 15)。
  `id` 走 `?` 占位绑定。ticker 改调无参 `fireDue()` (唯一生产入口)。
  选型依据已写进 `fireDue` docblock。
- 证明生产路径真用 DB 时间 (非仅编译过): 新单测断言 emitted SQL 含
  `NOW(3)`+IS NOT NULL 且 `findMany`/`updateMany` **零调用**; live 逐字 SQL
  跑真库: overdue 行命中、NULL 行排除、claim 影响 `1` 后 `0`
  (探针已清, `probe_remaining=0`)。证据:
  `.omo/evidence/trigger-unification/F1-fix/`
  (tsc-after/jest-after/db-live-proof.txt/summary.md)。
- D14-1 注释位置 (`hook.service.ts`, 注释 only, 零行为改动):
  文件头 docblock (单 `server` 副本前提 + leader 选举升级条件) +
  `isTargetBusy` docblock (评估点: veto 只看见本进程)。
- TS 坑: 未注明类型的 `jest.fn(async (sql: string) => …)` 在
  `typeCheckingMode all` 下 `.mock.calls[0][0]` 报 TS2493 (tuple `[]`) →
  注明 `jest.Mock` 即解。
- 套件: 基线 tsc 0 + **123/2831 全绿** → 终态 tsc 0 + **123/2835 全绿**
  (+4 本 fix: DB 时钟/claim=0/行归一/NOW 失败; 零回归, overlap/null/clamp/
  re-arm 旧断言全绿)。树 dirty-but-intact, 未 commit/stash。
