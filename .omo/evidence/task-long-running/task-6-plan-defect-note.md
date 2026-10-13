# 计划缺陷记录：todo 6 的「必做失败场景」不可满足

## 计划原文（todo 6 Must NOT + QA failure 场景）

> **必须写成条件收窄，不得写成 `if (task.longRunning) return ...` 早退** —— 早退会连带
> 跳过 :1363-1368 的 404 分支。
>
> failure（**必做**）: 临时把 (b) 改写成 `if (task.longRunning) { /* 跳过拦截 */ } else if
> (status === 'in_progress' || ...) { throw }` 的**早退**形态 → 用例 ⑦ 必须失败。

## 实测结果：该场景不可满足

注入计划描述的早退形态后，`tasks-remove.spec.ts` **8 个用例全绿**——两种写法行为等价。

## 根因：计划对语句顺序的判断有误

`remove()` 的实际顺序（tasks.service.ts:1378 起）：

1. `findUnique`
2. `if (!task) throw NotFoundException`   ← 404 分支
3. 状态检查（`in_progress` / `pending_review` → DELETE_BLOCKED）

计划声称「第 3 步的早退会连带跳过第 2 步的 404 分支」，但 **404 在早退位置之前**，
顺序上够不到。故该约束在当前代码结构下**没有可观测差异**。

## 真正的危险形态（已加护栏且实测可捕获）

`if (task.longRunning) return { deleted: true, id }` —— 谎报删除成功却未执行任何级联
（teamQueue 清理、currentTaskId 置空、13 张子表全部跳过）。调用方以为已清理。

护栏：`tasks-remove.spec.ts` 新增用例断言 `calls` 含 `task.delete`。
注入该谎报早退后 → **1 failed**（见 `task-6-task-long-running-delete-fakedelete.txt`），
还原后 8/8 绿。

## 处置

- 保留条件收窄写法（更清晰，且不给人谎报成功的余地）
- **修正了代码注释里的错误理由**：「早退会连带吃掉 404 分支」→「谎报删除成功却未执行级联」
- 计划中该失败场景记为**不可满足**，以真实场景替代并留证
