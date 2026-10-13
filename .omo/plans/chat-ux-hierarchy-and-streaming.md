# chat-ux-hierarchy-and-streaming - Work Plan

## TL;DR (For humans)

这份计划把私聊会话的“显示内容太少、太杂、没有层级、过程不折叠、流式不连续”拆成可验证的渲染、身份、信息架构和实时消费改造。它保持现有消息存储模型与 SSE 事件契约，不改群聊过程流/最终消息路由，也不做移动端重做。

核心路径是：先用一条共享身份栏消除每个 process part 重复的头像/作者/时间，再用连续发送者分组、日期分隔、安静的 system 行和三级字号建立阅读层级；同时补用户状态、人类缩写、角色色主题化、未知 part 可见性和状态行容器。对低优先级过程内容提供折叠，但 error/aborted 默认保持可见。

流式部分不把“加动画”当作修复：先用真实 opencode serve 会话按 500ms 轮询 `GET /session/{id}/message`，确认同一 text part 是否真的原地增长。只有 C0=PASS 才修改 worker 的 `MessageDeltaTracker`，并同步 server 侧按 part id 合并增量，避免同一 part 重复落入 parts；无论 C0 结果如何，私聊页面都接入 `onMessagePartDelta` 的选中频道滚动门控，并补 DM 轮询兜底。群聊 delta 路由明确保持不变。

执行规模为 14 个实施 todo + 5 个最终验证 todo；web 改动前须阅读 `web/node_modules/next/dist/docs/` 相关指南，测试采用 tests-after、现有 Playwright/server/worker Jest、`scripts/gate.sh` 和真实私聊验收。计划不授权规划会话执行代码，实施必须由独立 `$ulw-execute` worker 启动。

## Scope

### 目标

在不改变消息存储模型、SSE 事件契约或群聊路由契约的前提下，让私聊会话「信息更全、层次更清、噪音更少、过程可折叠」，并让 agent 回复按实际可获得的增量持续可见。

### Scope IN（全部必做）

1. **A 档参数**：正文折叠阈值 800 字符/10 行、tool I/O 展示摘录 2000 字符、thinking 摘录 200 字符；正文 14px、身份 12px semibold、元信息 11px。
2. **B1 共享身份栏**：`MsgParts` 提取一条共享身份行，thinking/tool/error/unknown part 降级为附属行；最终正文和附件复用同一身份行，不重复渲染。
3. **B2 连续消息分组**：同一频道内相同 `senderType + senderId`、间隔不超过 5 分钟的连续 agent 消息复用身份栏；跨日、跨发送者或 user/system 消息不合并。
4. **B3 日期分隔**：按 `createdAt` 在跨天处插入日期分隔条。
5. **B4 system 消息降噪**：system 行与正文流使用不同的容器、对比度和间距。
6. **B5/B9 角色名与 author 并列及安全兜底**：有 author 时同时展示角色标签；无法解析 author 时回落到角色标签，不显示裸 `a_xxx`/`tmm_xxx`/`ta_xxx`。
7. **B6 未知 part 不再静默丢弃**：`step-start`/`step-finish`/`patch`/未知类型以默认收起的诊断行展示，并标注 part 类型。
8. **B7 用户消息状态标记**：`ChatBubble` 增加可选 status，user 消息显示 sending/sent/failed 状态。
9. **B8 头像显示人名缩写**：聊天链路传递 `initials`；同一角色的不同成员不能都显示同一个角色字母。
10. **B10 角色色主题化**：`roles`/`roleText` 统一引用 `globals.css` 的 `--color-role-*`，删除硬编码角色 hex，light/dark 跟随主题。
11. **B11 折叠策略补齐**：长 process、tool I/O、thinking、unknown diagnostic、附件详情默认收起；error/aborted 的标题和摘要始终可见，超长 detail 可折叠但默认展开。
12. **B12 `session-status` 容器**：status 行获得与 LoadingIndicator 一致的容器；system 消息不再吞掉 `time` prop。
13. **C0 实机门禁**：触发真实私聊生成，按 500ms 轮询 opencode `GET /session/{id}/message`，记录同一 assistant text part 的长度序列和 `step-finish`，判定 C0=PASS/FAIL。
14. **C1 worker/server delta 语义（仅 C0=PASS）**：同一 part id 的 text 原地增长时发送该 part 的最新完整快照，server ingress 按 part id 替换而不是追加重复 part；保持现有 500ms 轮询。
15. **C2 页面 delta 消费**：页面传入 `onMessagePartDelta`，只对当前选中的私聊频道执行底部滚动，避免 team scope 的其他频道事件扰动当前列表；DM 查询补 30s 轮询兜底，并在首个 delta 早于 REST cache 时触发一次 refetch。
16. **测试与实机验收**：现有 web Playwright、server/worker Jest、`scripts/gate.sh`、结构 testid 基线和真实私聊人工验收。

### Scope OUT（Must NOT-Have，逐条禁止）

1. **不改 SSE 协议**：`event.constants.ts` 的 `CHAT_MESSAGE_NEW` / `MESSAGE_PART_DELTA` 名称、payload 顶层形状和 `middleware.ts` 透传不动。
2. **不改消息存储模型**：不新增列、不加迁移、不改 `status` 枚举（`sending/sent/pending/processing/completed/failed`）。
3. **不改群聊 delta 路由或群聊最终消息契约**：`worker-event.ingress.ts:570-579` 的群聊过程落私聊/内部频道、群聊最终回复直发 MCP 的行为保持不变；不得为“全做”擅自增加群聊 delta。
4. **不引入新依赖**：不装流式渲染库、不上虚拟列表、不增加 web Jest runner；web 测试使用已声明的 Playwright `lib-unit`/e2e 项目。
5. **不做移动端适配**：`globals.css:37-41` 的 `overflow-x:hidden` 与外壳断点属于另一条计划。
6. **不改群聊历史分页逻辑**，不删除或重建已有消息数据。
7. **不在 C0 结论出来前改 C1**；C0=FAIL 时必须保留“未实现 token-level streaming”的事实，不得用前端动画冒充。
8. **不默认折叠 error/aborted**；错误和中断是高优先级状态。
9. **不触碰既有脏工作树**：`.omo/boulder.json`、`.omo/ulw-execute/ledger.jsonl`、`.omo/evidence/**` 中非本计划文件、`.opencode/opencode.json` 等；不执行会覆盖它们的 `git checkout`。
10. **不使用 mutating lint**：不运行 `npm run lint` 或任何 `--fix` 入口；只运行 `lint:check`。
11. **不在 web 产品代码编辑前跳过 Next.js 本地文档**：`web/AGENTS.md` 要求先读 `web/node_modules/next/dist/docs/` 中与改动相关的指南。

## Verification strategy

### 测试策略与可运行门

采用 **tests-after**：每个 todo 在实现后立即补对应断言，并由执行 agent 运行 happy/failure 两类 QA；不假设不存在的 web Jest runner。

```bash
# web 类型与 check-only lint（不运行 npm run lint / --fix）
cd web && npx tsc --noEmit && npx eslint src/components/chat src/components/ui 'app/(main)/teams/[id]/session'

# web 纯逻辑单测（若 todo 提取了日期/分组/身份解析纯函数，走现有 Playwright lib-unit）
cd web && npx playwright test lib/ --project=lib-unit

# 私聊与会话页面端到端；前置：完整 dev stack 已监听 localhost:3001，系统 chrome 可用
cd web && npx playwright test pages.spec.ts session-unification.spec.ts

# worker/server 变更对应的现有 Jest
(cd worker && npm run typecheck && npm test)
(cd server && npm run lint:check && npm test)

# 全仓门（不带 --with-playwright；11 步）
bash scripts/gate.sh
```

`web/playwright.config.ts:6-8,25-34,36-116` 明确不自动启动 web server；执行 Playwright 前必须确认 `localhost:3001` 已在监听。`web/lib` 的纯 spec 由 `lib-unit` 项目执行，不能假设或临时安装 web Jest runner。

### 消息结构断言门（B1/B2/B6 必过）

在任何聊天渲染改动前记录基线：

```bash
grep -rhoE 'data-testid="[^"]+"' web/src/components/chat/ web/src/components/ui/chat-bubble.tsx web/src/components/ui/agent-avatar.tsx | sort -u \
  > .omo/evidence/chat-ux-hierarchy-and-streaming/chat-testids-before.txt
```

改动后再次生成 `chat-testids-after.txt`，逐项 diff；既有 testid 不得消失。共享身份栏可以改变同一 testid 的出现次数，但 `agent-avatar`、`chat-bubble-author`、`chat-bubble`、`chat-bubble-content`、`chat-bubble-toggle`、`msg-thinking`、`msg-tool`、`msg-error`、`msg-aborted`、`msg-streaming` 等依赖项必须仍可定位。

B1 的额外断言：构造含 reasoning + tool + text 的单条 agent 消息，身份栏的 `agent-avatar`、`chat-bubble-author` 和时间元素各只出现 1 次；B2 的额外断言：同发送者连续 3 条时第 2/3 条不重复身份栏，不同发送者或跨日时不折叠。

### C0 实机验证门（只阻塞 C1）

C0 必须在真实 worker/opencode serve 会话中完成，不能用历史 SSE 文件或静态代码推断：

1. 通过现有私聊触发一次 agent 回复；从 `agent.loading`/`session.updated` 事件或 worker capability 日志取得 `SERVE_BASE_URL` 与 opencode `SESSION_ID`。`SERVE_BASE_URL` 使用 `worker/src/driver/v1-driver.ts:236-244,313-317` 的实际 base URL；密码按 `OPENCODE_SERVER_PASSWORD` 配置使用 Basic Auth `opencode:<password>`。
2. 在 worker 可访问该 base URL 的网络位置先执行 `mkdir -p .omo/evidence/chat-ux-hierarchy-and-streaming`，再创建一次临时、未提交的 capture 脚本 `$TMPDIR/c0-serve-incremental.mjs`。脚本必须以 500ms 间隔请求 `GET $SERVE_BASE_URL/session/$SESSION_ID/message`，最多 120 次；每次把 assistant message id、同一 `type=text` part 的 `id`、文本长度、是否出现 `step-finish` 追加到输出。
3. 用实际环境变量执行：`SERVE_BASE_URL=... SESSION_ID=... OPENCODE_SERVER_PASSWORD=... node "$TMPDIR/c0-serve-incremental.mjs" > .omo/evidence/chat-ux-hierarchy-and-streaming/c0-serve-incremental.txt`。脚本不得打印密码或 Authorization header；运行后删除临时脚本。
4. PASS 判据：同一 text part id 的长度序列至少出现一次严格递增，且递增发生在 `step-finish` 之前。FAIL 判据：text part 首次出现即完整、无中间增长，或 60s 内没有可判定样本。证据文件必须明确写 `C0=PASS` 或 `C0=FAIL`。

C0=FAIL 时只跳过 todo 13（C1）；todo 14（页面 delta 消费、滚动门控、DM 轮询兜底）和所有 UI todo 仍必须执行。不得因 C0=FAIL 删除或篡改 C0 证据。

### 环境与脏工作树约束

- 真实私聊 e2e 依赖 worker 活引擎；`session-unification` 项目依赖 `setup`（`playwright.config.ts:112-116`），不能把它误称为 `engine-dependent`。
- 每次 e2e 前记录 `shasum .omo/evidence/phase5-t9-playwright.json`；`web/playwright.config.ts:25-27` 的 JSON reporter 必然会重写该报告，该文件只做前后 hash 记录，不视为覆盖其他脏改动；只清理本次运行新生成的 `web/test-results`/`web/playwright-report`，不得用路径级 checkout 恢复 evidence 文件而覆盖已有脏改动。
- B2/B3 的跨天数据用 API/fixture 构造；本地清理使用已存在的 `DELETE /tasks/:id`，不得用 `SET FOREIGN_KEY_CHECKS=0` 绕过外键。
- 任何 web 产品代码编辑前先读取 `web/node_modules/next/dist/docs/` 中与组件/客户端状态/测试相关的指南；若指南与现有代码冲突，停止并在证据中记录，不凭旧版 Next 记忆继续。

## Execution strategy

**依赖顺序**：C0 与页面级 C2、A1–A3 可并行；A4 在 A1–A3 后执行；B1 必须在 B2、B6、B7/B8、B11 前执行，因为这些 todo 依赖共享身份栏/同一渲染树；B2 与 B3/B4 共享 `session/page.tsx`，必须串行；B10 在 A4 后执行；C1 是唯一依赖 C0 的实施项，C0=FAIL 时跳过 C1 但继续 C2。

**波次划分**（实施与测试同一 todo；同波内仍按依赖顺序执行）：

- **Wave 0 · 门禁与独立页面消费**：C0 实机 serve 观测、C2 页面 delta 消费/选中频道滚动/DM 轮询兜底、A1–A3 三处密度阈值。C0 不阻塞 C2。
- **Wave 1 · 身份与阅读层级**：A4 消息字号 token、B1 共享身份栏、B2 连续发送者分组、B3/B4 日期与 system 降噪、B5/B9 author/role、B12 status 容器。该波共享多个 web 文件，必须按上述依赖串行。
- **Wave 2 · 细节与可访问性**：B6 未知 part 可见但收起、B7/B8 用户状态与人名缩写、B10 角色色主题化、B11 低优先级折叠策略。
- **Wave 3 · 条件传输修复**：C1 `MessageDeltaTracker` + server part merge，仅当 C0=PASS；C0=FAIL 时记录降级并跳过，不得为凑齐波次改做其他范围。
- **Final wave**：F1–F5 全部并行审查，全部通过才可交付。

**并行约束**：Wave 0 的 C0（worker 观测）、C2（web session page）和 A1–A3（chat 组件）文件面不重叠，可并行；Wave 1/2 共享 `chat-bubble.tsx`、`msg-parts.tsx`、`tokens.ts`、`session/page.tsx` 的 todo 必须按依赖串行；C1 只在 C0 证据为 PASS 后启动，且不得与 C0 共享运行中的 serve 进程。

**失败回退**：任一结构门或 testid 基线门不过即停；B1 若导致既有 testid 消失，回退 B1 并修正实现，不修改测试迁就契约。C0=FAIL 只回退/跳过 C1，不回退 UI 与 C2，且必须在 F5 明确记录。

## Todos

- [x] 1. **C0 实机验证：确认 opencode serve 是否暴露可续传 text part**（结论：FAIL；C1 按计划跳过）（只阻塞 C1）
  - References: `worker/src/driver/v1-driver.ts:7-18,236-244,313-317`（实际 `GET /session/{id}/message` 契约与 base URL）；`worker/src/driver/prompt-await.ts:474-476`（500ms 轮询入口）；`worker/src/exec/exec-server.ts:1526-1549`（delta 发送）；`.omo/evidence/dm-stream-debug/frames-private-channel.txt`（历史证据，仅作对照，不得当作 C0 结论）。
  - Acceptance: 按 Verification strategy 创建并运行临时 capture 脚本；证据 `.omo/evidence/chat-ux-hierarchy-and-streaming/c0-serve-incremental.txt` 至少含 3 个样本、同一 text part id 的长度序列、`step-finish` 时间和明确的 `C0=PASS|FAIL`；不改产品代码、不提交脚本。
  - QA happy: `SERVE_BASE_URL=... SESSION_ID=... OPENCODE_SERVER_PASSWORD=... node "$TMPDIR/c0-serve-incremental.mjs" > .omo/evidence/chat-ux-hierarchy-and-streaming/c0-serve-incremental.txt && grep -q '^C0=PASS$' .omo/evidence/chat-ux-hierarchy-and-streaming/c0-serve-incremental.txt` → exit 0；证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/c0-serve-incremental.txt`。
  - QA failure: 同一 part id 长度序列恒定、首次即完整或 60s 无判定样本 → 脚本仍须以 `C0=FAIL` 退出并保留原始样本；在 F5 记录 C1 跳过，不得伪造 PASS。证据：同一 C0 文件。
  - Recommended task executor category: deep-low — 需要真实运行时证据，但只验证一个明确的外部端点契约。
  - Commit: 无（纯验证，不改代码）。

- [x] 2. **A1–A3 放宽正文、tool I/O、thinking 三个密度阈值**（commit `31ff11f`）
  - References: `web/src/components/ui/chat-bubble.tsx:117-120,238-277`（正文 360 字符/6 行与 toggle）；`web/src/components/chat/msg-parts.tsx:51-69`（tool I/O 500 字符）；`web/src/components/chat/msg-thinking.tsx:36-42,96-112`（thinking 60 字符）。
  - Acceptance: 正文阈值为 800 字符、`WebkitLineClamp:10`/`maxHeight` 与 10 行一致；tool 折叠态最多展示 2000 字符，thinking 折叠摘录 200 字符，展开态展示完整的 2000 字符摘录（原始输出超过 2000 时第 2001 字符起不进入 DOM）；`WebkitLineClamp` 仍只存在于 `chat-bubble.tsx:242` 一处；`chat-bubble-toggle` 文案/testid 不变。
  - QA happy: `cd web && npx tsc --noEmit && npx playwright test pages.spec.ts session-unification.spec.ts` → exit 0；用长正文/长 tool 输出/长 thinking fixture 断言折叠行数、2000/200 摘录、tool 展开后第 2001 字符起不出现在 DOM。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-2-density.txt`。
  - QA failure: `grep -c 'WebkitLineClamp' web/src/components/ui/chat-bubble.tsx` 必须为 1；900 字符正文必须出现 toggle 且折叠态为 10 行；3000 字符 tool 输出必须显示前 2000 字符且第 2001 字符起不出现。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-2-density-failure.txt`。
  - Recommended task executor category: visual-engineering — 改动直接影响聊天可读性和 DOM 呈现。
  - Commit: `feat(chat): 放宽正文、tool I/O 与 thinking 密度阈值`

- [x] 3. **A4 建立消息专用三级字号并拆出时间元信息**（commit `438a0b6`）
  - References: `web/src/theme/tokens.ts:92-100`（现有全局字号无 14px 档）；`web/src/components/ui/chat-bubble.tsx:79-91,151-187`（正文、身份、时间戳共用 token）。
  - Acceptance: 新增消息作用域 token：正文 14px、身份 12px semibold、元信息 11px；不修改全局 `fontSize.md=13` 以免影响全站；时间戳从作者 span 拆成独立元信息 span，字号/颜色/布局不再与身份名完全相同。
  - QA happy: `cd web && npx tsc --noEmit && npx eslint src/theme/tokens.ts src/components/ui/chat-bubble.tsx` → exit 0；渲染 DOM 断言正文为 14、身份为 12/600、元信息为 11。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-3-type-scale.txt`。
  - QA failure: 检查 `tokens.ts` 未把全局 `fontSize.md` 改成 14；检查作者与时间戳的 style 不再同时拥有相同 `fontSize` 和 `color`。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-3-type-scale-failure.txt`。
  - Recommended task executor category: visual-engineering — 需要在共享 token 与消息组件中建立视觉层级。
  - Commit: `feat(chat): 建立正文、身份、元信息三级字号`

- [x] 4. **B1 提取共享消息身份栏，process part 降级为附属行**（commit `e750e32`）
  - References: `web/src/components/chat/msg-parts.tsx:114-215`（顶层容器、process 分发、最终 ChatBubble）；`web/src/components/chat/msg-thinking.tsx:35-119`、`msg-tool.tsx:48-164`、`msg-error.tsx:44-132`、`msg-aborted.tsx:32-66`（各 part 当前自带身份）；`web/src/components/ui/chat-bubble.tsx:117-188`（现有身份行）。
  - Acceptance: 在 `web/src/components/ui/message-identity.tsx` 提取可复用身份组件并由 `ui/index.ts` 导出；一条 agent 消息只渲染 1 个 avatar、1 个作者行、1 个时间；process 卡片保留工具状态/内容但移除重复身份；最终正文/附件通过 `showIdentity={false}` 或等价明确 props 避免 `ChatBubble` 二次身份；aborted 分支同样只显示一次身份；既有 testid 不消失。
  - QA happy: `cd web && npx tsc --noEmit` → exit 0；结构门 diff 无 testid 消失；含 reasoning+tool+text 的 3-part fixture 中 `agent-avatar`、`chat-bubble-author`、时间元素各计数 1。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-4-identity-rail.txt`。
  - QA failure: 注入 3 个 process parts，若任一身份 testid/可见作者/时间计数 >1，或既有 testid 消失，则失败并回退本 todo 的实现，不修改测试契约。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-4-identity-rail-failure.txt`。
  - Recommended task executor category: visual-engineering — 需要跨多个消息组件统一身份层级且保持渲染契约。
  - Commit: `refactor(chat): 提取共享消息身份栏并移除 process 重复身份`

- [x] 5. **B2 连续同发送者消息分组并复用身份栏**（commit `cf08cf9`）
  - References: `web/app/(main)/teams/[id]/session/page.tsx:1142-1149,1289-1347`（当前数据源选择、`messages.map` 与消息分支）；`RealtimeChatMessage.senderId/senderType/createdAt`（`web/hooks/use-realtime.ts:49-73`）。
  - Acceptance: 列表 map 接收 index/previous message；仅当当前与上一条同 `senderType === agent`、同非空 `senderId`、时间差 ≤5 分钟、未跨日时标记 grouped 并省略重复身份栏；user/system、跨发送者、超时、跨日一律独立渲染；不改变消息顺序和数据源。
  - QA happy: `cd web && npx tsc --noEmit` → exit 0；Playwright/fixture 断言同 agent 连续 3 条的第 2/3 条无 `agent-avatar`/`chat-bubble-author`，交替 sender 和跨日 fixture 均保留身份。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-5-grouping.txt`。
  - QA failure: 不同 sender、user/system 或超过 5 分钟的相邻消息若被错误折叠，测试失败；同 sender 连续消息若仍重复身份，测试失败。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-5-grouping-failure.txt`。
  - Recommended task executor category: visual-engineering — 改动列表布局与身份显示规则。
  - Commit: `feat(chat): 连续同发送者消息复用身份栏`

- [x] 6. **B3 跨天日期分隔与 B4 system 行视觉降噪**（commit `67e7442`）
  - References: `web/app/(main)/teams/[id]/session/page.tsx:90-96`（仅 `HH:MM`）、`:1278-1288`（列表容器）、`:1345-1347`（system 内联分支）。
  - Acceptance: 用 `createdAt` 的本地日期生成 `chat-date-separator`；仅在日期键变化时插入，分隔条可 sticky 且不改变消息顺序；system 消息使用独立低对比度居中容器/间距，与 agent/user 正文有非颜色区隔；保留 `chat-bubble[data-type=system]` 兼容 testid。
  - QA happy: `cd web && npx playwright test pages.spec.ts session-unification.spec.ts` → exit 0；跨日 fixture 出现日期 testid，system 与正文 DOM 容器/对比度不同。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-6-date-system.txt`。
  - QA failure: 单日列表不得出现多余日期分隔；system 行不得与正文共用同一容器/字号节奏（正文为 14px）；缺 `createdAt` 的消息不得使渲染崩溃。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-6-date-system-failure.txt`。
  - Recommended task executor category: visual-engineering — 需要调整列表信息架构和视觉分隔。
  - Commit: `feat(chat): 增加跨天日期分隔并降低 system 行噪音`

- [x] 7. **B5 角色名与 author 并列，B9 禁止 author 裸 id 兜底**（commit `9674e4c`）
  - References: `web/src/components/ui/chat-bubble.tsx:151-188`（`author ?? roleTheme.label` 与时间 span）；`web/app/(main)/teams/[id]/session/page.tsx:418-443`（agent/instance/team-member 映射）；`:1292-1295`（当前 role/author 兜底）。
  - Acceptance: author 解析成功时同时显示 author 与角色标签，二者相同则去重；解析失败时只显示角色标签，不把 `senderId`、team member id 或 instance id 放入可见文本；保留 external/@you 徽标；`MessageIdentity` 接收已解析的 display author，不自行访问业务映射。
  - QA happy: `cd web && npx tsc --noEmit` → exit 0；agent 名称 fixture 断言 author+role 同时出现；未映射 sender fixture 断言 DOM 不匹配 `/a_[0-9a-z]+|tmm_[0-9a-z]+|ta_[0-9a-z]+/`。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-7-author-role.txt`。
  - QA failure: 未映射 author 仍显示 id、author 与 role 被错误二选一、或 external/@你 徽标丢失均失败。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-7-author-role-failure.txt`。
  - Recommended task executor category: visual-engineering — 改动身份解析和可见层级展示。
  - Commit: `feat(chat): 并列展示 author 与角色并隐藏裸 id 兜底`

- [x] 8. **B12 为 `session-status` 增加容器并恢复 system 消息时间**（commit `1433275`）
  - References: `web/app/(main)/teams/[id]/session/page.tsx:1350-1356`（LoadingIndicator/MsgError/session-status 追加行）；`web/src/components/ui/chat-bubble.tsx:93-115`（system 分支提前 return，当前吞掉 time）。
  - Acceptance: `session-status` 使用与 LoadingIndicator 一致的可识别容器和 testid；system 分支在 pill 内以元信息样式显示传入的 `time`；不把 status 行混入消息数组、不改变 loading/error 清理逻辑。
  - QA happy: `cd web && npx tsc --noEmit` → exit 0；transient status fixture 断言容器存在且 system DOM 含时间文本。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-8-status-container.txt`。
  - QA failure: `session-status` 仍为无容器裸文本，或 system 消息传入时间却不在 DOM 中，测试失败。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-8-status-container-failure.txt`。
  - Recommended task executor category: quick — 局部修复两个已定位的渲染遗漏。
  - Commit: `fix(chat): 为 session-status 补容器并保留 system 时间`

- [x] 9. **B6 未知 part 降级为默认收起、可展开的诊断行**（commit `129b761`）
  - References: `web/src/components/chat/msg-parts.tsx:114-170`（process 分发，`:169` 未知类型 return null）；`PartShape.type`（`:33-49`）。
  - Acceptance: 新增 `msg-unknown-part` 渲染分支，显示安全的 part 类型名和 `data-part-type`；默认收起，展开显示受限长度的 JSON 摘要；不得把未知 payload 原样无限渲染或影响已知 text/reasoning/tool/error 分支。
  - QA happy: `cd web && npx tsc --noEmit` → exit 0；通过 API fixture 注入 `patch`/未知 part，断言节点存在、默认收起、展开有摘要。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-9-unknown-part.txt`。
  - QA failure: 注入未知 part 后列表仍无任何节点、默认展开导致噪音、或超长 payload 无上限，均失败。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-9-unknown-part-failure.txt`。
  - Recommended task executor category: visual-engineering — 需要新增低噪音的过程消息呈现。
  - Commit: `fix(chat): 未知 part 默认可收起展示而非静默丢弃`

- [x] 10. **B7 增加用户消息状态标记，B8 传递人名缩写**（commit `1bef2e0`）
  - References: `web/src/components/ui/chat-bubble.tsx:39-51,74-140`（props、user 分支无身份）；`web/src/components/ui/agent-avatar.tsx:16-24,31-71`（initials 缺省回退角色字母）；`web/hooks/use-realtime.ts:58-73`（`status`/`senderId`）；`web/app/(main)/teams/[id]/session/page.tsx:418-443`（名称映射）。
  - Acceptance: `ChatBubble` 新增可选 `status` 与 `initials`；user 消息在 `sending/sent/failed` 时显示不遮挡正文的轻量状态标记；agent 身份缩写从已解析 name/alias 生成（Unicode 安全的首字符/首两个拉丁字符），无法解析才回退角色字母；不向用户暴露内部 id。
  - QA happy: `cd web && npx tsc --noEmit` → exit 0；状态 fixture 覆盖 sending/sent/failed；两个同角色不同名称的 agent 头像文本不同且可见名称正确。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-10-status-initials.txt`。
  - QA failure: failed user 消息没有失败标记、同角色不同成员仍都显示同一个字母、或头像/状态标记改变正文布局，测试失败。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-10-status-initials-failure.txt`。
  - Recommended task executor category: visual-engineering — 同时涉及消息状态和身份头像呈现。
  - Commit: `feat(chat): 增加用户消息状态并显示成员人名缩写`

- [x] 11. **B10 角色色改用 CSS 变量并通过 light/dark 验证**（commit `9fcbf85`）
  - References: `web/src/theme/tokens.ts:8-39`（`roles`/`roleText` 硬编码 hex）；`web/app/globals.css:151-175,203-225`（已有 `--color-role-*` light/dark 变量）；`web/src/components/ui/chat-bubble.tsx:151-165`、`agent-avatar.tsx:41-63`（角色色消费者）。
  - Acceptance: 六个现有 `RoleKey` 的 `roles.color/bg/border` 与 `roleText` 全部引用对应 `--color-role-*` CSS 变量；不新增全局第二套角色色源；未知角色仍安全回退 developer；light/dark 切换后身份文字、头像底色和边框随变量变化。
  - QA happy: `cd web && npx tsc --noEmit && npx playwright test dark-mode-role-warning.spec.ts --project=engine-dependent` → exit 0；对比 computed style 与 CSS 变量值。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-11-role-theme.txt`。
  - QA failure: `grep` 仍命中 `tokens.ts:19-39` 的角色硬编码 hex，或切换 `.dark` 后 computed role color/bg/border 不等于变量解析值，失败。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-11-role-theme-failure.txt`。
  - Recommended task executor category: visual-engineering — 主题 token 变化需用真实 dark-mode 页面验收。
  - Commit: `refactor(theme): 角色色统一走 light/dark CSS 变量`

- [x] 12. **B11 完成低优先级折叠策略并保护 error/aborted 可见性**（commit `b27f4c7`）
  - References: 已收起过程：`msg-thinking.tsx:35-42,68-119`、`msg-tool.tsx:48-164`；未收起的低优先级详情：`msg-parts.tsx:169-206`、`chat-bubble.tsx:280-284`；高优先级状态：`msg-error.tsx:44-132`、`msg-aborted.tsx:32-66`。
  - Acceptance: thinking/tool/unknown diagnostic/长附件详情默认可收起并可展开；主正文、流式正文、system 行不做默认折叠；error/aborted 的标题、状态和摘要始终可见，超长 detail 可以提供 toggle 但默认展开；不隐藏 retry/quota/action 控件。
  - QA happy: `cd web && npx tsc --noEmit` → exit 0；为 process、tool、unknown、附件、error、aborted、streaming、system 分别注入长内容，断言初始状态符合上述矩阵并能展开/收起非高优先级详情。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-12-collapse-policy.txt`。
  - QA failure: error/aborted 默认不可见、retry/quota action 丢失、streaming/system 正文被默认折叠、或 process/tool 无 toggle，均失败。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-12-collapse-policy-failure.txt`。
  - Recommended task executor category: visual-engineering — 需要在多个过程/状态组件中统一可发现性与优先级。
  - Commit: `feat(chat): 统一低优先级折叠并保持错误中断可见`

- [x] 13. **C1 条件实施：修正 MessageDeltaTracker 与 server part merge 的增量语义**（skipped：C0=FAIL，详见 `.omo/evidence/chat-ux-hierarchy-and-streaming/c0-serve-incremental.txt`）
  - References: worker `worker/src/driver/prompt-await.ts:599-631`（当前 Set 首次即终）；`worker/src/driver/prompt-await.spec.ts:919-1001`（现有去重契约）；`worker/src/exec/exec-server.ts:1535-1549`（发送 parts）；server `server/src/workers/worker-event.ingress.ts:590-641`（当前 `oldParts + kept` 会追加重复 id）；`server/src/chat/message-parts.ts:13-35`（normalize/concat 工具）；`server/src/workers/worker-event.ingress.spec.ts:173-263`（delta 落库/广播测试）。
  - Acceptance: 对有稳定 `part.id` 的 text part，tracker 记录上次完整文本；当同一 part 增长时发送该 part 的最新完整快照；server ingress 按 part id 替换已有 part，不能追加第二个同 id part；无 id part 保留现有 append-only fallback；reasoning/tool/step-finish 已知行为不回归；500ms poll 不变；`delta` 事件名与顶层 payload 不变。
  - QA happy: `cd worker && npm run typecheck && npm test -- prompt-await.spec.ts && npm test` → exit 0；`cd server && npm run lint:check && npm test -- worker-event.ingress.spec.ts && npm test` → exit 0；同一 text part 两次采样应产生首次快照和更新快照，并最终 `concatText` 等于完整 serve 文本。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-13-delta-semantics.txt`。
  - QA failure: tracker 仍把同 part 第二次 growth 丢弃，或 server `content.parts` 出现两个相同 `id`，或 `content.text` 重复/缺字，均失败；C0=FAIL 时本 todo 标记 skipped，不产生 commit。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-13-delta-semantics-failure.txt`。
  - Recommended task executor category: deep-high — 这是跨 worker/server 的增量契约修改，必须同时锁定去重、合并和最终文本一致性。
  - Commit: `fix(stream): 同一 text part 增长按 part id 增量合并且不重复落库`

- [x] 14. **C2 页面消费 delta、限制滚动到当前私聊、补 DM 轮询兜底**（commits `8092b16` + `a6139ec`；两 commit 原因见 ledger）
  - References: `web/hooks/use-realtime.ts:278,305,359-364`（已有 `onMessagePartDelta` 回调）；`web/app/(main)/teams/[id]/session/page.tsx:260-275`（DM query 无 interval）、`:687-693`（页面只传 onMessage、滚动无条件）；`web/hooks/use-sse.ts:95-110`（team scope 可能放行其他 channel message）。
  - Acceptance: 页面传 `onMessagePartDelta`；定义当前可见频道为 `channelId`（group）或 `activePrivateId`（private），仅消息/delta 的 `channelId` 命中当前频道时滚动；其他频道事件仍执行 unread/状态收敛但不滚动；若 delta 到达时目标 query cache 尚无数据，触发一次 `privateMessagesQuery.refetch()`；DM query 设置 30s `refetchInterval`；不改变 `upsertMessage` 的终态优先规则。
  - QA happy: `cd web && npx tsc --noEmit && npx playwright test pages.spec.ts session-unification.spec.ts` → exit 0；模拟当前私聊 delta 可见并滚动，模拟另一私聊 delta 不滚动但 unread 状态正确，验证 DM query 有 30s interval。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-14-page-delta.txt`。
  - QA failure: 未选中频道事件导致当前列表 scrollTop 改变、首个 delta 因 cache 为空永久丢失、DM query 没有 interval，或终态消息被旧 delta 覆盖，均失败。证据：`.omo/evidence/chat-ux-hierarchy-and-streaming/task-14-page-delta-failure.txt`。
  - Recommended task executor category: visual-engineering — 页面状态与 SSE 消费共同决定用户看到的内容和滚动行为。
  - Commit: `feat(chat): 私聊按选中频道消费 delta 并补轮询兜底`

## Final verification wave

- [x] F1. **结构与计划合规审计**：核对所有 implementation rows 均为 column-zero `- [ ] N.`、所有最终 rows 为 `- [ ] F<n>.`；每个 implementation row 有 References/Acceptance/QA happy/QA failure，且 QA happy/QA failure 内含证据路径，并有 Recommended category/Commit；testid before/after 无消失；无 task-id 重复。
  - Recommended task executor category: unspecified-high — 需要独立审计整份计划与结构门。
  - Evidence: `.omo/evidence/chat-ux-hierarchy-and-streaming/final-f1-plan-structure.txt`。

- [x] F2. **全仓 gate**：`bash scripts/gate.sh` → `GATE GREEN`；server/worker/web 的 check-only lint、测试和 build 全部通过；不得用 `npm run lint`。
  - Recommended task executor category: unspecified-high — 这是跨 package 的最终质量门。
  - Evidence: `.omo/evidence/chat-ux-hierarchy-and-streaming/final-f2-gate.txt`。

- [x] F3. **Playwright 与视觉行为验收**：在 `localhost:3001` 活栈上运行 `cd web && npx playwright test` → 不低于基线 125/125；重点检查长消息、同 sender 分组、跨天日期、system/error/aborted、用户状态、头像缩写、当前/非当前频道滚动。
  - Recommended task executor category: visual-engineering — 必须在真实浏览器和真实私聊流上确认呈现与滚动。
  - Evidence: `.omo/evidence/chat-ux-hierarchy-and-streaming/final-f3-playwright.txt`。

- [x] F4. **真实私聊人工验收**：执行一次有 reasoning/tool/text 的私聊回复和一次长回复；确认身份只出现一次、长内容按阈值折叠/展开、error/aborted 可见、日期/分组正确、delta 在当前频道实时更新；检查 console 无新增未处理异常。
  - Recommended task executor category: visual-engineering — 关注实际使用感受和动态状态，而非只看静态断言。
  - Evidence: `.omo/evidence/chat-ux-hierarchy-and-streaming/final-f4-manual.txt`。

- [x] F5. **范围、阻塞门与脏工作树审计**：确认 C0 结论与 C1 是否实施一致；C0=FAIL 时无 C1 commit、但 C2 和所有 UI todo 已完成；确认 `server/src/workers/worker-event.ingress.ts` 的群聊路由未被改动、群聊最终消息契约未变；确认所有预存脏文件未被覆盖或纳入本计划 commit。
  - Recommended task executor category: unspecified-high — 需要把条件门、Scope OUT 和工作树保护逐项对照。
  - Evidence: `.omo/evidence/chat-ux-hierarchy-and-streaming/final-f5-scope-and-gates.txt`。

## Commit strategy

- **一 todo 一 commit**，不得把多个实现 todo 合并；C0 是纯验证 todo，不产生 commit。实现 + 测试属于同一 todo 的一个原子提交。
- 提交信息沿用 `type(scope): 中文摘要` 格式：`feat(chat):`、`refactor(chat):`、`fix(chat):`、`refactor(theme):`、`fix(stream):`。
- 产品 commit 不得包含 `.omo/evidence/`、`.omo/plans/`、`.omo/drafts/`、`.omo/boulder.json`、`.omo/ulw-execute/ledger.jsonl`、`.opencode/opencode.json` 或任何与本计划无关的脏文件；证据按仓库惯例留在本地或另行 `chore(omo)` 提交，不能混入产品 commit。
- 执行前后都用 `git status --short` 核对脏工作树；禁止使用会覆盖预存改动的 `git checkout -- <path>`。提交前逐个 `git diff --cached --name-only` 验证范围。
- web 改动前阅读 `web/node_modules/next/dist/docs/` 相关指南；若 `next dev` 自动重新生成 `web/AGENTS.md` 规则块，保留该生成文件，不把“删除规则块”当作清理。

## Success criteria

1. `bash scripts/gate.sh` 输出 `GATE GREEN`；`cd web && npx playwright test` 全绿且不低于基线 125/125。
2. 结构门证明既有聊天 testid 零消失；一条含 N 个 process parts 的消息身份元素（头像/作者/时间）各只出现 1 次。
3. 正文折叠阈值为 800 字符/10 行；tool I/O 在折叠态和展开态均展示前 2000 字符且第 2001 字符起不进入 DOM；thinking 折叠摘录 200 字符，展开态可见完整 thinking 文本。
4. 正文为 14px、身份为 12px semibold、元信息为 11px；时间戳不再与身份名共享同一字号/颜色/span；全局 `fontSize.md` 未被改为 14。
5. 同 sender 连续消息在 5 分钟内复用身份栏；跨 sender、跨日、user/system 不错误折叠；跨天出现日期分隔，system 与正文有明确区隔。
6. DOM 不出现裸 `a_xxx`/`tmm_xxx`/`ta_xxx`；author 与 role 并列展示；用户消息状态可见；同角色不同成员头像缩写不同。
7. 未知 part 不再静默消失；低优先级过程/附件默认可收起；error/aborted 标题、摘要和动作始终可见且默认展开策略正确。
8. 角色颜色在 light/dark 下均来自 `--color-role-*`，不存在 `tokens.ts:19-39` 的角色硬编码 hex。
9. C0 有真实 serve 证据；C0=FAIL 时 C1 不实施、不声称 token-level streaming，但 C2 的频道滚动门控、首帧 refetch 和 DM 30s 轮询兜底仍通过。
10. C1=实施时，worker/server 单测证明同一 text part 增长可增量合并、parts 不重复、最终文本与 serve 完整文本一致。
11. 群聊 delta 路由和群聊最终 MCP 消息契约无 diff；所有预存脏文件未被覆盖或纳入本计划 commit。
