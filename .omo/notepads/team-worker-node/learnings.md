# Learnings — team-worker-node

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## 2026-10-14 · Wave 3 收尾期（Atlas 编排会话）
- 编排者身份铁律：只做「选计划 / 写 .omo 状态 / 拆解 / 派发 / 裁决 / 记录证据」；实现与 QA 一律交给 lane。
- 派发面：必须用 subagent 工具；tools.task 路径的会话不可解析、回执不可达（Wave 2 首轮三条 lane 全灭就是这个原因）。
- 限流：provider 侧间歇性 `Rate limit exceeded`。并发 3 条必被拒；单条可通过。**结论：串行派发**，失败即停、不重试刷屏。
- 共享文件纪律：对路（memory 改名流）提交 cb0ba6d 后，worker-dispatcher.ts 的工作区残留变纯净 ⇒ 精确路径暂存重新安全；但 tasks.service.ts 仍需 hunk 级归因。
- 归因方法：用「diff 里 grep 对路关键字 = 0」证明共享文件的残留纯属本计划；用 mtime 切分不同 todo 的改动窗口。
- 提交尚未落地（0 次，故意押后到波次边界）；T4 与 T6 改过同两个文件，届时要么 hunk 级拆分、要么合并两条信息并如实声明。
- 证据回执的准确性本身会耗掉 lane：T14 因两个标点级数字消耗 4 条 lane；教训是**证据文件里的数字必须现场再推导**，且验收判据要写成「与其活体来源一致」而不是「文中不出现某串」。
