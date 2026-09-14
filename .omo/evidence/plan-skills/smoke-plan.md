# e2e smoke 计划（plan-skills 验证用，测试后删除）

## 背景
验证 `vteam_plan_review` 单评审者 live 回合：计划文件可被服务端定位并扇出冷评审。

## 任务拆解
- T1：确认计划文档可读（只读，不修改）。
- T2：输出 `VERDICT: APPROVE` 或 `VERDICT: REJECT` + 依据。

## 验收标准
- 评审者只输出 VERDICT 与依据，不修改任何文件。
