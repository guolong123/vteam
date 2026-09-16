# plan-review-wiring — 评审轮次链路接线（docs 33 落地）

## 背景

`docs/agent-platform/33-评审轮次机制.md` 的设计已实现为三个 service（`ReviewRoundGateService`、
`ReviewRoundService`、`PlanLifecycleService` 的 pending_final 分支），单测全绿，但**生产零调用方**：

- `.recordVerdict` / `.attachPlanSink` / `.checkTimeout` / `.confirmDegradedRelease` / `.requestRevision`
  的非 spec 调用数 = 0。
- MCP 工具表**无** verdict / review 入口；agent 无法发起评审或提交回执。
- `expected` 名单在生产路径**从未写入** → 收敛恒不成立。
- 结果：`plans.status` 卡 `draft`，draft 态无按钮（按钮只在 pending_final/approved 渲染），
  群聊里发再多 `VERDICT: APPROVE` 也只是文本 → 主流程跑不通（S9 现场病例）。

本计划把设计接线补齐，使 draft → 评审 → N/N → pending_final → 定稿 → approved → 确认 → executing 全链可跑通。

## 设计约束（来自 33 篇 §6.4 + 既有门禁）

- 只接线，不改既有门禁语义（C3 清单：执行门禁/issue 锁/三元组门/throttle/force/a_plan 豁免/toolAllows/bash-edit 一律不动）。
- 收敛只到 `pending_final`，**永不**自动 approved（用户两道门保留）。
- 账本一切写经 `ReviewRoundService.applyRoundUpdate`（串行化唯一入口）。
- 无 host/未装配路径一律 warn + 跳过，永不阻断主流程（fail-open 风格）。
- 不新增依赖；复用已落地的通用 `TimerService`（timeout）。

## TODOs

- [x] 1. `review-round-gate.service.ts` 加 `attachNotifier`；新增 TasksModule 引导 provider 装配 notifier+sink - expect 收敛可翻转 pending_final 且收敛可通知
- [x] 2. `platform-mcp.service.ts` 评审派发时开轮写账本（round/planVersion/expected/status/timeoutAt）+ 排 timeout 定时 - expect 派发评审后账本出现、expected 落库
- [x] 3. 新增 VERDICT 回执监听器（订阅 chat.message.new，首行解析）→ gate.recordVerdict - expect 群聊 VERDICT 进账本、N/N 触发收敛
- [x] 4. ~~新增 `plan_verdict` MCP 工具~~ **经 E2E 验证判定冗余**：聊天 VERDICT 监听已覆盖主路径，真实链路（派发→VERDICT→收敛→pending_final→定稿→approved→确认→executing）无需该工具即贯通，故不实现（避免无谓扩面）
- [x] 5. timeout→stale 接线（TimerService + review_round_timeout handler） - expect 超时转 stale 且不自动放行
- [x] 6. UI：draft 态等待提示（复审按钮随收敛出现） + e2e 断言 - expect 用户可看到评审进度与两道门按钮

## Final Verification Wave

- [x] F1. 计划符合性审计：逐条对照 33 篇 §3~§6 与 C3 清单，确认只接线未收紧 → 首轮 REJECT（V1 极性/V2 归档/G1 修订门未接），已全部修复并复验
- [x] F2. 代码质量评审：新增/改动文件逐行审，无 stub/any/吞错，账本写全走 applyRoundUpdate → 首轮 REJECT（2 MAJOR + 4 MINOR），已全部修复；守卫测试冲突经搬移修复（未放宽守卫）
- [x] F3. 真实手工 QA：MCP 直调走通「派发评审→VERDICT→收敛→pending_final→定稿→approved→确认→executing」
- [x] F4. 范围保真：确认无越界改动（worker/web 之外、C3 门禁零改动） → PASS

## Acceptance Criteria

1. 主 Agent 携三元组派发评审 → 账本创建，`expected` 为三元组名单，`status=collecting`。
2. 评审人在群聊回 `VERDICT: APPROVE @ v<x>` → 计入 `received`（版本不符走 superseded，缺版本打回）。
3. 收齐 `expected` → 账本 `complete`；**全部 APPROVE** → 计划翻 `pending_final`（任一 REJECT → 回 `draft`，§6.1 极性门）+ 收敛通知（抄 PM）。
4. 页面出现 [确认定稿] → 点后 approved → 出现 [确认开始执行] → 点后 executing。
5. 30 分钟未齐 → `stale`，产出待拍板项，**不**自动放行、**不**通知计划员。
