---
slug: team-worker-node
status: accepted-approved-with-notes
intent: clear
review_required: true
pending-action: handoff - 用户在知晓 2 条单行残留后接受；执行在独立 worker 会话启动（$ulw-execute team-worker-node）
plan_path: .omo/plans/team-worker-node.md
plan_sha256: b8092717acaed90d1164adb75c89eee23b7aa9398a27c3650bc54371c70df036
review_round_id: r1-team-worker-node-20261014T012955Z
round_status: active
approach: Team 与 TeamMember 各加一个可空 preferred_worker_id（软绑定单节点）；分派期解析链 = 成员显式 > 团队 > 现状自动调度；不可用一律软回退 assignWorker，并顺带删除从未生效的 Agent.workerId 字段与下拉
---

## Review round 1 结果（两路均 changes_requested，4 条 blocker 全部可复现）
- momus: changes_requested —— B1（T4 Must NOT 禁止删除 `workers.service.ts:1319-1322`，而 T6 摘列后该调用必然编译失败，且无 todo 拥有修复）；B2（`scripts/e2e-team-worker-node.sh` 是被四处要求的交付物，却无任何 todo 编写）
- independent(oracle): changes_requested —— O-B1 同 momus B1（并补：删掉该调用会让 `workers.service.spec.ts:2070-2072` 的断言转红，必须同改）；O-B2（`workers.service.spec.ts:108-149` 的 mock 无 `team` 键、`teamMember` 只有 `findMany`，`remove()` 用例组 `:2046-2131` 会被孤儿化，`:2058` 的 `toHaveLength(5)` 必改）；O-B3（`grep -rn "agent-worker-select" web docs` 因 `web/.next/` 构建产物实测 18 命中 ⇒ 该验收永远不可达、突变校验失去意义）；O-B4（F4 的「工作区 clean」与「platform-mcp diff 为零」在**开工前已脏**的工作区上不可达，且执行者的明显补救会毁掉无关在途改动）
- 非阻塞笔记（已折入）：9 处而非 8 处无参调用方（补 `teams.service.ts:923`）；`tasks.service.ts:57-73` 的 `TeamMemberView` 是闭合类型须补字段否则 TS2339；degraded 置顶无声；行号漂移 5 处；原型 `agent-manage` 的 `worker: string` 与 9 条 mock 行；B2 warn 缺可失败测试；SC3 未枚举「有 availability 但无一匹配」；T11 验收退化为 grep 计数；记账漂移（Must NOT 13 条、提交 11 次）

### Round 1 修复（已落地，全部最小改动、未扩范围）
1. `remove()` 引用清理与列同生共死 → 移交 T6 独占（含删 `agent.updateMany` + 其 spec 断言 + 补 team/teamMember 两处清理与 mock 条数），T4 改为「不得改 `remove()`」并只做调度。
2. 新增 T12「编写 `scripts/e2e-team-worker-node.sh`」为独立交付物（A/B/C/D 四段真实断言 + 栈重建前置），原收口 todo 顺延为 T13。
3. 所有 grep 验收限定源码路径（`web/app web/src web/e2e docs`），并写明 `.next/` 噪声原因。
4. F4 与提交门改为「相对开工快照的**新增**改动为零」，T1 增加 base-sha + `git status --porcelain` 快照留档，明令禁止清理开工前的脏文件。
5. 其余笔记逐条折入（9 处调用方、`TeamMemberView` 类型、degraded warn、B2 第 6 例、SC3 六种回退、T11 行为断言、行号校正、原型 mock 行）。

## Review round 2（对修复后的计划重跑双路）
```json
{
  "transition": "replace",
  "phase": "review_round_initialized",
  "atomic": true,
  "review_required": true,
  "plan_path": ".omo/plans/team-worker-node.md",
  "plan_sha256": "0f292a501de4432a29d73f7a321fc9ffe899adcfa3ed0d0fe3f9b9691957eedc",
  "review_round_id": "r2-team-worker-node-20261014T014320Z",
  "round_status": "active",
  "pending-action": "review .omo/plans/team-worker-node.md",
  "review": {
    "momus": { "status": "pending", "workspace_root": "/Volumes/SSD-Data/01work/git-project/vteam", "runtime_home": null, "target": ".omo/plans/team-worker-node.md", "round_id": "r2-team-worker-node-20261014T014320Z", "plan_sha256": "0f292a501de4432a29d73f7a321fc9ffe899adcfa3ed0d0fe3f9b9691957eedc", "launch_id": "momus-l2-20261014T014320Z", "session": null, "result": null },
    "independent": { "status": "pending", "workspace_root": "/Volumes/SSD-Data/01work/git-project/vteam", "runtime_home": null, "target": ".omo/plans/team-worker-node.md", "round_id": "r2-team-worker-node-20261014T014320Z", "plan_sha256": "0f292a501de4432a29d73f7a321fc9ffe899adcfa3ed0d0fe3f9b9691957eedc", "launch_id": "oracle-l2-20261014T014320Z", "session": null, "result": null }
  },
  "convergence": {
    "max_rounds": 5,
    "round": 2,
    "ledger_frozen_after_round": 1,
    "accepted_blockers_r1": ["momus-B1+oracle-B1(remove-agent.updateMany 与列同生共死)", "momus-B2(e2e 脚本无主)", "oracle-B2(remove 用例组孤儿化与 mock 条数)", "oracle-B3(grep 命中 .next 噪声)", "oracle-B4(F4/门禁在已脏工作区上不可达)"],
    "non_blocking_notes_r1": ["9 处无参调用方", "TeamMemberView 闭合类型", "degraded 置顶无声", "行号漂移 5 处", "agent-manage 原型 mock 残留", "B2 warn 缺可失败测试", "SC3 未枚举 availability 不匹配", "T11 验收退化", "记账漂移"],
    "closure_round_scope": ["accepted_ledger_blockers", "regressions_introduced_by_fixes", "new_findings_passing_blocker_eligibility"]
  }
}
```

## Review round 2 结果（两路 changes_requested；5/5 轮 1 blocker 被逐条"验证"解决，新增 5 条合格 blocker）
- momus: 5/5 resolved ✅（逐条实测行号）；新增 B1 `T13 grep "dto.workerId|agent.workerId" server/src` 零命中不可达（Worker 域同名语义遍布 `worker-event.ingress.ts`/`worker-dto.spec.ts` 等）→ 与计划自身红线（不得改 Worker 域）互斥，最后一个 todo 必然判红；B2 `T13 grep "首选 Worker" web/app …` 零命中被 T10 **自己新写**的文案打破（T13 在 T10 之后执行 ⇒ 必然命中 2 行）；另登记：`grep -c "agents" <迁移>` 必 ≥2（中文理由头会写表名，先例 `worker_update_state` 的 `grep -c "workers"`=4、`grep -c "ALTER TABLE"`=2，全来自头部注释）。
- independent(oracle): 5/5 resolved ✅（并证实 mock 缺口、条数 5→4→6、18 处 `.next` 噪声、脏工作区清单均与计划描述一致）；新增 4 条：① **Wave 1 无法编译** —— T5 直读 `select: { preferredWorkerId: true }`，而列要到 T6 才进 schema + generate，`ts-jest` 未关 diagnostics ⇒ T5 自身 `npx jest src/chat/worker-dispatcher.spec.ts` 与 `nest build` 必红，违反计划自设的「每波落地后仓库都可编译」；② T13 `grep -c "agents"` 计数不可达；③ `首选 Worker` 收窄；④ `dto.workerId` 拆分。
- **两路分歧点**（T5 能否留在 Wave 1）：momus 认为「照抄 `:3812-3832` 的 `(this.prisma as any)` 取值」就不会触发超集属性错误；oracle 认为计划字面写法（带类型 select）会红。裁定按「零判断空间」处理 —— T5 移 Wave 2（依赖 4 与 6）**且**把取值形状写死为 `(this.prisma as any).teamMember`/`.team` + `as {...} | null` 收窄（同时满足两路）。

### Round 2 修复（已落地，全部最小改动）
1. T5 移到 Wave 2、依赖改 `4, 6`；正文写死 `(this.prisma as any)` 取值形状与 `as {...} | null` 收窄。
2. T13 复核拆细：`dto\.workerId` 只查 `server/src/agents`、`agent\.workerId` 查 `server/src`；`首选 Worker` 收窄到 agents 面；**新增 Worker 域正面保留断言**（`server/src/workers` 的 `dto.workerId` 仍 ≥40，防误删）；所有计数类 grep 一律先 `grep -v '^--'` 剔除注释。
3. 迁移计数改为剔除注释后判定（`DROP COLUMN`=1、`ALTER TABLE`=3、`` `agents` ``=1），T7 ⑤ 要求守卫 spec 同样先剔注释、理由头避开关键字字面量。
4. T6 补「注释措辞不得含 `preferred_worker_id` 字面量」以保住 `schema.prisma` ==2 计数。
5. T3 的 `首选 Worker` grep 一并收窄到 agents 面（消除与 T10 共用 pattern 的维护陷阱）。
6. T3 删除项补 `agents/page.tsx:1880` 小节副标题；澄清原型 `agent-manage:20` 是注释而非类型字段。
7. F4 收窄为「platform-mcp 目录零 diff + `workers.service.ts` 内 `matchesModelRequirement` 块零 diff」。
8. T10/T12 澄清：悬空 id 的 **API 往返**由脚本确定性断言；**DOM 占位回显**降级为可选 Playwright + non-blocking note，不再作为任何 Success criteria 的必过项。
9. 记账校正：TL;DR 12→13；`toHaveLength(5)` :2058→:2058-2059；baseline 约束段 :134-141→:135-141；依赖矩阵第 13 行与 T13 正文统一为 `2,3,5,7,10,11,12`。

## Review round 3（对二次修复后的计划重跑双路）
```json
{
  "transition": "replace",
  "phase": "review_round_initialized",
  "atomic": true,
  "review_required": true,
  "plan_path": ".omo/plans/team-worker-node.md",
  "plan_sha256": "4bc7ae35e93b5699f416e0e3f316509f4b52d7e0bb72d3ac7102d989a5a941d5",
  "review_round_id": "r3-team-worker-node-20261014T015542Z",
  "round_status": "active",
  "pending-action": "review .omo/plans/team-worker-node.md",
  "review": {
    "momus": { "status": "pending", "workspace_root": "/Volumes/SSD-Data/01work/git-project/vteam", "runtime_home": null, "target": ".omo/plans/team-worker-node.md", "round_id": "r3-team-worker-node-20261014T015542Z", "plan_sha256": "4bc7ae35e93b5699f416e0e3f316509f4b52d7e0bb72d3ac7102d989a5a941d5", "launch_id": "momus-l3-20261014T015542Z", "session": null, "result": null },
    "independent": { "status": "pending", "workspace_root": "/Volumes/SSD-Data/01work/git-project/vteam", "runtime_home": null, "target": ".omo/plans/team-worker-node.md", "round_id": "r3-team-worker-node-20261014T015542Z", "plan_sha256": "4bc7ae35e93b5699f416e0e3f316509f4b52d7e0bb72d3ac7102d989a5a941d5", "launch_id": "oracle-l3-20261014T015542Z", "session": null, "result": null }
  },
  "convergence": {
    "max_rounds": 5,
    "round": 3,
    "ledger_frozen_after_round": 1,
    "accepted_blockers_r1_resolved": true,
    "accepted_blockers_r2": [
      "T5 直读未生成的列 ⇒ Wave1 编译红（两路分歧，按零判断空间裁定：移 Wave2 + 写死 as any 形状）",
      "T13 dto.workerId|agent.workerId 全仓零命中不可达（Worker 域同名语义）",
      "T13 首选 Worker 零命中被 T10 自身文案打破",
      "T13 grep -c agents/迁移 计数被中文理由头抬高",
      "F4 对 workers.service.ts 的零 diff 期望不可达（本计划本就要改该文件）"
    ],
    "non_blocking_notes_r2": ["toHaveLength 行号 off-by-one", "baseline :134 vs :135", "TL;DR 计数 12 vs 13", "T13 依赖矩阵与正文不一致", "T5 保留 as any 形状", "F4 措辞收窄", "悬空 id 的 UI 断言无护栏", "migration spec 不枚举于 gate-spec-registry（无耦合，已核实）"],
    "closure_round_scope": ["accepted_ledger_blockers", "regressions_introduced_by_fixes", "new_findings_passing_blocker_eligibility"]
  }
}
```

## Review round 3 结果（两路 changes_requested；5/5 轮 2 blocker 被验证解决；新增 6 条合格残留）
- momus（3 条，全是轮 2 修复的尾巴，均为单行）：① T3 **只改了一半** —— 验收行已收窄到 agents 面，同 todo 的 **QA 场景行**仍是 `web/app docs/agent-platform`，T10 落地后该 QA 的 happy 路径不可执行；② T6 自己的 `Parallelization: … | Blocks: 7, 8, 9` **漏了 T5**（正文/矩阵/波次三处都写了这条边，唯有调度字段没写，与轮 2 为「T5 编译红」所做的修复自相矛盾）；③ T13 四个迁移计数里 `preferred_worker_id == 2` 未剔注释（另三条都剔了），而计划自己强制的「中文理由头逐列论证」恰会写入列名字面量。
- independent(oracle)（4 条，含 2 条环境级硬伤）：① **栈重建前置不足** —— `server/Dockerfile:13-18,28` 把 `prisma/`（含迁移）与 `dist/` 烤进镜像，只 `docker compose up -d` 会用旧镜像：新迁移不在镜像里（init 建不出列）、新 `PATCH` 字段被 whitelist 静默剥离；仓库 8 个 `scripts/e2e-*.sh` **全部**先 build，含计划引用的 `e2e-roles-members.sh:19`；② **C/D 段不可满足** —— compose 只有单个 `worker` 服务且 `container_name`/`WORKER_ID` 写死（`docker-compose.yml:126-135`）、`seed.ts` 不建 worker 行，「把唯一节点置离线」只会命中 `worker-dispatcher.ts:2307` 硬抛 → 5xx，正是 C 要否定的结果；③ T4 的 `git diff --stat … 不出现 hunk` **恒真零覆盖**（`--stat` 只打印汇总行）；④ 同 momus ③，并指出 T7 自己的 `DROP COLUMN == 1` 也未剔注释。
- 另 7 条笔记：`:30` 与 `:135` 行号精度、F4 的「按块核对」缺可执行命令、T2/T7 的 `Blocks:` 与矩阵不一致、提交分组仍把 T5 归到移除面、warn 文案把「行缺失/offline」当两种确定原因（候选集已排除 offline，二者不可区分）、F2 对 9 处调用方的括号说明不准。

### Round 3 修复（已落地，全部单行/两行改动）
1. T3 的 QA 行改为与验收行同一收窄范围。
2. T6 `Blocks:` → `5, 7, 8, 9`；并统一 T2（`6, 13`）、T7（`13`）与矩阵。
3. T4 第 4 条验收由 `--stat` 改为 `git diff -U0 … | grep '^@@'` 且断言无 hunk 覆盖 `:1310-1325`（等价硬断言 `grep -c 'agent.updateMany' == 0`）。
4. 迁移计数全部剔注释（含 T7 的 `DROP COLUMN` 与 T13 的 `preferred_worker_id`）；T7 ⑤ 的字面量禁令扩到 `preferred_worker_id`（与 `schema.prisma` 注释同约束）。
5. 栈重建前置改为 **先 build 再重建**（3 处，含 F3），写明「只 up -d = 旧镜像」的因果链。
6. T12 新增 **前置 2：≥2 个在线 worker**（两条落地路径：注册第二个不同 `WORKER_ID` 的 worker 进程，或直接插一行 online `workers`），并写明 C/D 在少于 2 个节点时必须显式 skip 而非判 PASS。
7. 笔记逐条折入：行号两点、F4 块级判据命令化（`-U0 | grep '^@@'` 不得覆盖 `:901-938`）、提交分组把 T5 移到与 T6 相邻、warn 文案改为「候选集中不存在该 id」、F2 括号改为「仅分派 2 处携带 assignmentReq，其余 7 处无参或 `opts.workerId` 兜底；判据是 preferredWorkerId 为 undefined 时行为不变」。

## Review round 4（对三次修复后的计划重跑双路）
```json
{
  "transition": "replace",
  "phase": "review_round_initialized",
  "atomic": true,
  "review_required": true,
  "plan_path": ".omo/plans/team-worker-node.md",
  "plan_sha256": "678831fd9d0fc2ac49251ab784f5cb19769ddea47184e19b82cf35a6743b7823",
  "review_round_id": "r4-team-worker-node-20261014T021439Z",
  "round_status": "active",
  "pending-action": "review .omo/plans/team-worker-node.md",
  "review": {
    "momus": { "status": "pending", "workspace_root": "/Volumes/SSD-Data/01work/git-project/vteam", "runtime_home": null, "target": ".omo/plans/team-worker-node.md", "round_id": "r4-team-worker-node-20261014T021439Z", "plan_sha256": "678831fd9d0fc2ac49251ab784f5cb19769ddea47184e19b82cf35a6743b7823", "launch_id": "momus-l4-20261014T021439Z", "session": null, "result": null },
    "independent": { "status": "pending", "workspace_root": "/Volumes/SSD-Data/01work/git-project/vteam", "runtime_home": null, "target": ".omo/plans/team-worker-node.md", "round_id": "r4-team-worker-node-20261014T021439Z", "plan_sha256": "678831fd9d0fc2ac49251ab784f5cb19769ddea47184e19b82cf35a6743b7823", "launch_id": "oracle-l4-20261014T021439Z", "session": null, "result": null }
  },
  "convergence": {
    "max_rounds": 5,
    "round": 4,
    "ledger_frozen_after_round": 1,
    "accepted_blockers_r1_r2_resolved": true,
    "accepted_blockers_r3": [
      "T3 QA 场景行未同步收窄（happy 路径不可执行）",
      "T6 Blocks 漏 T5（与轮 2 修复自相矛盾）",
      "T13 preferred_worker_id 计数未剔注释（+ T7 的 DROP COLUMN 同类）",
      "栈重建前置缺 build（旧镜像 ⇒ 迁移与新字段均不生效）",
      "C/D 段需要 ≥2 个在线 worker 才可满足（compose 只有 1 个且不可 scale）",
      "T4 的 --stat hunk 判据恒真零覆盖"
    ],
    "non_blocking_notes_r3": ["tasks.service.ts 行号 2022-2024→2028-2030", "matchesModelRequirement 分支行号 922-925→926-927", "F4 块级判据缺命令", "T2/T7 Blocks 与矩阵不一致", "提交分组 T5 位置", "warn 文案把行缺失/offline 当两种原因", "F2 对 9 处调用方的括号不准"],
    "closure_round_scope": ["accepted_ledger_blockers", "regressions_introduced_by_fixes", "new_findings_passing_blocker_eligibility"]
  }
}
```

## Review round 4 结果（两路 changes_requested；轮 3 的 6 条被清空；新增 4 条合格 blocker）
- momus: 轮 3 的 6 条 blocker **全部清空**（逐条盘上证据）+ 7 条笔记全部折入；新增 1 条 wave 边界 blocker：T11 读 `m.preferredWorkerId`（`m: TeamMemberDto`）与任务实例类型，而**两处类型声明都归 T10**，矩阵却允许 T10/T11 并行 ⇒ 该排布下 T11 的 `tsc` 必报 TS2339（同文件 `session/page.tsx:434` 的 `(m as {...})` 强转正是同类滞后留下的疤）。
- independent(oracle): 轮 3 的 4 条里 3 条清空、**1 条未清**（≥2 worker 的构造），并新报 3 条：① **`bash scripts/gate.sh` 开工前就已红** —— bare-catch 守卫 176 > 基线 175（`scripts/gate.sh:73-81`，CI 镜像于 `.github/workflows/ci.yml:41-46`），176 在 worktree 与 HEAD 一致（我已独立复算确认），而 T13/F3/SC6 把「exit 0」当硬验收、又禁止放宽基线 ⇒ 结构性不可达；② 前置 2 的两条构造**都不可行**（DB 插行会被 `markStaleWorkersOffline` 在 ≤10s 翻 offline、缺 NOT NULL 的 `opencode_version`、且不可达会在 `createSession` rethrow 成 5xx；`worker-stub-server.py` 其实是「假 server」不是 worker），且「显式 skip」与「四项 PASS」自相矛盾；③ T1/T13 的「dump 未入库」判据零检出能力（`.omo/evidence/**/*.sql` 被 `.gitignore:45` 忽略，porcelain 恒 0；原括注「`.omo/evidence/*` 是被跟踪的目录」对 `.sql` 不成立）。
- 另 8 条笔记：e2e build 计数（10 个里 6 个，两路名单有分歧 → 删掉数量只留依据）、`--stat` 补充判据被误标「等价」、`agents.service.ts:628` 返回类型成员漏删、B1 与 `defaultModelId` 命中并存时的有意拒选需注记、`remove()` 在 `:1290` 的文档注释会与代码不符、porcelain 对比措辞需字面化、`:2338`→`:2337`、`Dockerfile:24` 才是 `dist` 的 COPY、两处行号精度。

### Round 4 修复（已落地）
1. T11 `Blocked by: 9, 10`（含 TS2339 因果）；矩阵行 9/10/11/12 重排、去掉不可实现的「并行」列。
2. T10 增补「`patchMutation` 是内联结构类型，必须同步加字段」；`Blocks: 11, 12`。
3. 前置 2 改为**单一可行构造** `docker compose run -d --name vteam-e2e-worker2 -e WORKER_ID=w_e2e_second worker`（同镜像/同 token/可注册可心跳可被分派），写明两条被否捷径的因果；明确「少于 2 个在线节点必须 FAIL，不得静默 skip」。
4. T13 门禁改为「**无新增失败**」（写明 bare-catch 预存在红 + base-sha 实测命令 + 禁抬头基线）；dump 判据换成 `git ls-files --error-unmatch` 必须失败 + `git check-ignore` 留证。
5. T1 同步替换 dump 判据并纠正错误括注。
6. SC6 改为「四项 PASS + 门禁无新增失败（唯一红为预存在 bare-catch）」。
7. T4 六种回退全部要求同时断言 `logger.warn`（与 SC3 对齐）；补 B1 有意拒选注记；「等价硬断言」改标为「补充判据、不等价」。
8. 笔记逐条折入：`:628`、`:1290` 文档注释、`:2337`、`Dockerfile:24`、`TeamMemberView:57-70`、teams.controller 行号、porcelain 措辞、删 e2e build 计数、`worker-stub-server.py` 正名。

## Review round 5（收敛上限轮：对四次修复后的计划重跑双路）
```json
{
  "transition": "replace",
  "phase": "review_round_initialized",
  "atomic": true,
  "review_required": true,
  "plan_path": ".omo/plans/team-worker-node.md",
  "plan_sha256": "cad0429457bd420e58752844020b8df56276f466b3a50b34eae2dc45b4026dc3",
  "review_round_id": "r5-team-worker-node-20261014T022351Z",
  "round_status": "active",
  "pending-action": "review .omo/plans/team-worker-node.md",
  "review": {
    "momus": { "status": "pending", "workspace_root": "/Volumes/SSD-Data/01work/git-project/vteam", "runtime_home": null, "target": ".omo/plans/team-worker-node.md", "round_id": "r5-team-worker-node-20261014T022351Z", "plan_sha256": "cad0429457bd420e58752844020b8df56276f466b3a50b34eae2dc45b4026dc3", "launch_id": "momus-l5-20261014T022351Z", "session": null, "result": null },
    "independent": { "status": "pending", "workspace_root": "/Volumes/SSD-Data/01work/git-project/vteam", "runtime_home": null, "target": ".omo/plans/team-worker-node.md", "round_id": "r5-team-worker-node-20261014T022351Z", "plan_sha256": "cad0429457bd420e58752844020b8df56276f466b3a50b34eae2dc45b4026dc3", "launch_id": "oracle-l5-20261014T022351Z", "session": null, "result": null }
  },
  "convergence": {
    "max_rounds": 5,
    "round": 5,
    "cap_reached_after_this_round": true,
    "on_cap_reached": "stop_report_outstanding_blockers_ask_user",
    "ledger_frozen_after_round": 1,
    "accepted_blockers_r4": [
      "T11 与 T10 并行 ⇒ TS2339（类型声明滞后）",
      "gate.sh 开工前已红（bare-catch 176>175）而验收要求 exit 0",
      "前置 2 两条构造均不可行 + skip 与四项 PASS 矛盾",
      "dump 未入库判据零检出（.gitignore:45 忽略证据 .sql）"
    ],
    "non_blocking_notes_r4": ["e2e build 计数（已删数量）", "--stat 补充判据被误标等价", "agents.service.ts:628 返回类型成员", "B1 与 defaultModelId 并存的有意拒选", "remove() :1290 文档注释", "porcelain 对比措辞", ":2338→:2337", "Dockerfile:24 才是 dist COPY"],
    "closure_round_scope": ["accepted_ledger_blockers", "regressions_introduced_by_fixes", "new_findings_passing_blocker_eligibility"]
  }
}
```

# Draft: team-worker-node

## Components (topology ledger)
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
- C1 团队级首选 worker 设置（Team 列 + PATCH /teams/:id + 团队详情页控件）| active | server/prisma/schema.prisma:86-115, server/src/teams/dto/update-team.dto.ts:1-46, server/src/teams/teams.service.ts:285-311,313-390, web/app/(main)/teams/[id]/page.tsx:141-144,294-303
- C2 成员级首选 worker 设置（TeamMember 列 + PATCH /teams/:id/members/:memberId + 成员面板控件，默认「跟随团队」）| active | schema.prisma:177-204, server/src/teams/dto/add-member.dto.ts:49-95, teams.service.ts:801-900, web/src/components/teams/TeamMembersPanel.tsx:348,464-498,643-724, session/page.tsx:1117-1119,1310-1330
- C3 分派期优先级链（worker-dispatcher 解析 → AssignmentRequirement → assignWorker 优先命中）| active | server/src/chat/worker-dispatcher.ts:2233-2370,3812-3832, server/src/workers/workers.service.ts:69-80,863-899
- C4 不可用回退 + 悬空引用清理（离线/行缺失/容量不足/模型不符 → 软回退；worker 删除时清空团队与成员引用）| active | worker-dispatcher.ts:2318-2359, workers.service.ts:1315-1322
- C5 未设值零回归 + 迁移带引号守卫 + 测试 | active | worker-dispatcher.ts:2280-2316, server/src/prisma/model-usage.migration.spec.ts（守卫范式）
- C6 删除从未生效的 Agent.workerId（列 + DTO + 服务投影 + 下拉 + 原型/testid 清单）| active | schema.prisma:651-652, agents.service.ts:66,104,361,652,678, agents/dto/update-agent.dto.ts:85-91, workers.service.ts:1319-1322, web/app/(main)/agents/page.tsx:172-176,1526,1549,2048-2090,2846-2852, web/e2e/reference/testids.ts:156, docs/agent-platform/prototypes/agent-config/index.tsx:798
- C7 DTO 投影同步（团队 DTO 与任务实例 DTO 必须同时返回新字段，否则回显被 null 覆盖）| active | server/src/tasks/tasks.service.ts:2005-2032（⚠️ 现有注释明确记录了该踩坑）, web/src/api/teams.ts:10-23, web/src/components/tasks/task-detail-types.ts:22,128-137

## Open assumptions (announced defaults)
<!-- assumption | adopted default | rationale | reversible? -->
- 不可用节点的处置 | 软绑定：置顶节点不满足「存在 + 非 offline + 剩余容量 ≥ 1 + 满足模型要求」任一条件时，回退现有 assignWorker 自动调度，仅写 warn 日志 | 与既有离线重分配路径（worker-dispatcher.ts:2318-2359）和「不做硬绑定，不瘫痪」先例一致；置顶是**候选内的偏好**，不绕过容量/模型约束 | 可逆（若希望置顶压过容量，改筛选分支一处）
- degraded 节点 | 不否决置顶（与既有「仅 offline/行缺失触发重分配」判定一致） | :2322 只把 offline/missing 视为不可用 | 可逆
- 保存期校验强度 | 弱校验：worker 不存在/离线仍允许保存，仅 warn（对齐 warnIfOpencodeAgentUnknown 先例） | 纯配置操作不应被 worker 可用性阻断 | 可逆
- 改设置的生效时机 | 只影响后续新绑定；已绑定会话继续复用其 Session.workerId 直到该 worker 离线 | 立即重绑会杀掉在跑会话，破坏性不可接受；强制重绑可走已有 reset-session 入口 | 可逆
- 成员控件位置 | 只在 TeamMembersPanel（会话页左栏）加，团队详情页成员行不加（与 overrideModelId 的既有落点一致） | 单一落点，避免两处重复实现 | 可逆
- 团队级控件位置 | 团队详情页设置区，与「记忆开关」同区，样式为同款下拉/chip | 该页已是团队级配置的唯一入口 | 可逆
- 设置粒度 | 单节点软绑定（非节点池/允许列表） | 用户 Q2 决策 | 可逆
- 测试策略 | tests-after（server jest 单测 + migration 守卫 spec + web playwright 可选） + 端到端冒烟脚本；agent-executed QA | 仓库既有约定（jest rootDir=src，spec 与源码同目录，scripts/e2e-*.sh 前缀） | 可逆

## Findings (cited - path:lines)
- 分派 worker 的唯一漏斗是 `WorkerDispatcher.dispatchForTeamTarget`（worker-dispatcher.ts:2233）：由 `dispatch()`（:1770）循环 target 进入，`dispatchAgentMention()`（:1827）亦回流至此；全仓 `assignWorker` 9 处调用里只有 :2305 / :2335 属分派链路。
- 现行 worker 选择三段式：① 复用 `Session.workerId` + 非 'pending' 的 `instanceRef`（:2280-2288）→ ② 否则 `assignWorker(assignmentReq)`（:2305）→ ③ 绑定行缺失或 status=offline 时 `unbindSession` 后重新 `assignWorker`（:2318-2359）；degraded 不触发重分配。
- `AssignmentRequirement` 仅 3 字段（workers.service.ts:69-80）；`assignWorker` 过滤 = 非 offline + 剩余容量 ≥ need + opencodeVersion 精确匹配 + `matchesModelRequirement`，排序 = online 优先、容量降序（:881-898）。**无任何偏好入参** —— 扩展点就是这里。
- 团队与成员都没有 worker 设置（Q1 探查结论）：`model Team`（schema.prisma:86-115）只有 reuseSession/managedMode/currentTaskId/mainAgentMemberId/version；`model TeamMember`（:177-204）只有 alias/seq/workDir/overrideModelId/roleId/opencodeAgentName；`grep workerId server/src/teams/dto/` 无命中。基线 DDL 同样无列（20260925000000_squashed_baseline/migration.sql:858-869 teams、:780-798 team_members）。
- 模型解析链是可照抄的先例（worker-dispatcher.ts:2290-2302）：`teamMember.overrideModelId` > `taskContext.overrideModelId` > `agent.defaultModelId`（沿 baseAgentId 链 :3922-3950）→ 作为 `AssignmentRequirement.modelId` 过滤候选 → 会话模型 `agentModelId ?? workerRow.defaultModelId ?? null`（:2365-2367）。成员级 resolver 为 fail-open（:3812-3832：查不到/异常 → warn + null，不阻断分派）。
- `Agent.workerId` 是死字段：全仓仅 3 处读取（agents.service.ts:66 类型、:652/:678 DTO 序列化）与 2 处写入（:361 PATCH、workers.service.ts:1319-1322 worker 删除时置空）；分派期 agent 查询只取 id/name/prompt/persona/agentKey（worker-dispatcher.ts:2502-2511），模型 resolver 取 {id,defaultModelId,baseAgentId,type}（:3929-3937）——**零处读 agent 的 workerId**。而 web 端 `agent-worker-select` 已上线（agents/page.tsx:2048-2090），`.omo/plans/model-management.md:15,32` 亦承诺「软绑定 + 离线自动回退」→ 契约与实现不符，用户 Q3 决定删除。
- 删除面的坑：agents/page.tsx 的 `workers` prop 同时被 `EffectivePermissionSection`（重启全部 worker，:835-862,1069,1409-1415）消费，**删下拉不能删 workersQuery/prop**，只删 `workerDraft`、`sortedWorkers`、`ApiWorkerRow` 在 Agent 详情区的用途、payload 的 `workerId` 与 AgentItem 的 `workerId` 字段。
- 基线里 `agents.worker_id` 无 FK、无索引（migration.sql:130，PRIMARY/UNIQUE/KEY/CONSTRAINT 段 :135-141 均无 worker_id）→ `ALTER TABLE agents DROP COLUMN worker_id` 是干净操作。
- testids 清单 `web/e2e/reference/testids.ts` 无人 import（全仓 grep 仅自身），是参考文档；`:156` 的 `agent-worker-select` 位于 auditPage「2.1 agent-config（Agent 配置）」route `/agents` 段；同名 testid 亦存在于原型 `docs/agent-platform/prototypes/agent-config/index.tsx:798`。
- 成员字段投影陷阱（既有注释记录）：会话页成员面板优先读任务实例 DTO，**任务 DTO 与团队 DTO 必须同时返回该字段**，否则正确值被 null 覆盖（tasks.service.ts:2023-2030）。新字段须三处同步：teams.service findOne/成员 DTO、tasks.service 实例投影、web 两处类型映射。
- worker 删除时的引用清理现状（workers.service.ts:1315-1322）：`agent.updateMany({ where: { workerId: id }, data: { workerId: null } })` + sessions 置空 → 新增团队/成员两处同类清理，否则留悬空 id。
- 写路径与 UI 惯例：团队详情页 PATCH 带 `version` 乐观锁（web/app/(main)/teams/[id]/page.tsx:141-144），成员 PATCH `/teams/:id/members/:memberId`（session/page.tsx:1117-1119，invalidate ["team",teamId] + ["task",queueHeadTaskId]），控件为「chip + 展开列表 + 首项跟随默认」（TeamMembersPanel.tsx:643-724），无共享 Select/Chip 组件、无 i18n，文案内联中文 + data-testid + 中文 aria-label。
- 迁移约定：`<YYYYMMDDHHMMSS>_<snake_case>/migration.sql` 手写 DDL（中文理由头 + 逐列论证 + why-not 段；列宽 varchar(191)），必须配 `server/src/prisma/<slug>.migration.spec.ts` 守卫（基线不得重复建表、schema↔DDL 双向等价、无 FK/UPDATE/INSERT）。先例：20261010030000_worker_update_state。
- 门禁：`bash scripts/gate.sh`（server: prisma generate → lint:check → test → test:e2e → build；worker；web），lint 基线 0 err。规格化 QA 用 `scripts/e2e-<subject>.sh` 针对 live compose（web :13001 / server :13000）。

## Decisions (with rationale)
- D1 优先级链（用户 Q1）：**成员显式 > 团队 > 现状**。成员控件的默认项是「跟随团队」；成员显式选择压过团队（与「成员 overrideModelId > 模板默认」同构），团队设置作为团队级默认值，两级皆空 → 完全走今天的自动调度。
- D2 数据模型（用户 Q2 + 仓库惯例）：属主行上加可空列 `teams.preferred_worker_id`、`team_members.preferred_worker_id`（均 varchar(191)，无 FK，对齐 workers/agents 既有写法）。不建设置表、不做 Json 池。
- D3 解析落点：在 `dispatchForTeamTarget` 内解析（两个 fail-open 私有 resolver，照抄 resolveMemberOverrideModelId），把结果作为**新字段 `AssignmentRequirement.preferredWorkerId`** 传给 `assignWorker`；候选过滤与排序逻辑集中在 WorkersService 一处，回退自动发生且零改动现有 8 处调用方。
- D4 置顶判定：置顶节点只有满足全部既有过滤条件（非 offline、容量 ≥ need、matchesModelRequirement）才被选中，否则按原排序正常挑选 —— 未设值时行为与今天**逐字节一致**（不新增查询分支以外的任何副作用）。
- D5 引用清理：`WorkersService.remove()` 同步清空 teams / team_members 的 preferred_worker_id（照抄 :1319-1322）。
- D6 删除 Agent.workerId（用户 Q3）：schema 列 + migration DROP COLUMN + AgentRow 类型/toAgentDto×2/PATCH spread + UpdateAgentDto 字段 + workers.service 清理语句 + web 下拉与 draft/state/payload + testids 清单条目 + 原型页条目。分派链、Session/Worker/TaskGroupInstance 的 workerId 一律不动。

## Scope IN
- 团队级「首选 worker 节点」：DB 列 + UpdateTeamDto/服务校验/乐观锁 + PATCH /teams/:id + 团队详情页控件（含「自动调度」默认项 + 在线/离线标记）。
- 成员级「首选 worker 节点」：DB 列 + UpdateMemberDto + PATCH /teams/:id/members/:memberId + TeamMembersPanel chip「跟随团队/节点名」+ 会话页接线与缓存失效。
- DTO 投影三处同步（团队 DTO、任务实例 DTO、web 两处类型映射）。
- 分派期链路：两个 fail-open resolver + `AssignmentRequirement.preferredWorkerId` + assignWorker 置顶优先 + 离线/容量/模型不符软回退 + warn 可观测。
- 删除 Agent.workerId 全链（列/DTO/服务投影/下拉/testids/原型）。
- worker 删除时引用清理；迁移（手写 SQL + 守卫 spec）；单测扩展（worker-dispatcher、workers.service、teams.service）；web testid 注册；`bash scripts/gate.sh`；端到端冒烟脚本。

## Scope OUT (Must NOT have)
- 不做硬绑定：置顶节点不可用时**不得**阻塞执行、不得等待其恢复。
- 不做节点池/允许列表/按能力或标签路由；不改 worker/ 目录任何代码；不新增 provider/模型语义。
- 不改 `Session.workerId` 复用语义、不在改设置时重绑或中断在跑会话（强制重绑仍走已有 reset-session）。
- 不改权限模型（沿用 teams.edit）；不改 teams 路由结构；不新建设置页/Tab。
- 不保留 Agent 级 worker 偏好（用户已决定删除，不得顺手改成「纳入链路」）。
- 不迁移/不回填存量数据（两列全为新空列；`agents.worker_id` 存量值随列一并丢弃 —— 该列从未参与分派，无机读价值）。

## Open questions
- 无阻塞问题。用户 Q1/Q2/Q3 已定；其余 6 项以 announced defaults 记录，可在审批时否决。

## Approval gate
status: approved（用户「批准」）→ 计划已写 .omo/plans/team-worker-node.md
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

## Metis 差距分析（已静默折入计划，逐条留存以备复核）
- X2/D3 补充：另外 8 处 `assignWorker` 调用方**全部无参或仅 `opts.workerId` 兜底**，这才是「新增可选字段对其行为中性」的真正依据 → 计划写成可断言的不变量（无参调用候选集与今日一致）。
- X3 修正：`assignWorker` 是**四道**过滤（还含 `opencodeVersion` 精确匹配 `workers.service.ts:888-889`），计划要求四道全保留并各配用例。
- X4 修正：置顶**同时作用于离线重分配路径**（`worker-dispatcher.ts:2335` 复用同一 assignmentReq），不只是新绑定；改设置仍不主动重绑健康会话。
- B1 新增 todo 要求：`matchesModelRequirement` 对「从未上报模型能力」返回 true（`workers.service.ts:923-925`），置顶会把它变成确定性选择而静默击穿 C7 → 置顶分支附加「modelId 非空时拒绝无 availability 的置顶」且**不改全局语义**。
- B2 新增可观测要求：`agentModelId === null` 时最终模型取自 `workerRow.defaultModelId`，置顶会改变兜底来源 → 必须 warn。
- A1 记为 Must NOT + 语义诚实声明：`platform-mcp` 的两条会话 adopt（`:7296-7313`、`:7396-7423`）会把 `resetTeamSessionsInTx` 重置后的空绑定会话认领给调用方节点，置顶只治分派期；该路径是反冒充安全代码，禁止改动。
- A2 记为 Must NOT：`/agents/*` 全局端点无 teamId 上下文，不得团队感知。
- C1 关键遗漏补入：`agents.service.spec.ts:295-316` 是 **DTO 精确键集断言**，删字段即硬失败 → 成为 Todo 2 的必改项。
- C4/C5 补入：原型两页（`agent-config/index.tsx:8,161,782-821`、`agent-manage/index.tsx:20,829`）。
- C3/S7 反向守卫：四处「取数 worker」同名不同物，禁止误删。
- E2/E3/E4 迁移结论：**追加**新迁移目录（不碰基线，`docs/migration-baseline.md:30-32`），`agent-role-drop.migration.spec.ts:1-15` 的「折叠进基线」先例**故意不照做**；守卫断言按 DROP **反转**；QA 前置补「重建 compose 栈让 init 服务应用迁移」。
- E4/O1 单向 DDL 的处置（原为 Metis 唯一建议升级为 owner-question 的项）：经查 `docs/tech-debt-rollback.md:1-90` **本仓已存在 DROP COLUMN 的回滚契约**（预检 mysqldump + 一步 restore + 「代码回退不能撤销删列」），且历史上确有 drop 以追加迁移形式发布（`20260907000001_drop_task_agent_domain`、`20260919000010_drop_agents_role`，现归档在 `.omo/evidence/tech-debt-remediation/legacy-migrations/`）。故**默认单次发布**，并把「预检 dump + 内联回滚契约」提升为独立 Todo 1；该默认已列入交付说明的「to sanity-check」。
- X-A 规模/预算轴：置顶会削弱负载均衡，容量过滤是唯一刹车，全部置顶节点打满时所有置顶成员会同时回退 → 计划以「软回退 + warn」如实呈现，不引入新机制。
- X-C：新列**不建索引**（软引用列不参与过滤/排序），作为显式决策记录。
- X-D：写权限点已核实——`PATCH /teams/:id` 与 `PATCH /teams/:id/members/:memberId` 均 `@RequirePermission('teams.edit')`（`teams.controller.ts:60-70,73-80`），本方案不新增权限点。

## 评审终态（TERMINAL）
- **round 5（收敛上限轮）结果**：momus `changes_requested`（1 条：T13 QA happy 行仍要求 `gate.sh exit=0`）；independent(oracle) `changes_requested`（2 条：同一 T13 QA 行 + T12 第二个 worker 会宣告第一个 worker 的地址，后者我已逐字复验 `docker-compose.yml:137` / `worker/client.ts:1102-1108`）。**5 轮均未达成两路无条件通过。**
- **用户决定（2026-10-14）**：**接受，以 approved-with-notes 交付**（不追加第 6 轮）。
- **处置**：2 条残留作为「执行期已知残留」写入计划的 Final verification wave，并声明「凡与 Final verification wave 冲突者以该节为准」：
  - `F1 ⑥` —— 门禁按「无新增失败」判定（bare-catch 176>175 为开工前既存红；`gate.sh:70-71` 禁抬高基线）；据此**废止** T13 QA 行的 `exit=0`、`前置 1` 里「8 个 e2e 脚本全部先 build」的旧表述、以及 `porcelain | grep -c 'ddl-*'` 这一零检出判据（以 Todo 1 的 `git ls-files --error-unmatch` 必须失败为准）。
  - `F3 ②` —— 第二个 worker 必须用 `-e WORKER_ADVERTISE_HOST=http://vteam-e2e-worker2` 宣告**自己的**地址，并钉死 `w_a`=`w_compose_worker` / `w_b`=`w_e2e_second`。
- **诚实声明**：这不是「双路无条件通过」，而是**用户在知晓 2 条残留后主动接受**；两条残留的权威判据在 F1/F3，执行者按 F 波执行即可，不会误报或误改。
- **最终计划 digest（交付时实测）**：`b8092717acaed90d1164adb75c89eee23b7aa9398a27c3650bc54371c70df036`（路径 `.omo/plans/team-worker-node.md`；该 digest 与 round-5 评审的 `cad04294…` 不同，差异**仅**为用户所选处置方式写入 F1/F3 的那段；round-5 收据对应的内容为 `cad04294…`）。
- **未折入的非阻塞笔记（遗留备查，均已被 F 波覆盖或无害）**：`:2337/:2338` 抛错行位（throw 在 2337、2338 为消息行）、Todo 9 的 `Blocks` 欠声明、T12 头部可加「第二个容器经兄弟容器满足可达性」的说明。

