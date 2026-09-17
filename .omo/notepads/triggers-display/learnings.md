# Learnings — triggers-display (plan-adjacent UI/UX gap, trigger-unification follow-up)

## 2026-09-17: display 富化落地

### 地面真值（live DB，决定实现形状）
- `triggers` 91 行：receipt_nudge 22 / session_idle_scan 66 / hook_poll 1 / hook_fire 1 / progression_patrol 1。
- **关键发现**：几乎所有行 `scope_type/scope_id/owner_instance_id` 全 NULL ——归属只在 `payload` 里
  （`teamId/taskId/channelId/receiptId/toInstanceId/fromInstanceId/teamMemberId/sessionId/scope/issueId/hookId`）。
  富化必须以 payload 口径为主、scope 列为辅，否则线上全是"全局/—"。
- 唯一有 scope 列的行是 hook_fire（`scopeType=task, scopeId=t_0000000007, owner=tmm_0000000008`），hook 行经
  `hook.service registerHook` 把 scope/owner 透传进 trigger 行。
- `ChatChannel` 无 name 列 —— channel 展示只能是 `{team名} · 群聊/私聊`（type 映射），不要去查不存在的列。
- `TeamMember.alias`（如 开发者-1）+ `Agent.name/role`（开发者/developer）= ownerLabel 口径
  `别名（role）`；receipt `summary` 已是前 100 字存 TEXT；hook `wakeText` 在 `hooks.wake_text`。

### 实现（4 文件， backward compatible 只加 display）
- `server/src/common/constants/trigger.constants.ts`：+ `TRIGGER_KIND_LABEL`（与 web KIND_LABEL 同值，
  改一处同步另一处；未知 kind 回退原样）。source 映射仍是 `triggerSourceOf` 唯一入口，未建第二名单。
- `server/src/timers/triggers.service.ts`：`findAll` 取页后 `enrichDisplays(rows)`；
  `cancelForUser` 同函数富化单行（终态幂等分支与 update 分支各一次）。
  - 批量：每页固定 7 个 `findMany … where id in […]`（team / chatChannel+team / task+team /
    teamMember+agent / hook / messageReceipt / issue），缺席集合跳过查询，内存 join。
    **查询计数/列表调用：count + findMany（1 个 $transaction）+ ≤7 = ≤9，无 N+1。**
  - 缺失 delegate（旧 mock）/空集/异常 → `[]` 或整页 `fallbackDisplay`，列表永不 500。
  - 降级：删失引用一律 `rawId（已删除）`（scopeLabel/ownerLabel/description 内嵌），taskLabel 置 null。
  - description：hook 系 → wakeText 折叠空白截 120（无 hookId 用 payload.purpose，无则 kind 标签；
    有 hookId 无行 → `标签 · hookId（已删除）`）；receipt → summary 折叠截 100；
    review → `评审轮次超时 · issue《title》 第N轮`；patrol → `任务《title》巡检`；
    idle 首字 → `会话 <id> 首字超时看门狗`（非首字载荷 → 会话空闲扫描/scope 回退）；未知 kind → kind 原样。
- `web/app/(main)/system/triggers/page.tsx`：`TriggerItem.display?` 可选（老服务端兼容）；
  范围列 = scopeTeam · scopeLabel、归属列 = ownerLabel、每行 + `trigger-desc` 描述行（2 行 clamp）；
  搜索 haystack 纳入 5 个 display 字段；详情抽屉范围/归属读 display 并保留 raw ID 行 + 新增任务/描述行；
  既有 testid/过滤/分页/取消/SSE 全部保留。
- `server/src/timers/triggers.service.spec.ts`：makePrisma 补 7 个 delegate（默认 `[]`）；
  旧 toEqual 扩展 display 期望（`tm_1（已删除）`系 mock 无 team 表的正确行为）；新增 describe ×8。

### 验证数字
- `cd server && npx tsc --noEmit` exit 0（中途修一次 `inIds<T>` 泛型推断：call-site 必须显式类型参，否则 unknown[]）。
- `cd web && npx tsc --noEmit` exit 0；`npm run build` exit 0（`/system/triggers` 5.8kB）。
- `npm run test`（server 全量）：**124 suites / 2880 tests 全绿**（基线 2872 + 本任务 8，无回归、无 flake）。
- Live（baked 重 build 后）：`GET /triggers` 首行 hook_fire 即带
  `T16 docs layout QA task / 电网信号告警优化团队 / 项目经理-1（project_manager）/ wakeText`；
  receipt 行 owner `计划员-1（plan）`、patrol 行 `任务《…》巡检` 皆为 DB 真值。
- Adversarial：探针行（team tm_gone/task t_gone/member tmm_gone/receipt mr_gone）→ 列表 HTTP 200，
  markers 全对；探针已物理删除（`remaining_probes=0`，表回 91 行）。
- Browser（compose :13001，admin，hard-reload）：20 行/共 91，scope/owner 零 raw id（已删除除外），
  描述行全 present，详情抽屉 skipReason（未触发原因）+ 描述渲染，零 JS error，QA 脚本 PASS。
  证据：`.omo/evidence/triggers-display/admin-list.png`、`detail-drawer.png`。

### 团队会话触发 Tab（TeamRightPanel.tsx，READ only）
- **follow-up: YES（小）**：其 `TriggerItem` 无 display 字段，行只渲染 `kind · 状态 + 时间/来源/次数`
  （不展示 scope/owner id，故无 raw-id 灾难，但成员同样看不到"谁/什么事"）。
  同一 GET 已带 display，follow-up 仅需：该文件 `TriggerItem` 加可选 `display` + 行内加
  ownerLabel/描述行（约 10 行 diff，零后端改动）。

### 坑
- QA 脚本放 `/tmp` 会 `Cannot find module 'playwright'` —— 拷进 `web/` 跑（node_modules 解析），跑完即删，
  树无残留。browsers 在 `~/.cache/ms-playwright`，`chromium.launch()` 可用。
- 本任务只碰 4 文件；`agent.constants.ts` 等 worktree 改动系 sibling WIP，未碰、未 commit/stash。

## 2026-09-17 (2)：title/subtitle 打磨 + session→member 解析（raw-id 泄漏 2 处清零）

### 改动（3 文件，查询数 ≤10 保持无 N+1）
- `server/src/timers/triggers.service.ts`：
  - `enrichDisplays` 变 8 个批量 findMany（原 7）：**sessions 先行**（`teamMember` include，Prisma 内部
    批处理 join），解析出的成员 id 合并进 `memberIds`，其余 7 个再并行。鸡生蛋：session 行取到之前
    成员 id 未知，不能进同一轮；页内含 session 时多一轮往返，总查询数仍 ≤10（count+findMany 事务 + 8），无 N+1。
  - `ctx.sessions` 保持扁平 `{id, teamMemberId}`（include 拍平）；members map 是成员展示唯一来源
    （owner 标签 / 会话名共用同一 join：`alias ?? agent.name`，alias 优先、agent 名兜底）。
  - `buildDescription` session_idle_scan：first-token → `<成员> 的会话首字超时看门狗 (s_…)`；
    非首字 → `<成员> 的会话空闲扫描 (s_…)`；会话或成员缺失 → `会话 <id>（已删除） <suffix>`
    （沿用既有 rawId（已删除）降级契约，raw id 保留可追查）；无 sessionId → scope 回退照旧。
- `web/app/(main)/system/triggers/page.tsx`：行标题 = `display.description`（13px 600，单行省略；
  description 缺失回退 `scopeText — kind label`，永不用 id）；raw id 降级为小号 mono 副标题
  （11px JetBrains Mono，`trigger-id` testid 原样保留在 id 元素上）；新增 `trigger-title` testid。
  详情抽屉未动（raw ID 行 + 描述 + 未触发原因全保留）。
- Spec：makePrisma +`session` delegate；enrichedMocks +`s_14→tmm_9`（含 teamMember include 形状）；
  新增 6 测：会话解析 + 批量调用形状、非首字、会话已删、成员缺失、alias 回退 agent 名、多行共享 session N+1；
  既有 patrol/idle 期望更新为解析形；batch 测 +`session.findMany` not-called 断言。

### 验证数字
- `npx tsc --noEmit`：server=0、web=0（改动前后各跑一次）。
- server 全量 jest：**124 suites / 2886 tests 全绿**（基线 2880 + 新增 6，零回归、无 flake）。
- `web npm run build` exit 0（/system/triggers 5.88kB）。
- `docker compose up -d --build server web` 后 Playwright hard-reload（CDP 禁缓存 best-effort，见坑）：
  **16/16 PASS** —— 20 行、标题零 raw id、id 11px mono < 标题 13px、19 条 idle-scan 行全成员名
  （如 `项目经理-1 的会话首字超时看门狗 (s_0000000016)` / `开发者-1 …` / `架构师-1 …`，live DB 真值）、
  探针行 amber 未触发原因块渲染、抽屉描述/未触发原因/raw ID 全对、零 JS error。
- Adversarial：探针行（`tmr_0000999990`，session_idle_scan + 不存在的 `s_probe_gone` + skip_reason）→
  列表 HTTP 200、标题 `会话 s_probe_gone（已删除） 首字超时看门狗`、amber 块 + 抽屉均渲染。
  **探针已物理删除（remaining_probes=0，表回 91 行）**，QA 脚本已删，树无残留。
- 截图：`.omo/evidence/triggers-display/title-subtitle.png`（列表：人话标题 + mono 副标题 + skipReason 块 +
  已删除降级行）、`detail-drawer-polished.png`（抽屉）。
- live DB 0 行带 skip_reason → 列表侧 amber 块证据依赖探针行；抽屉「未触发原因」行恒渲染（空值 `—`）。

### 坑
- `docker compose exec db mysql -e "<多行 INSERT>"` 在本环境不稳（报 1136 column count mismatch，
  同一值列表在 SELECT 下完全正常）—— SQL 写临时文件经 `< file` 管道进容器，避开 quoting 怪癖；
  跑完删临时文件。
- playwright 1.62.1：`cdp.send('Network.setCacheDisabled', {enabled:true})` → "Invalid parameters"
  —— hard-reload 应降级 best-effort（catch 掉）；page.reload 本身（新 JS 上下文）已重置
  TanStack 内存缓存，足够防 stale state。
- QA 过滤正则：已删会话标题形如 `会话 <id>（已删除） <suffix>`（id 不带行尾括号），
  「已解析」正则 `… (s_…)$` 不命中它 —— 需单独分支判已删除形，否则 QA 误报
  （首跑 15/16 即此因，修 filter 后 16/16）。
- 本轮只碰 3 文件（server 2 + web 1）；sibling WIP（platform-mcp / worker / chat / prisma 等 ~20 文件）
  保持未提交、未碰。
