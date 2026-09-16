# task-1 decisions evidence (plan-finalize-actions todo 1)

## Appended annex (§6.4) quoted verbatim

### 6.4 定稿裁决增补（plan-finalize-actions todo 1 决策记录）

本节为 Wave 1 根决策，后续 todo 2/3 以此为准，只松不紧，不新增算法与门禁。

**裁决一：正式版双锚（dual-anchor）载体。**

* 正式版 = DB approved 行 + 文档版本哈希，双锚缺一不可：DB 行定状态与归属，文档哈希定内容。
* 哈希算法复用 triplet sha1-8（`review-round-ledger.ts` 既有 `planVersion.hash`，落盘内容 sha1 前 8），禁止引入新算法。
* 执行认哈希：门禁比对 `planVersion.hash`，不匹配即拦。

**裁决二：哈希计算钩（hash-compute hook）。**

* 钩位：计划员修订落盘后，读文件算 sha1 前 8，写回账本 `planVersion.hash`。
* 缺失语义：hash 缺失时到达的回执一律挂起，reason=`pending-hash`，不标 received，不标 superseded。
* 禁止悬空假设：不允许“某处自动算好”，接线点写死在 `writePlanDoc → applyRoundUpdate` 回填链。

**裁决三：修订入口矩阵（revise entry matrix）。**

| 当前状态 | 修订入口 | 动作 | version / 轮次规则 |
| --- | --- | --- | --- |
| approved | approved → draft 打回（带 reason） | 重走收敛门小循环 | version +1，轮次不变 |
| rejected | approved → draft 打回（带 reason） | 重走收敛门小循环 | version +1，轮次不变 |
| executing | 新增 revise 动作 | 回到 draft，version +1，轮次 +1，重走完整 N/N 复评 | 在途执行按门禁存量语义自然收敛，不追杀 |
| completed | 新增 revise 动作 | 回到 draft，version +1，轮次 +1，重走完整 N/N 复评 | 同上，不追杀已完成交付 |
| pending_final | 不可打回 | 只能等用户确认定稿或评审 REJECT | 不开修订入口 |

* 复评 quorum = N/N，沿收敛门。
* 打回必须带 reason，reason 落审计。

**force 口径：维持现状。**

* force 仍可绕过门禁，但须同时给非空 forceReason 留审计行（落回执行 forceReason 列），否则仍被拦。
* 不因哈希新增任何限制，不收紧现行放行面。

**C3 闭合门禁清单（逐项裁决只允许放宽或不动，收紧需单独立项）。**

* 执行门禁：非 executing 拒绝派发，只松不紧。
* issue 锁：issue 门禁未放行即拦（force + forceReason 可绕，留审计），只松不紧。
* 三元组门：回执三元组（member/verdict/msgId）缺一即拦，只松不紧。
* throttle：节流配额不动，不借定稿收紧。
* force：绕过留审计口径不变，不新增限制。
* a_plan 豁免：计划员目标（agentId=a_plan）计划工作永非执行，豁免不变。
* toolAllows：plan 的 toolAllows 无记忆工具等约束不变，不借定稿扩权或收权。
* bash-edit：bash 编辑类约束不变，不借定稿收紧。

## Completeness self-check

- [x] dual-anchor 定义 present（DB approved 行 + 文档版本哈希，triplet sha1-8 复用，禁止新算法）
- [x] hook 定义 present（落盘后读文件算 sha1 前 8 写回账本；缺失挂 pending-hash）
- [x] entry-matrix table present（approved/rejected 打回 version+1 轮次不变；executing/completed revise 走小循环；pending_final 不可打回）
- [x] force  stance present（维持现状，绕过留审计，不因哈希收紧）
- [x] C3 list present（8 项各一行：执行门禁 / issue 锁 / 三元组门 / throttle / force / a_plan 豁免 / toolAllows / bash-edit）

## Vocabulary cross-check (codebase)

- sha1-8: server/src/issues/review-round-ledger.ts:38,63,142,145 (`planVersion.hash` sha1 前 8)
- pending-hash: review-round-ledger.ts:27,40,80,330-354 (reason=`pending-hash`, VerdictOutcome)
- a_plan exemption: server/src/chat/worker-dispatcher.ts:70,1270,1360; server/src/platform-mcp/platform-mcp.service.ts:85
- force + forceReason: server/src/platform-mcp/platform-mcp.service.ts:969-972,1085-1134,1288-1316

## Diff stat (doc file only)

```
docs/agent-platform/33-评审轮次机制.md | 45 ++++++++++++++++++++++
1 file changed, 45 insertions(+)
```

Full-tree `git diff --stat` shows other dirty files pre-existing (not touched by this todo); this todo appends ONLY §6.4 to the one doc file.
