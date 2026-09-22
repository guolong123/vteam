# Decisions — session-right-panel-plan-overhaul

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## D1 · 词表 5 位点必须同一 commit
计划 Commit strategy 要求词表 5 位点（server 数组 + 3 处硬编码串 + web 镜像）同 commit；但计划把它拆成了 T1(server)/T3(web) 两个 todo。
**执行时合并**：T1+T3 一个 commit（`fd07b87`），T2 测试独立 commit（`537466f`）。

## D2 · 「计划 Tab」保持原型 3 卡，内容三源合一
状态卡（评审闭环）原样保留；「计划文档」卡成为唯一内容聚合区（本地文件 + `category=计划` 产出物，来源徽标）。D8 口径。

## D3 · 自动归档只在状态机事件点触发
`mark-pending-review`（主）+ `accept`（幂等兜底）；**不在任何读路径写库**。三处目录全归档（含 `.omo/drafts`）。写入落点 `PLAN_DOCS_DIR` 不动。

## D4 · 本次只格式化自己改的 4 个文件
不动 `platform-mcp.tools.ts` 等 202 个预存 prettier error 的文件（超范围）。
