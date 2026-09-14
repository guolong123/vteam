# F3 手工 QA 计划（测试后删除）

## 背景
验证重写后 `plan-review-tester` 技能的评审纪律：单评审者冷评审，给出可解析 VERDICT。

## 任务拆解
- T1 计划可读性确认：评审者经 read_file 读取本计划全文（验收：能引用章节号）。
- T2 测试视角冷评审：按 plan-review-tester 输出 VERDICT 与依据（验收：首行 VERDICT: APPROVE/REJECT，findings 每条≤2句）。

## 任务分配
- T1 owner: tester, dependencies: none, acceptance: 引用章节号。
- T2 owner: tester, dependencies: T1, acceptance: 首行 VERDICT 可解析。

## 验收标准
- 评审只读，不修改任何文件，不执行任何步骤。

## 假设清单
- 假设 worker 侧 LLM 可达；若不可达则 NEEDS-ATTENTION-by-infra 亦计为可解析。
