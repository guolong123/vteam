# session-right-panel-plan-overhaul - Work Plan

## TL;DR (For humans)

**你会得到什么**：会话页右侧面板按已确认的原型改版落地（团队 Tab 从 5 个子页收到 2 个、任务 Tab 从 5 个收到 4 个、有任务默认落在任务），同时把一直「跑完没内容」的**计划 Tab** 修成有真实内容——计划文档卡变成唯一聚合区，同时显示本地计划文件与 `category=计划` 的产出物；任务进入待验收时系统**自动**把三处计划目录里的文件归档成带「计划」分类的产出物。附带修完 P0–P2 共 10 项缺陷。

**为什么这个做法**：实测证明计划 Tab 的三个数据源（DB `plans` 表 / `.opencode/plans` 文件 / opencode todo）**从头到尾没被写过**，而计划内容其实早就存在——只是被 agent 当普通产出物提交、且词表里根本没有「计划」这一类能认领它。所以修法不是逼 agent 改行为，而是**系统侧兜底**：扩词表让内容有归属 + 自动归档让没传分类的文件也不漏 + worker 扩目录让 OmO 原生写的草稿也能被读到。三处改动互相咬合，缺一个计划 Tab 还是空的。

**它不会做什么（红线）**：**不改任何角色/技能提示词**（不过度控制 agent 行为）；`category` 仍是**可选**、不改 MCP 公开契约；**不回填**历史产出物分类；不重建计划生命周期状态机、不删轮次账本/归档回执/冻结哈希/定稿确认按钮/执行清单等评审闭环；不改写入落点 `PLAN_DOCS_DIR`；**不在读路径写库**；不接回 16 个孤儿 playwright spec；不改主题。

**工作量**：28 个实施 todo 分 7 波 + 4 个最终验证 todo，跨 `server/`、`worker/`、`web/` 三包。核心链路集中在词表（1 波）→ worker 目录（1 波）→ 自动归档（1 波）→ 前端计划区（1 波）→ 右栏结构（1 波）→ 缺陷收口（1 波）→ 门禁文档（1 波）。

**风险（已逐一设防）**：① 改词表有 **5 个必须一致的位点**，而现成的 parity 门只覆盖 2 个——另 3 处硬编码串单独 todo + 断言兜住；② 自动归档若写成 `type:"plan"` 会触发既有的 `plan-removal.guard` 变红——todo 9 专门锁这条不变量；③ 给 `docs-unified.spec.ts` 加「计划」fixture 会把 `toHaveCount(10)` 打成 11、三条断言全崩——todo 27 明确**禁止加 fixture**，改为实跑确认；④ 自动归档写库失败不得拖垮任务状态机——全程对齐既有 `fetchAndArchiveAttachment` 的「失败仅 warn」语义；⑤ plan-steps 会话定位不带 taskId 会跨任务串数据——todo 13 补任务维度。

**关键决策（均已由你拍板，非本计划自选）**：计划 Tab 保持原型 **3 张卡**、其中「计划文档」卡是唯一展示地区（Q5/Q1）；自动归档**三处全归档**含草稿（Q7）；不回填历史数据（Q2）；`category` 保持可选（Q3）；测试策略 **tests-after**（Q4）；撤销提示词强引导改为系统自动归档（D7）。另有 7 项可否决的默认已列在 `Announced defaults`，其中最值得注意的是**自动归档触发时机取在 `pending_review`**（不在读路径写库）。

## Scope

### 目标

把会话页右侧面板对齐已确认的改版原型，并让「计划」从结构性空壳变成有真实内容的区域——**内容靠系统侧兜底，而不是控制 agent 行为**。同时修掉本会话确认的 P0–P2 缺陷。

### Scope IN（全部必做）

| 编号 | 范围 | 关键锚点 |
| --- | --- | --- |
| C1 | **右栏结构对齐原型**：团队子页 5→2（概览合并「设置+记忆」、渠道保留、删成员列表卡、创建任务上提到概览、历史任务降为次级链接、「操作」子页解散）；任务子页 5→4（删「配置」，其字段并入状态卡元信息）；有任务时默认落「任务」；主 Tab 切换保留各自子页状态；状态卡去队列摘要行 + 按钮改三层；产出页去「任务详情」 | `web/src/components/teams/TeamRightPanel.tsx:174,282-292,752,1041-1052,1293,1058-1071,1063-1065,1179-1183,317-334,406-411`；原型 `.omo/drafts/session-right-panel-proto/index.tsx:395-457,572-685` |
| C2 | **计划 Tab 保持原型 3 张卡**（计划状态 / 计划文档 / 执行步骤）：状态卡原样承载全部评审闭环（轮次账本 `:522-547,617-635`、归档回执 `:636-659`、冻结版本哈希 `:591-608`、定稿/确认按钮 `:660-681`、执行清单 `:685-710`、文档上传 `:1099-1108`）；**「计划文档」卡改造成唯一内容聚合区**（worker 三目录感知文件 + `category=计划` 产出物，来源徽章，可点开正文）；补 6 处 isError 与 degraded/真空区分；修 plan 查询 isMember 门；plan-steps 会话定位补 taskId 过滤 | `TeamRightPanel.tsx:1090-1176,493-498,219,693,1115,1152,1189,1223,496,483-485`；`server/src/tasks/plan-steps.service.ts:52-59`；`server/src/tasks/plan-docs.service.ts:85-103` |
| C3 | **词表加「计划」+ 5 位点一致**：`server/src/artifacts/artifacts.constants.ts:16` 数组、`web/src/lib/artifact-categories.ts:7` 镜像、`server/src/platform-mcp/platform-mcp.tools.ts:230` describe 串、`server/src/platform-mcp/platform-mcp.service.ts:2713` BadRequest 串、`server/src/artifacts/artifacts.service.ts:101` validate 串；parity 一行 diff 复验；**category 保持可选** | 现有 parity 命令：`.omo/evidence/docs-artifacts-merge/task-4-category-write.md:18` |
| C3b | **计划目录自动归档**：任务进入 `pending_review`（`mark-pending-review`）时扫描一次、`accept` 幂等兜底再扫一次；扫描 `<任务目录>/{.opencode/plans,.omo/plans,.omo/drafts}/*.md` **三处全归档**；对未归档内容复用 `artifactsService.archiveFile(..., category:'计划')`；失败仅 `logger.warn` 不阻断；**不在任何读路径写库** | `server/src/artifacts/artifacts.service.ts:395-496`（sha256 去重 `:411-420`）、先例 `server/src/platform-mcp/platform-mcp.service.ts:6361-6414`（`fetchAndArchiveAttachment`）、`server/src/tasks/work-dir.util.ts:34 taskDirOf` |
| C3c | **worker 扫描目录扩容**：`worker/src/exec/exec-server.ts:143` `PLAN_DOCS_DIRS` **末尾**追加 `'.omo/drafts'`；`PLAN_DOCS_DIR = PLAN_DOCS_DIRS[0]` 写入落点**不动**；`:141,:1011,:1057` 注释与日志同步 | `worker/src/exec/exec-server.ts:143-145,451-452,988,1011,1020,1057,1069,1136` |
| C3d | **角色/技能提示词一律不改**：不加 category 引导、不改 `server/prisma/seed.ts`、不加提示词回填迁移（D7 红线） | `seed.ts:507-509,566,568,583,1386,1855` 仅作现状参考 |
| C4 | **P0×2 + P1×4**：reuseMutation no-op（`:374-375` 应传 `!reuseSession`，对照正确路径 `:386`）；计划 Tab 结构性空壳（由 C2/C3b 解决）；6 处错误伪装成空（`:219,:693,:1115,:1152,:1189,:1223`）；isMember 门（`:496`）；plan-steps 定位（`plan-steps.service.ts:52-59`）；产出/Issue `slice(0,5)`（`:1193,:1227`） | 见各条行号 |
| C5 | **P2×3**：队列空态文案（`:76-101`）、触发器 `retry:false`+30s 错误刷屏（`:819`）、`resetAfterComplete` 暴露到 `toTaskDto`（`tasks.service.ts:1817`，字段现仅在 `:81,:400,:706-707,:1709,:1722`）。**注：原列的「成员列表空态 `:317-333`」已作废**——该卡在 C1 整卡删除（Metis 缺陷 #2 修正），残留核查见 todo 23 | 见各条行号 |
| C6 | **质量门 + 文档 + 原型同步**：tests-after 补测；`docs/agent-platform/12-产出物协议与文档库.md` 补「计划」类 / worker 多目录 / 自动归档说明；改码前把原型补到最终设计并重新部署 | 见 Verification strategy |

### Scope OUT（Must NOT-Have，逐条禁止）

1. **不改任何角色/技能提示词**——不加 category 引导、不改 `seed.ts`、不加提示词回填迁移。
2. 不重建计划生命周期状态机（`plans` 表状态流转、评审轮次账本、冻结哈希机制语义一律不动）。
3. 不删除或降级：轮次账本、归档回执、冻结版本哈希、定稿/确认按钮、执行清单、计划文档上传。
4. 不把 `category` 改必填、不改 `type` 的 `text/doc/file` 语义、不改「未知字段忽略」的前向兼容（`artifacts.service.ts:52`）。
5. 不回填/改写任何历史产出物分类。
6. 不改 artifacts 表结构、不加 DB 表、不动版本/验收/去重语义。
7. **不改 `PLAN_DOCS_DIR`（写入落点）**——只扩读取扫描目录，用户上传仍落 `.omo/plans`。
8. **不在 `GET plan-docs` 等读路径上写库**——自动归档只走任务状态机事件点。
9. 不动 worker 执行引擎其他部分、`platform-mcp` 其他工具、realtime/事件链路、RBAC 矩阵、throttle 配额。
10. 不把 16 个孤儿 playwright spec 接回 `playwright.config.ts`（独立工程，超范围）。
11. 不改站点主题、不做视觉重设计（沿用 `web/src/theme/tokens.ts` 浅色）。
12. 不改变 `执行步骤` 的产出机制——它仍是主 Agent 会话 opencode todo 的只读透传（`tasks.controller.ts:174-180`「步骤状态只由 agent 经 opencode todo 工具推进，vteam 不写」），不加提示词逼 agent 用 todo 工具。

## Verification strategy

**测试策略：tests-after（用户 Q4 选定）** —— 改动完成后补/改测；agent 执行 QA 恒包含，零人工介入。

### 三包各自的可运行门（全部已实证存在）

| 包 | 命令 | 出处 / 说明 |
| --- | --- | --- |
| server 类型 | `cd server && npx tsc --noEmit -p tsconfig.json` | 无 `typecheck` script；先例 `.omo/evidence/docs-artifacts-merge/task-4-category-write.md:16` |
| server lint | `npm run lint --prefix server` | `server/package.json:15`（含 `--fix`） |
| server 单测 | `cd server && npx jest --runInBand <目标路径…>` | `server/package.json:16` `test = jest --runInBand`（**串行**）；目标：`src/artifacts src/tasks/plan-docs.service.spec.ts src/tasks/plan-steps.service.spec.ts src/platform-mcp` |
| worker 类型 | `cd worker && npm run typecheck` | `worker/package.json:14` `tsc --noEmit`（**worker 有该 script，web/server 没有**） |
| worker lint | （无 lint script；靠 typecheck + jest） | `worker/package.json:10-16` |
| worker 单测 | `cd worker && npm run test` | `worker/package.json:15` `jest --runInBand`（**串行**）；`worker/jest.config.js`；目标：`src/exec/exec-server.spec.ts` |
| web 类型 | `cd web && npx tsc --noEmit -p tsconfig.json` | 无 `typecheck` script；先例同上 `:16` |
| web lint | `npm run lint --prefix web` | `web/package.json:9` |
| web e2e | `cd web && npx playwright test --project=pages --project=docs` | **只用已接线 project**；跑前需 `next dev` :3001 + server :13000 + 系统 Chrome（`playwright.config.ts:6` 不自启 webServer）；JSON 证据落 `.omo/evidence/phase5-t9-playwright.json`（`:27`） |

### 词表 parity 门（5 位点）

现有 parity 只覆盖 2 个数组位点，**必须另跑 3 处硬编码串一致性**：

```bash
# 1) 数组 parity（从仓库根执行；出处 .omo/evidence/docs-artifacts-merge/task-4-category-write.md:18）
diff <(sed -n "/ARTIFACT_CATEGORIES/,/] as const/p" server/src/artifacts/artifacts.constants.ts | grep -o "'[^']*'" | sort) \
     <(grep -o "'[^']*'" web/src/lib/artifact-categories.ts | sort)   # exit 0

# 2) 3 处硬编码串含「计划」且与数组一致
grep -c "计划" server/src/platform-mcp/platform-mcp.tools.ts \
                server/src/platform-mcp/platform-mcp.service.ts \
                server/src/artifacts/artifacts.service.ts   # 各 >= 1
```

### 各能力域的最小验收（happy + failure）

| 能力 | happy QA | failure QA |
| --- | --- | --- |
| C3 词表 | jest `artifacts.service.spec.ts` category 套件（`artifacts.service.spec.ts:1166`）断言 `计划` 通过校验与落库；`QueryArtifactsDto` 过滤返回 `category=计划` 行 | 传非法 category 仍 400，且文案含「计划」；`submit_artifact` 不传 category 仍成功（可选语义不变） |
| C3c worker 目录 | `worker/src/exec/exec-server.spec.ts` 断言 `/plan-files` 扫描含 `.omo/drafts` 的文件 | 三目录同名文件 → 先命中目录优先（`exec-server.ts:1011`）行为不回归 |
| C3b 自动归档 | jest：pending_review 触发后三目录 `*.md` 均生成 `type=file, category=计划` 产出行 | 同内容二次触发 → `duplicate`（sha256 去重 `:411-420`）不涨版本；worker 不可达 → `logger.warn`、任务状态机不失败；**GET plan-docs 不产生任何产出行** |
| C2 计划内容区 | 前端渲染文件 + `category=计划` 产出物两类来源徽章；空时区分「暂无」与「暂不可用」 | `/plan-docs` 或 `/artifacts` 报错 → 显示错误态**而非**「暂无」（6 处 isError）；未登录 → 不卡「加载中」 |
| C1 结构 | `pages.spec.ts` 断言团队 2 子页 / 任务 4 子页 / 默认落任务 / 无「配置」tab / 状态卡按钮三层 testid | 切换主 Tab 后再切回，子页状态保持 |
| P0 | `reuseMutation` 点击后 `PATCH /teams/:id` body 为 `{reuseSession: !当前值}` | pending 中按钮 disabled；失败回显 settingError |
| P5 定位 | jest `plan-steps.service.spec.ts`：同 team 不同任务的会话不再串数据 | 主 Agent 无会话 / worker offline → `degraded:true` 而非空数组冒充「无步骤」 |

### 环境约束（必须写进执行）

1. **规划会话无 shell 工具** → 本计划所有命令由**执行 worker** 运行；规划阶段不代跑。
2. **scaffold 脚本不可用** → 本计划文件为手写，头部顺序严格为模板顺序。
3. e2e 前置：`next dev` :3001 + server :13000 已起 + 系统 Chrome。

## Execution strategy

**依赖顺序**：C3（词表，纯数据面、被 C2/C3b 依赖）→ C3c（worker 读取面）→ C3b（依赖 C3 的 category 值）→ C2（前端，依赖 C3 过滤 + C3b 产出）→ C1（纯结构，与上面弱耦合可并行）→ C4/C5（缺陷修复，多数与结构改动同文件，排在结构之后避免冲突）→ C6（门禁与文档收尾）。

**波次划分**（目标每波 3–8 个 todo；实施 + 测试 = 同一 todo）：

- **Wave 1 · 词表与契约**：C3 全部（server 4 位点 + web 镜像 + parity + 相关 jest）
- **Wave 2 · worker 读取面**：C3c（`PLAN_DOCS_DIRS` + `exec-server.spec.ts`）
- **Wave 3 · 自动归档**：C3b（扫描服务 + 事件触发接线 + 幂等/降级单测）
- **Wave 4 · 计划 Tab 内容区**：C2（聚合渲染 + 6 处 isError + isMember 门 + plan-steps 定位）
- **Wave 5 · 右栏结构**：C1（团队子页合并、任务子页删配置、默认落任务、状态卡布局、产出去详情）
- **Wave 6 · 缺陷修复**：C4 + C5（P0/P1/P2 收口）
- **Wave 7 · 门禁与文档**：C6（新 testid 断言进 `pages.spec.ts`、`docs/12` 同步、原型补最终设计并重部署）

**并行约束**：Wave 1/2/3 可串行（同链路）；Wave 5 与 Wave 3/4 无文件交集可并行；Wave 6 必须在 Wave 5 之后（同文件 `TeamRightPanel.tsx` 改动会冲突）；Wave 7 收尾。

**失败回退**：任一波门禁不过即停，不得带病推进下一波；C3b 写库失败必须降级为 warn（不得让任务状态机失败）。

## Todos

- [x] 1. server 词表 4 位点原子加「计划」（数组 + 3 处硬编码串）
  - References: `server/src/artifacts/artifacts.constants.ts:16-24`（`ARTIFACT_CATEGORIES` 追加 `'计划'`）；`server/src/platform-mcp/platform-mcp.tools.ts:226-231`（`describe` 串改为「需求/设计/实现/计划/测试用例/测试报告/运维/其他其一」，`z.enum(ARTIFACT_CATEGORIES)` 自动跟随）；`server/src/platform-mcp/platform-mcp.service.ts:2706-2715`（BadRequest 文案含「计划」）；`server/src/artifacts/artifacts.service.ts:92-103`（`validateArtifactDeclaration` 非法值文案含「计划」，`:101`）。**4 处必须同 commit 改完**——拆开会产生「数组 8 类 / 文案 7 类」漂移。**严禁**改动 `ARTIFACT_TYPES`（`:6`，见 todo 18 不变量）。
  - Acceptance: `ARTIFACT_CATEGORIES` 长度由 7 变 8 且末尾/插入位含 `'计划'`；3 处串与数组 8 类完全一致；`type` 仍为 `['text','doc','file']` 三态未变；`category` 参数仍是 optional（`platform-mcp.tools.ts:228` `.optional()` 保留）。
  - QA happy: `cd server && npx tsc --noEmit -p tsconfig.json` → exit 0，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-1-tsc.txt`
  - QA failure: `grep -n "计划" server/src/platform-mcp/platform-mcp.tools.ts server/src/platform-mcp/platform-mcp.service.ts server/src/artifacts/artifacts.service.ts` → 三文件各 ≥1 命中，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-1-hardcoded-strings.txt`（少一个即失败）
  - Commit: `feat(artifact): ARTIFACT_CATEGORIES 加「计划」并同步 3 处硬编码枚举串`
- [x] 2. server jest category 套件扩展（「计划」通过 / 非法值文案 / 过滤）
  - References: `server/src/artifacts/artifacts.service.spec.ts:1166`（既有 `category（docs-artifacts-merge T4：落库/过滤/透出）` 套件，在其内新增用例）；`server/src/artifacts/artifacts.service.ts:92-105 validateArtifactDeclaration`、`:495-516 findByTask`（`category` 过滤）、`:423-438 archiveFile` 写入；`server/src/artifacts/dto/artifact.dto.ts:76 QueryArtifactsDto.category`。
  - Acceptance: 新增断言覆盖 4 条：① `category:'计划'` 通过校验并落库；② 非法 category → 抛/返回 `ARTIFACT_INVALID` 且 message **含「计划」**（证明文案已同步）；③ `findByTask` 传 `category:'计划'` 只返回该类行；④ 不传 category → 落库 `NULL`（可选语义未破坏）。
  - QA happy: `cd server && npx jest --runInBand src/artifacts/artifacts.service.spec.ts` → 全绿，证据 stdout 存 `.omo/evidence/session-right-panel-plan-overhaul/task-2-jest-artifacts.txt`
  - QA failure: 同命令下构造 `category:'计划计划'`（非法值）用例必须走错误分支且 message 含「计划」——若仍返回旧七类文案则失败
  - Commit: `test(artifact): 覆盖「计划」类校验/落库/过滤与新错误文案`
- [x] 3. web 词表镜像同步 + 跑双命令 parity 门
  - References: `web/src/lib/artifact-categories.ts:7-15`（`ARTIFACT_CATEGORIES` 加 `'计划'`，注释「同字面量七类」须同步为八类）；parity 命令出处 `.omo/evidence/docs-artifacts-merge/task-4-category-write.md:18`；`artifacts.constants.ts:14` 与 `artifact-categories.ts:5` 的「见 task-4 证据」注释。
  - Acceptance: web 镜像与 server 数组逐字一致（8 类）；两条命令均 exit 0；注释里「七类」字样改为「八类」。
  - QA happy: `diff <(sed -n "/ARTIFACT_CATEGORIES/,/] as const/p" server/src/artifacts/artifacts.constants.ts | grep -o "'[^']*'" | sort) <(grep -o "'[^']*'" web/src/lib/artifact-categories.ts | sort)` → exit 0，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-3-vocab-parity.txt`
  - QA failure: 故意只改 server 不改 web → 该 diff 非空（本地验证门有效后再还原），证据同上标注 `VOCAB_GATE=PASS`
  - Commit: `feat(artifact): web 词表镜像同步「计划」并复验 parity 门`
- [x] 4. worker `PLAN_DOCS_DIRS` 末尾追加 `.omo/drafts` + 注释/日志同步
  - References: `worker/src/exec/exec-server.ts:143`（`['.omo/plans', '.opencode/plans']` → `['.omo/plans', '.opencode/plans', '.omo/drafts']`）；**必须追加到末尾**（`:1011` 注释「同名文件以先命中的目录为准（PLAN_DOCS_DIRS 顺序即优先级）」，改序会改变既有优先级）；`:145 PLAN_DOCS_DIR = PLAN_DOCS_DIRS[0]` **不得改动**（写入落点）；`:141` 注释、`:1057` 日志 `dirs=${PLAN_DOCS_DIRS.join(',')}` 同步；`Scope OUT #7` 禁止改 `PLAN_DOCS_DIR`。
  - Acceptance: 数组含三个目录且 `.omo/drafts` 在**末位**；`PLAN_DOCS_DIR` 仍等于 `'.omo/plans'`；`:141`/`:1057` 注释与日志文案与新数组一致；写路径 `:1069`/`:1136` `path.join(directory, PLAN_DOCS_DIR)` 未被触碰。
  - QA happy: `cd worker && npm run typecheck` → exit 0，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-4-worker-typecheck.txt`
  - QA failure: `grep -n "PLAN_DOCS_DIR =" worker/src/exec/exec-server.ts` → 仍为 `PLAN_DOCS_DIRS[0]`，且数组首元素仍为 `'.omo/plans'`（证明写入落点未动）
  - Commit: `feat(worker): 计划文件扫描目录扩容 .omo/drafts（只扩读取面）`
- [x] 5. `exec-server.spec.ts` 补三目录扫描 happy 断言
  - References: `worker/src/exec/exec-server.spec.ts`（既有 spec，新增用例）；`exec-server.ts:988-1062 handlePlanFilesList`、`:1020 for (const rel of PLAN_DOCS_DIRS)`；`PlanDocsResult` 语义参照 `server/src/tasks/plan-docs.service.ts:19-20`（`degraded=false + files=[]` 才是「确实没有」）。
  - Acceptance: 断言 `GET /plan-files` 对三目录分别存在的 `*.md` 均返回，且每个 file 条目含 `name`/`updatedAt`/`size`/`content`（正文内联）；`.omo/drafts/foo.md` 必须出现在结果中。
  - QA happy: `cd worker && npm run test -- exec-server` → 全绿，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-5-worker-plan-files.txt`
  - QA failure: 三目录**均无** `*.md` 时返回 `files: []` 且**不报错**（目录不存在是常态，非 degraded）
  - Commit: `test(worker): 覆盖 /plan-files 三目录扫描与空目录常态`
- [x] 6. `exec-server.spec.ts` 补同名优先级断言 + worker 全量门
  - References: `exec-server.ts:1011` 注释（先命中目录为准）、`:1020` 遍历顺序；`worker/package.json:14 typecheck=tsc --noEmit`、`:15 test=jest --runInBand`；`worker/jest.config.js`。
  - Acceptance: 断言三目录同名 `x.md` 时返回的 `content` 来自**首个命中目录**（`.omo/plans` > `.opencode/plans` > `.omo/drafts`），次序不被本次改动破坏。
  - QA happy: `cd worker && npm run test` → 24+ spec 全绿（串行），证据 `.omo/evidence/session-right-panel-plan-overhaul/task-6-worker-full.txt`
  - QA failure: 故意把 `.omo/drafts` 挪到数组首位 → 优先级断言变红（证明断言真实有效），验证后还原
  - Commit: `test(worker): 锁定计划目录同名优先级不回归`
- [x] 7. 新建计划目录扫描归档服务（读三目录 → `archiveFile` 带 `category:'计划'`）
  - References: `server/src/artifacts/artifacts.service.ts:395-496 archiveFile(taskId,{fileRef,storedUrl,storedName,sha256,title?,category?},category?)`（`:411-420` sha256 去重；`:424 artifactCategory = category ?? args.category ?? null`；`:426-493` 同 title append 新版）；**自动归档先例** `server/src/platform-mcp/platform-mcp.service.ts:6361-6414 fetchAndArchiveAttachment`（worker fetchFile → `FileStorageService.saveBufferFile` → sha256 → `archiveFile(...).catch(warn)` → 失败不阻断主流程，逐字对齐此语义）；目录拼接 `server/src/tasks/work-dir.util.ts:34 taskDirOf` + `plan-docs.service.ts:76-78 taskDirectory`；三目录常量在 `worker/src/exec/exec-server.ts:143`（server 侧扫描须与之同名同序）。
  - Acceptance: 新方法 `scanAndArchivePlanDocs(taskId)`：列 `<taskDir>/{.opencode/plans,.omo/plans,.omo/drafts}/*.md`（三处**全归档**，Q7）→ 逐文件 `archiveFile(..., category:'计划')` → 单文件失败仅 `logger.warn` 继续下一项、**整体不抛**；`type` 恒为 `'file'`；**绝不生成 `type: "plan"`**（Scope OUT #18 + plan-removal guard）。方法**不在任何 GET handler 中被调用**（Scope OUT #8）。实现与单测在本 todo 一并交付。
  - QA happy: `cd server && npx jest --runInBand src/tasks/plan-archive.service.spec.ts` → 断言：三目录各 1 个 md → 产出 3 条 `type=file,category=计划` 行，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-7-archive-happy.txt`
  - QA failure: 同 spec 断言 ① 同内容重复调用 → `status:'duplicate'`、`currentVersion` 不变（sha256 去重 `:411-420`）；② `archiveFile` 抛错 → 捕获为 warn、方法正常返回、任务状态机未失败；③ `grep -rn 'type:.*"plan"' server/src` → 0 命中
  - Commit: `feat(plan): 计划目录自动归档服务（三处全归档，失败降级 warn）`
- [x] 8. 触发接线：`mark-pending-review` 主扫描 + `accept` 幂等兜底
  - References: `server/src/tasks/tasks.controller.ts` `@Post('tasks/:id/mark-pending-review')`（`markPendingReview`，约 `:300-310`）与 `@Post('tasks/:id/accept')`（`accept`，约 `:316-329`）；service 侧 `server/src/tasks/tasks.service.ts` `markPendingReview` / `accept`（`accept` 中已含 `promoteNextInTx` 与记忆重置事务，见 `:1709-1722`，扫描须在状态落库**之后**、且**不在该事务内写 artifacts** 以避免锁竞争——采用 fire-and-forget `await scan().catch(warn)` 模式，对齐 `fetchAndArchiveAttachment` 的不阻断语义）；禁用点：`plan-docs.service.ts:85-103 listPlanDocs`（读路径，Scope OUT #8 明确不得调用）。
  - Acceptance: `mark-pending-review` 成功后触发一次扫描；`accept` 成功后再触发一次（幂等，靠 sha256 去重不重复入版）；扫描失败只 warn、不改变 200 响应、不回滚状态迁移；`GET /tasks/:id/plan-docs` 调用链中**无** `scanAndArchivePlanDocs` 引用。
  - QA happy: `cd server && npx jest --runInBand src/tasks/tasks.service.spec.ts src/tasks/plan-archive.service.spec.ts` → 断言触发次数与幂等，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-8-trigger.txt`
  - QA failure: 断言 ① 扫描抛错时 `mark-pending-review` 仍返回成功、任务进入 `pending_review`；② `grep -n "scanAndArchivePlanDocs" server/src/tasks/plan-docs.service.ts server/src/docs-site` → 0 命中（读路径未接线）
  - Commit: `feat(plan): pending_review/accept 触发计划自动归档，读路径零写副作用`
- [x] 9. 自动归档：不产生 `type:"plan"` 的不变量断言
  - References: `server/src/platform-mcp/plan-removal.guard.spec.ts:165-175`（断言 `ARTIFACT_TYPES = ['text','doc','file']`）、`:177-185`（`grepSource(/type:\s*["']plan["']/)` 必须为空 + `PLAN_PRODUCE_INSTRUCTION|PLAN_REVIEW_INSTRUCTION` 必须缺席）；`artifacts.constants.ts:6`；Scope OUT #4（`type` 三态不动）与 #18（执行步骤产出机制不动）。
  - Acceptance: 自动归档链路全量源码中不存在 `type: "plan"` / `type:'plan'`；`ARTIFACT_TYPES` 正则仍匹配三态；不新增任何 `PLAN_*_INSTRUCTION` 常量。
  - QA happy: `cd server && npx jest --runInBand src/platform-mcp/plan-removal.guard.spec.ts` → 全绿，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-9-plan-guard.txt`
  - QA failure: 故意在新服务里写 `type: 'plan'` → 该 guard 变红（证明断言有效），验证后还原，证据同上
  - Commit: `test(plan): 锁定不产生 type:"plan"，防 plan-removal guard 回归`
- [x] 10. 「计划文档」卡改造成唯一内容聚合区（三目录文件 + `category=计划` 产出物）
  - References: `web/src/components/teams/TeamRightPanel.tsx:1094-1142`（现行「计划文档」块）、`:1014-1017`（`planFiles`/`planDocsDegraded`）、`:1121-1138`（行渲染 + `planDocUpdatedLabel`）、`:1256 PlanDocModal`；**新增数据源** `GET /tasks/:id/artifacts?category=计划`（过滤管道已现成：`artifact.dto.ts:76` + `artifacts.service.ts:495-516`）；原型口径 `.omo/drafts/session-right-panel-proto/index.tsx:418-433`（计划文档卡）与 `:459-521`（产出物来源徽章样式）；D8 要求保持 3 卡结构，**本卡即唯一展示地区**。
  - Acceptance: 单卡内统一列表 = 计划文件（来源徽标「本地文件」）+ `category=计划` 产出物（徽标「产出物 · v{n}」）；两类均可点开正文（文件走 `PlanDocModal`，产出物走既有 `onOpenArtifactDoc`）；按更新时间倒序；空态区分三档：`加载中` / `暂不可用（主 Agent 会话未建立或 worker 离线）` / `暂无计划内容`；**计划状态卡与执行步骤卡位置、结构不动**（D8）。
  - QA happy: `cd web && npx playwright test --project=pages` → 断言 `plan-doc-row-*` 与新 `plan-artifact-row-*` 同卡可见且各带来源徽章，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-10-plan-merge.json`（`playwright.config.ts:27` 报告路径）
  - QA failure: 断言 ① `GET /tasks/:id/artifacts` 返回 500 → 卡片显示**错误态**而非「暂无」；② `GET /plan-docs` 返回 `degraded:true` → 显示「暂不可用」而非「暂无」
  - Commit: `feat(right-panel): 计划文档卡合并三目录文件与计划类产出物`
- [x] 11. 6 处「错误伪装成空」补齐 isError 分支
  - References: `TeamRightPanel.tsx:219`（渠道 `all.length===0 → 暂无可用渠道`，无 isError）、`:693`（执行清单）、`:1115`（计划文档）、`:1152`（执行步骤）、`:1189`（产出物）、`:1223`（待办 Issue）；**对照唯一正确实现** `:920-923`（触发器 `isError` 分支 + `data-testid="trigger-list-error"`）；根因是 `data ?? []` 让失败与真空同文案。
  - Acceptance: 6 处全部增加 `isError` 分支，错误文案与「暂无…」可区分，并各自带 `data-testid="…-error"`；`isPending` → 加载中；`degraded` → 暂不可用（计划两处已有，保留）；**不再有任一处把请求失败渲染成「暂无…」**。
  - QA happy: `cd web && npx playwright test --project=pages` → mock 对应接口 500，断言 6 处均出现 `*-error` testid 且**不出现**「暂无…」，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-11-error-states.json`
  - QA failure: 接口 200 且真空时仍显示「暂无…」（证明错误态与空态未混用）
  - Commit: `fix(right-panel): 6 处列表接口失败显示错误态，不再伪装成空`
- [x] 12. plan 查询 `isMember` 门修复（未登录不再卡「加载中」）
  - References: `TeamRightPanel.tsx:493-498`（`planQuery` `enabled: !!taskId && isMember`）、`:483-485`（`isMember = !!viewer?.id`，`viewer = useAuthStore((s:any)=>s.user)`）、`:580-581`（pending 显示「加载中…」）、`:612-613`（isError 显示「计划状态暂不可用」）；会话页注入 `web/app/(main)/teams/[id]/session/page.tsx:214-219 planDocsQuery`（`enabled: !!currentTaskId && !!user?.id`，同款问题可一并核对）。
  - Acceptance: 查询不再因缺 `user.id` 而永久 disabled——改为仅依赖 `!!taskId`，权限不足由服务端 403/401 返回并走 `isError` 分支；未登录场景显示「计划状态暂不可用」或登录提示，**不得停留在「加载中…」**。
  - QA happy: `cd web && npx playwright test --project=pages` → 无登录态打开计划 Tab，断言不出现永久 loading，出现明确错误/提示态，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-12-member-gate.json`
  - QA failure: 未登录时 `GET /tasks/:id/plan` 返回 401 → 渲染 `planQuery.isError` 文案，且 10s 轮询不产生错误风暴（保留 `refetchInterval` 但错误态下不再无脑轮询）
  - Commit: `fix(right-panel): 计划状态查询门改为仅依赖 taskId，消除永久 loading`
- [x] 13. plan-steps 会话定位补 taskId 维度（修 P1 串数据）
  - References: `server/src/tasks/plan-steps.service.ts:36-82 listPlanSteps`；**缺陷锚点 `:52-59`**（`session.findFirst({ where: { teamId, teamMemberId }, orderBy: { updatedAt: 'desc' } })` 无 taskId）；`:60-62` 缺 workerId/instanceRef → degraded；`:69-71` worker offline → degraded；`:74-78 listTodos`；既有 spec `server/src/tasks/plan-steps.service.spec.ts`；对照正确读法 `plan-docs.service.ts:85-103`（按 `taskId` 拼 directory，天然任务隔离）。
  - Acceptance: 定位会话时按当前任务约束（优先 `session.taskId === taskId`；若模型无该列，则退化为「仅当最新会话确属本任务上下文时才取，否则返回 `degraded:true` 而非取到别的任务会话」）；**绝不把他人/他任务会话的 todo 当本任务步骤返回**；worker offline 仍 `degraded:true`。
  - QA happy: `cd server && npx jest --runInBand src/tasks/plan-steps.service.spec.ts` → 断言同 team 两个任务、会话分属不同 task 时各取各的，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-13-plan-steps.txt`
  - QA failure: 断言 ① 会话不匹配本任务 → 返回 `{steps:[], degraded:true}`（而非串数据冒充「无步骤」）；② worker offline → `degraded:true`
  - Commit: `fix(plan): plan-steps 会话定位补任务维度，修复跨任务串数据`
- [x] 14. 产出物/Issue 去掉 `slice(0,5)` 截断 + 断言 7 条全渲染
  - References: `TeamRightPanel.tsx:1193`（`(artifactsQuery.data?.items ?? []).slice(0, 5)`）、`:1227`（issues 同款）、`:1214`/`:1245`（既有「查看全部 →」入口保留）；实测基线 `GET /tasks/t_0000000001/artifacts?pageSize=20` → `total:7`（当前只显示 5 条）。
  - Acceptance: 列表不再硬截 5 条——渲染 `items` 全量（服务端 `pageSize=10` 需相应调大到 ≥20，见会话页 `page.tsx:201-206`）；「查看全部 →」入口保留；空态与错误态不变（依赖 todo 11）。
  - QA happy: `cd web && npx playwright test --project=pages` → 断言产出列表渲染 ≥7 行（`data-testid` 计数），证据 `.omo/evidence/session-right-panel-plan-overhaul/task-14-no-slice.json`
  - QA failure: `total > pageSize` 时显示「查看全部」而非静默截断
  - Commit: `fix(right-panel): 产出物/Issue 列表不再截断 5 条`
- [x] 15. 团队子页 5→2（概览合并设置+记忆、删成员卡、创建任务上提、删「操作」子页）
  - References: `TeamRightPanel.tsx:174`（`TeamSubTab = overview|settings|memory|channels|actions` → `overview|channels`）、`:282-292`（子 Tab 渲染数组）、`:295-336`（概览）、`:337-384`（设置两开关）、`:385-387`（记忆卡 `TeamMemoryCard`）、`:317-334`（**成员列表卡，整卡删除**）、`:406-411`（「操作」子页：创建任务 + 历史任务）、`:109-152`（`TeamMemoryCard` 组件定义）；原型口径 `.omo/drafts/session-right-panel-proto/index.tsx:179-249 TeamOverview`、`:236-247`（创建任务上提 + 「成员管理在左侧面板」提示）、`:189-192`（历史任务次级链接）。
  - Acceptance: 团队 Tab 只剩「概览」「渠道」两个子页；概览含 团队信息卡 + 主 Agent 卡 + 会话设置卡（托管模式、完成后重置会话两开关**并排**）+ 底部「＋ 创建任务」主按钮 + 「历史任务 →」次级链接；**成员列表卡整卡不存在**；「操作」子页与「设置」「记忆」独立子页全部移除；`TeamMemoryCard` 作为独立卡的用法改为并入设置卡（组件可保留复用，但不再单独成 Tab）。
  - QA happy: `cd web && npx playwright test --project=pages` → 断言团队子页 testid 只有 `team-overview`/`team-channels` 两类、`team-subtabs` 内按钮数为 2、`create-task-btn` 可见，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-15-team-2tabs.json`
  - QA failure: 断言页面中**不存在**「成员（N 人）」文本与「设置」「记忆」「操作」子页按钮（防残留）
  - Commit: `feat(right-panel): 团队子页 5→2，设置记忆合并、成员卡删除、创建任务上提`
- [x] 16. 任务子页 5→4（删「配置」，字段并入状态卡元信息）
  - References: `TeamRightPanel.tsx:752`（`TaskSubTab = status|plan|config|output|triggers` → 去 `config`）、`:1041-1052`（子 Tab 渲染）、`:1076-1089`（配置卡本体 + `configRows`）、`:1028-1036`（`configRows` 构造：标题/描述/优先级/状态/所属团队/创建人/创建时间）、`:1066-1071`（状态卡操作区）；原型口径 `proto/index.tsx:333-349`（状态卡底部 3 列元信息：优先级/创建人/创建时间）与 `:655-666`（任务子页 4 项）。
  - Acceptance: 任务 Tab 只剩「状态/计划/产出/触发」四项；「配置」子页与其 Tab 按钮移除；`configRows` 中有价值字段（优先级、创建人、创建时间）以 3 列元信息形式并入**状态卡底部**（对齐原型），标题/描述/团队已在状态卡与会话头部已有故不重复；`onEditTaskInfo` 入口保留在状态卡（原配置页的「编辑任务信息」按钮随之迁到状态卡，与既有编辑按钮合一）。
  - QA happy: `cd web && npx playwright test --project=pages` → 断言 `task-subtabs` 内按钮数为 4 且无「配置」、状态卡内出现优先级/创建人/创建时间三列，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-16-task-4tabs.json`
  - QA failure: 断言页面无 `task-config-fields` testid（配置卡未残留）、点击编辑仍打开 `TaskInfoEditModal`
  - Commit: `feat(right-panel): 任务子页 5→4，删配置页并把元信息并入状态卡`
- [x] 17. 默认主 Tab 落「任务」+ 切换保留子页状态
  - References: `TeamRightPanel.tsx:1293`（`useState<"team"|"task">("team")` → 有任务时初值 `"task"`）、`:1294 hasTask = !!task`、`:1303-1307`（任务 Tab 仅 `hasTask` 渲染）、`:1311-1322`（内容区）、`:261`（`TeamSubTabs` 内 `useState("overview")`）、`:1007`（`TaskSubTabs` 内 `useState("status")`）；原型 `proto/index.tsx:573`（`useState("team"|"task")("task")` 注释「改版：有任务默认落任务」）与 `:574-576`（独立 state 天然保留）。
  - Acceptance: 有任务时初始 `activeMainTab === "task"`；无任务时仍为 `"team"`；团队/任务两个子 Tab 的 `useState` 保持各自独立（切主 Tab 不重置子页选择）；`subTab` 组件不因主 Tab 切换被卸载重建（若为满足渲染条件被卸载，则需把 `subTab` 提升到 `TaskRightTabs` 层保存）。
  - QA happy: `cd web && npx playwright test --project=pages` → 断言进入会话页默认选中「任务」，切到「计划」→ 切「团队」→ 切回「任务」后仍在「计划」，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-17-default-tab.json`
  - QA failure: 无任务场景（`hasTask=false`）断言默认仍为「团队」且不渲染任务 Tab
  - Commit: `feat(right-panel): 有任务默认落任务 Tab 并保留子页状态`
- [x] 18. 状态卡：去队列摘要行 + 按钮改三层布局
  - References: `TeamRightPanel.tsx:1057-1072`（状态卡本体）、**`:1063-1065`（队列摘要行 `{isCurrent ? "当前执行（队首）" : ...} · {waiting > 0 ? ...}` 删除**）、`:1058-1062`（标题 + 状态徽同行）、`:1066-1071`（`TaskStatusActions` 与「编辑」横排 + `flex-wrap`）、`:1073 TeamQueueCard`（队列信息已有完整来源，摘要行纯重复）；三层布局口径 `proto/index.tsx:301-349` 与本会话已修的按钮分层（标题独占一行 → 状态徽 + 次级「编辑」`justify-between` 一行 → `grid-cols-2 gap-2.5` 主操作整行）。
  - Acceptance: ① 状态卡内**无**队列摘要行（队列信息只由 `TeamQueueCard` 承载）；② 三层布局：标题全宽 → `mt-2 flex justify-between`（状态徽 + 弱化「编辑」次级按钮）→ `mt-3 grid grid-cols-2 gap-2.5`（`TaskStatusActions` 主操作整行等宽）；③ 状态徽不再与标题同行挤压；④ `TaskStatusActions` 内按钮不再是三按钮并排。
  - QA happy: `cd web && npx playwright test --project=pages` → 断言状态卡三层结构 testid（标题 / `plan-status-pill` 行 / 主操作容器）且**不含**「当前执行（队首）」文本，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-18-status-card.json`
  - QA failure: 窄视口（min 240px）下断言主操作两按钮不换行挤压、状态徽不被挤成竖排
  - Commit: `feat(right-panel): 状态卡去队列摘要行并改三层按钮布局`
- [x] 19. 产出页去掉「任务详情」重复块
  - References: `TeamRightPanel.tsx:1177-1250`（产出 Tab）、**`:1179-1183`（「任务详情」标题 + `task.title` + `task.description` 整块删除**）、`:1184-1217`（产出物，保留）、`:1218-1248`（待办 Issue，保留）；原型 `proto/index.tsx:469`（注释「不再渲染「任务详情」标题+描述」）与 `:516-518`（「已删除原『配置』子页 · 标题/描述/状态不再重复渲染」）。
  - Acceptance: 产出 Tab 首块直接是「产出物」，不再出现「任务详情」标题与 `task.title`/`task.description` 重复渲染；产出物与待办 Issue 两块结构与数据源不变；「查看全部 →」保留。
  - QA happy: `cd web && npx playwright test --project=pages` → 断言产出 Tab 内无「任务详情」文本、首块 testid 为产出物列表，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-19-output-no-detail.json`
  - QA failure: 断言任务标题/描述仍可在状态卡（或其他唯一位置）读到——**信息未丢失、只去重复**
  - Commit: `feat(right-panel): 产出页删除与状态卡重复的任务详情`
- [x] 20. P0：`reuseMutation` no-op 修复（`reuseSession` → `!reuseSession`）
  - References: `TeamRightPanel.tsx:374`（`onClick={() => reuseMutation.mutate(reuseSession)}` 传当前值 = 无操作）、`:375`（`onKeyDown` 同错）、`:265-273`（`reuseMutation` 定义：`teamsApi.update(team.id, { reuseSession: next })` → `PATCH /api/v1/teams/:id`）、**对照正确实现 `:386`**（记忆卡 `onToggleReuse={(next: boolean) => reuseMutation.mutate(next)}`）；`TeamSubTabs` 中该按钮 aria-label=`完成后重置会话`、`aria-checked={!reuseSession}`（`:370`）。
  - Acceptance: 点击「完成后重置会话」时发出的 `PATCH /api/v1/teams/:id` body 为 `{ reuseSession: !当前reuseSession }`；`onKeyDown`（Enter/Space）路径同样传反值；成功后 `["team",id]`/`["teams"]` 失效重取（既有 `onSuccess` 已有）；`pending` 时按钮 disabled 不变。
  - QA happy: `cd web && npx playwright test --project=pages` → 拦截 `PATCH /api/v1/teams/*`，断言点击后 body `reuseSession` 与点击前相反，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-20-reuse-toggle.json`
  - QA failure: `reuseMutation.isPending` 期间再次点击不重复发请求；接口 400/500 时 `settingError` 显示且开关回滚视觉态
  - Commit: `fix(right-panel): 完成后重置会话开关传反值，修复 no-op`
- [x] 21. P2：队列空态文案 + 触发器 `retry:false` 刷屏
  - References: 队列：`TeamRightPanel.tsx:76-101`（`team.queue.length > 0 ? (...) : null` —— 空时无任何提示，仅头部计数）；触发器：`:811-821`（`useTaskTriggers` `retry:false` + `refetchInterval:30_000`）、`:918-925`（pending/isError/空 三分支，isError 已正确）、`:1025-1026`（`TaskSubTabs` 顶层也调一次共享缓存）。注：**成员列表空态 todo 已作废**（成员卡在 todo 15 整卡删除，无空态需求 —— Metis #2）。
  - Acceptance: ① 队列为空时显示明确空态（如「暂无排队任务」+ 「群聊按团队复用」提示），不再是纯 `null`；② 触发器错误态**不再每 30s 重刷错误条**——错误后停止轮询或退避（保留手动重试/依赖 invalidate），`retry:false` 语义改为「错误不自动重试」而非「错误态仍每 30s 打一次」。
  - QA happy: `cd web && npx playwright test --project=pages` → 断言空队列出现空态文案；接口 500 时 40s 内 `/triggers` 请求数 ≤1，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-21-empty-retry.json`
  - QA failure: 队列恢复有数据时空态消失；触发器接口恢复后能重新拉到数据（不永久停摆）
  - Commit: `fix(right-panel): 队列空态文案 + 触发器错误不再轮询刷屏`
- [x] 22. P2：`resetAfterComplete` 暴露到 `toTaskDto` + 记忆卡可反映
  - References: `server/src/tasks/tasks.service.ts:1817 private async toTaskDto(task: TaskRow)`（当前返回字段表**不含** `resetAfterComplete`）；该字段现仅出现于 `:81`（DTO interface）、`:400`（create 写入）、`:706-707`（update 写入）、`:1709`（注释「Todo7 记忆开关：accept/archive 同事务内批量 reset」）、`:1722`（`const taskReset = Boolean((task as any).resetAfterComplete)`）；前端消费 `TeamRightPanel.tsx:359-381`（设置卡「完成后重置会话」当前**只读 `team.reuseSession`**，看不到任务级覆盖）与 `:109-152 TeamMemoryCard`；类型 `web/src/components/tasks/task-detail-types.ts TaskDetail`。
  - Acceptance: `toTaskDto` 返回 `resetAfterComplete: boolean`；`TaskDetail` 类型同步；设置卡/记忆卡在任务级开关存在时显示其覆盖状态（如「任务级：完成后重置」覆盖团队级），并明确文案区分**团队级 `reuseSession`** 与**任务级 `resetAfterComplete`**（两者语义相反：`reuseSession=true` 复用 / `resetAfterComplete=true` 强制重置）。
  - QA happy: `cd server && npx jest --runInBand src/tasks/tasks.service.spec.ts` → 断言 `findOne` 返回体含 `resetAfterComplete` 且与创建入参一致，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-22-dto.txt`
  - QA failure: 未显式设置该字段的任务返回 `false`（缺省语义，见 `:400` `?? false`），不返回 `undefined`；前端未设置时不显示「任务级覆盖」文案（不误报）
  - Commit: `feat(task): toTaskDto 暴露 resetAfterComplete 并在记忆区区分团队级/任务级`
- [x] 23. P2 残留核查：成员卡删除后无悬空引用
  - References: `TeamRightPanel.tsx:317-334`（成员列表卡，todo 15 已删）；Metis #2 指出的矛盾点（Scope IN C1 删卡 vs Scope IN C5 修其空态）——本 todo 承接作废后的验证；关联 `:302-316`（主 Agent 卡**保留**，勿误删）、`AgentAvatar`/`roles` import 是否仍被使用。
  - Acceptance: `TeamRightPanel.tsx` 中不存在「成员（」渲染与成员列表 map；主 Agent 卡完整保留；`AgentAvatar`、`roles`、`toRoleKey` 等 import 无未使用告警（lint 干净）；C5 范围正式修正为「队列空态 + 触发器 retry + resetAfterComplete」三项，成员空态从 Scope IN 移除。
  - QA happy: `grep -n "成员（" web/src/components/teams/TeamRightPanel.tsx` → 0 命中，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-23-member-card-gone.txt`；`cd web && npm run lint` → exit 0
  - QA failure: `grep -n "主 Agent" web/src/components/teams/TeamRightPanel.tsx` → 仍有命中（证明只删成员列表、未误删主 Agent 卡）
  - Commit: `chore(right-panel): 清理成员卡删除后的悬空引用，C5 范围修正`
- [x] 24. `pages.spec.ts` 补新 testid 断言（计划区 + 结构类全覆盖）
  - References: `web/e2e/pages.spec.ts:88-108`（既有 right-tab 断言，**已接线 project `pages`，新增断言必须写进这里**）；当前**零断言**的 testid（本计划新增/依赖的）：`plan-doc-row-*`（`TeamRightPanel.tsx:1125`）、`plan-step-*`（`:1161`）、`task-subtab-triggers`（`:1048`）、`team-queue-card`（`:52`）、`trigger-empty`（`:925`），加本计划新造的 `plan-artifact-row-*`、各 `*-error`、状态卡三层 testid；孤儿 spec 说明见 `web/playwright.config.ts:36-64`（16 个 spec 不被任何 project 匹配，**不接回**，Scope OUT #10）；报告路径 `playwright.config.ts:27` → `.omo/evidence/phase5-t9-playwright.json`。
  - Acceptance: `pages.spec.ts` 内新增断言覆盖：计划区两类来源行、执行步骤行、状态卡三层结构、团队 2 子页、任务 4 子页、默认落任务、队列空态、6 处 `*-error` 至少 2 处、产出 ≥7 行；全部通过 `--project=pages` 运行；**不新增任何孤儿 spec 文件、不改 `playwright.config.ts` projects**。
  - QA happy: `cd web && npx playwright test --project=pages` → 全绿，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-24-pages-e2e.json`
  - QA failure: `npx playwright test plan-status --list` → 仍为 `No tests found`（证明没把孤儿 spec 接回，符合 Scope OUT #10）
  - Commit: `test(right-panel): pages.spec 补齐改版与计划区断言`
- [x] 25. `docs/12-产出物协议与文档库.md` 同步「计划」类 + 多目录 + 自动归档
  - References: `docs/agent-platform/12-产出物协议与文档库.md:337`（现文档已写明「`POST /tasks/:id/artifacts` 与 `submit_artifact` 均接受可选 `category`（`@IsOptional @IsIn` / zod optional enum），非法值 → `400 ARTIFACT_INVALID_DECLARATION`…append 命中已存在行只递增版本，**不覆盖原 `category`**；`archiveFile` 仅新建行写入」）；`artifacts.constants.ts:11-24` 注释（「唯一源」「web 侧镜像同字面量七类」→ 改八类）；`artifacts.service.ts:108-117` 类注释（「§4.3 sha256 幂等去重」）；自动归档新链路（todo 7/8）；worker 多目录（todo 4）。
  - Acceptance: 文档新增/修订三处：① 词表由七类改八类并列出「计划」；② 计划文件扫描目录为 `.omo/plans` / `.opencode/plans` / `.omo/drafts` 三处且写入落点仍 `.omo/plans`；③ 任务进入 `pending_review`/`accept` 时系统自动归档计划文件为 `type=file, category=计划`，失败降级 warn、`category` 仍可选、**不改 agent 提示词**。`artifacts.constants.ts` 注释「七类」同步为「八类」。
  - QA happy: `grep -n "计划" docs/agent-platform/12-产出物协议与文档库.md` → 新增段落命中 ≥3 处，且 grep "八类" → 命中，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-25-docs.txt`
  - QA failure: 文档中不得出现「category 必填」或「要求 agent 必须传 category」表述（与 D3/D7 冲突即失败）
  - Commit: `docs(artifact): 协议文档同步八类词表、三目录扫描与自动归档`
- [x] 26. 原型补到最终设计并重新部署（`docker cp` + 产出物 append）
  - References: 原型源 `.omo/drafts/session-right-panel-proto/index.tsx`（规范：`export const meta = {id,name,device}`，正则 `/export\s+const\s+meta\s*=\s*(\{[^}]+\})/s`、meta 内**不可嵌套花括号**；`export default function`；hooks 必须 `import … from "react"`；沙箱内 `@proto/shared` 被 stub → 须自包含 react+tailwind —— 见 `web/src/features/docs-site/prototype-sandbox.tsx` SHARED_NS）；产出物 `art_0000000007` `fileRef=/uploads/session-right-panel-v2.tsx`；**`.tsx` 不在上传白名单**（`server/src/uploads/uploads.constants.ts`）→ 必须 `docker cp` 到 `aiagents-compose-server:/app/uploads/session-right-panel-v2.tsx` 再 `POST /api/v1/tasks/t_0000000001/artifacts {type:'file', fileRef:'/uploads/session-right-panel-v2.tsx', category:'设计'}`（注意 body 不带 `content` 会撞空串 sha256 返回 `duplicate` 版本不涨，但原型读 `contentRef` 路径文件，**改文件即可生效**）；登录为 JWT：`POST /api/v1/auth/login` → `accessToken` → `Authorization: Bearer`；`readUploadedFile` 实时读盘（`server/src/docs-site/prototypes.service.ts:147-151,231-235`）。
  - Acceptance: 原型内容 = 本计划的最终设计（团队 2 子页 / 任务 4 子页 / 计划 Tab 3 卡且「计划文档」为聚合区带来源徽标 / 状态卡三层布局 / 产出无任务详情）；`docker cp` 成功覆盖容器内文件；源码端点返回 200 且源码含新结构标记（`grid-cols-2`、`plan-artifact` 类标记等）。
  - QA happy: `curl -sS -H "Authorization: Bearer $TOKEN" "http://localhost:13000/api/v1/docs-site/t_0000000001/prototypes/session-right-panel-v2/index.tsx" | grep -c "grid-cols-2"` → ≥1，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-26-prototype-src.txt`
  - QA failure: `curl -sS -o /dev/null -w "%{http_code}" http://localhost:13001/docs/t_0000000001` → `200`；meta 正则解析未回归（`GET /docs-site/t_0000000001/prototypes` 仍返回 `name: 会话右侧面板改版`）
  - Commit: `chore(proto): 原型同步最终设计并重新部署（docker cp + 产出物 append）`
- [x] 27. `docs-unified.spec.ts` 实跑确认 + 明确「不加计划 fixture」约束
  - References: `web/e2e/docs-unified.spec.ts`（**已接线 project `docs`**，是本计划 Verification strategy 的门之一）；`:15` 注释「分类覆盖七类 + NULL（未分类 chip 用）」；`:147-188` fixture 恰为 7 类 + `:203` + NULL 行（`category: 测试报告/需求/设计/测试用例/运维/实现/其他`）；**断言 `:247,:253,:271` `expect(ownRows(page)).toHaveCount(10)`**；chips 定位为**按名**（`:255 getByRole("button",{name:"测试报告",exact:true})`、`:264 name:"未分类"`、`:269 [data-key="all"]`）**非按数量**；Metis #1 建议改成 8 类契约 —— **不采纳**（加 fixture 行会把 10 变 11，三条 count 断言全崩，属超范围）。
  - Acceptance: **不新增任何 `category=计划` 的 fixture 行、不改 `toHaveCount(10)`**（Scope OUT 追加约束）；实跑 `--project=docs` 确认第 8 类 chip（若 chips 由 `ARTIFACT_CATEGORIES` 渲染则会多出一枚空 chip）不影响既有按名断言与行数断言；`:15` 注释按实际更新为「分类覆盖七类 + 计划 + NULL」或注明「计划类由自动归档产生、fixture 不预置」。
  - QA happy: `cd web && npx playwright test --project=docs` → 全绿，证据 `.omo/evidence/session-right-panel-plan-overhaul/task-27-docs-e2e.json`
  - QA failure: `grep -n "toHaveCount(10)" web/e2e/docs-unified.spec.ts` → 仍为 10（未被改成 11）；`git diff web/e2e/docs-unified.spec.ts` 中**无**新增 `category: "计划"` fixture 行
  - Commit: `test(docs): 实跑 docs e2e 确认八类词表不破坏既有 chips/行数契约`
- [x] 28. 三包全量门禁收口（tsc / lint / jest / typecheck / playwright）
  - References: server：`cd server && npx tsc --noEmit -p tsconfig.json`（无 typecheck script，先例 `.omo/evidence/docs-artifacts-merge/task-4-category-write.md:16`）、`npm run lint --prefix server`（`server/package.json:15`）、`npx jest --runInBand src/artifacts src/tasks/plan-docs.service.spec.ts src/tasks/plan-steps.service.spec.ts src/tasks/tasks.service.spec.ts src/platform-mcp/plan-removal.guard.spec.ts`（`server/package.json:16` 串行）；worker：`npm run typecheck`（`worker/package.json:14`）、`npm run test`（`:15` 串行）；web：`cd web && npx tsc --noEmit -p tsconfig.json`、`npm run lint --prefix web`（`web/package.json:9`）、`npx playwright test --project=pages --project=docs`（前置 `next dev` :3001 + server :13000 + 系统 Chrome，`playwright.config.ts:6` 不自启）；词表双命令见 todo 3。
  - Acceptance: 上述 8 条命令全部 exit 0；任一失败即本 todo 不完成（不得带病推进 Final wave）。
  - QA happy: 逐条命令执行并把 stdout 分别存 `.omo/evidence/session-right-panel-plan-overhaul/task-28-{server-tsc,server-lint,server-jest,worker-typecheck,worker-test,web-tsc,web-lint,web-e2e}.txt|json`
  - QA failure: 任一命令非 0 → 记录失败输出，修复后重跑；**不接受「跳过该门」**
  - Commit: `chore(quality): 三包类型/静态/单测/e2e 全量门禁收口`


## Final verification wave

- [x] F1. 计划合规审计（Scope IN 8 项已实现 / Scope OUT 12 项零违反）
  - References: 本文件 `## Scope` 全部条目；特别核对 Scope OUT：①`git diff` 中**零** `server/prisma/seed.ts` 与角色/技能提示词变更 ②`ARTIFACT_TYPES` 仍三态 ③`category` 在 `platform-mcp.tools.ts:228` 仍 `.optional()` ④零历史分类回填 ⑤`PLAN_DOCS_DIR` 未变 ⑥读路径无 `scanAndArchivePlanDocs` 引用 ⑦零 `type: "plan"` ⑧无新 DB 表/迁移 ⑨无 `playwright.config.ts` projects 变更 ⑩无主题/视觉重设计 ⑪未动 realtime/RBAC/throttle ⑫执行步骤仍是 opencode todo 只读透传。
  - Acceptance: 逐条给出 PASS/FAIL + 证据行；任一 FAIL 即本 wave 不通过。
  - QA happy: `git diff --stat` + 针对上述 12 条各跑一条 `grep`/`git diff -- <path>`，汇总存 `.omo/evidence/session-right-panel-plan-overhaul/F1-compliance.txt`
  - QA failure: 故意构造一条 Scope OUT 违反（如临时改 seed.ts）→ 审计必须抓到 FAIL（证明审计有效），验证后还原
  - Commit: `chore(verify): F1 计划合规审计证据`
- [x] F2. 代码质量复审（三包静态 + 单测全绿）
  - References: `task-28` 的 8 条命令全集；`server/package.json:15-16`、`worker/package.json:14-15`、`web/package.json:9-10`；`server/jest.config.js`、`worker/jest.config.js`、`web/playwright.config.ts`。
  - Acceptance: 8 条命令全 exit 0 且证据文件齐全；无新增 lint error / 无 TS error / 无 flaky 重跑才过的情况（同一条命令连跑 2 次结果一致）。
  - QA happy: 复跑 `task-28` 全集并 diff 两次 stdout 关键行一致，存 `.omo/evidence/session-right-panel-plan-overhaul/F2-quality.txt`
  - QA failure: 任一命令第一次失败→修复→必须记录失败与修复两份证据（不接受只留最终绿）
  - Commit: `chore(verify): F2 代码质量复审证据`
- [x] F3. 真实端到端 QA（起服务实跑改版 + 计划自动归档全链路）
  - References: 环境 `server localhost:13000` / `web localhost:13001` / 登录 `admin/admin123`（JWT：`POST /api/v1/auth/login` → `accessToken` → `Authorization: Bearer`）/ 任务 `t_0000000001`；实测基线（本计划发现段）：`GET /tasks/t_0000000001/plan`→`draft`、`/plan-steps`→`steps:[] degraded:false`、`/plan-docs`→`files:[] degraded:false`、`/artifacts`→`total:7`（含「实施计划 v1.0」「实现方案」，分类为`设计`/`None`）；端点清单 `server/src/tasks/tasks.controller.ts:165-235`（`GET :id` / `GET :id/plan-steps` / `GET :id/plan-docs` / `POST :id/plan-docs`）、`:300-329`（`mark-pending-review` / `accept`）；原型 `GET /docs-site/t_0000000001/prototypes/session-right-panel-v2/index.tsx`。
  - Acceptance: 全链路四步实跑通过——① 页面：右栏团队 2 子页 / 任务 4 子页 / 默认落任务 / 状态卡三层 / 计划 Tab 3 卡且内容区有来源徽标；② 数据：`POST /tasks/t_0000000001/mark-pending-review`（或用已 pending_review 任务）后 `GET /artifacts?category=计划` 能返回自动归档产出物（或三目录无 md 时明确空且不报错）；③ 错误态：mock 接口 500 页面显示 `*-error` 而非「暂无」；④ 回归：`GET /plan-steps`、`GET /plan-docs`、`GET /plan` 三端点仍 200 且语义未变。
  - QA happy: 四步各自 curl/playwright 输出存 `.omo/evidence/session-right-panel-plan-overhaul/F3-e2e-{page,archive,error,regression}.txt|json` + 页面截图
  - QA failure: 自动归档链路失败时（临时指向不存在目录）任务 `mark-pending-review` 仍 200、`GET /artifacts` 不 500——证明降级不阻断主流程
  - Commit: `chore(verify): F3 端到端 QA 证据`
- [x] F4. 范围保真复核（diff 级零越界）
  - References: Scope OUT 全 12 条 + 本计划追加的两条 Metis 修正约束（**不给 `docs-unified.spec.ts` 加「计划」fixture**、**自动归档禁产 `type:"plan"`**）；`server/src/platform-mcp/plan-removal.guard.spec.ts:165-185`；`web/e2e/docs-unified.spec.ts:15,247,253,271`；`server/src/chat/worker-dispatcher.ts:415-417`（`ARTIFACT_SUBMISSION_INSTRUCTION` **未被修改**——它只讲 `type` 三态与「查工具 schema」，不列举 category，故不构成第 6 位点，也不得改动）。
  - Acceptance: ① `git diff` 无 `server/prisma/seed.ts`、无任何 `*prompt*` 文件、无 `worker-dispatcher.ts:415-417` 常量文本变更；② `grep -rn "type:[[:space:]]*[\"']plan[\"']" server/src` → 0；③ `PLAN_DOCS_DIR` 定义行 diff 为空；④ `docs-unified.spec.ts` 无 `category: "计划"` 新增且 `toHaveCount(10)` 未变；⑤ `plan-removal.guard.spec.ts` 全绿；⑥ `git diff` 无 `.github/`、无新 migration 文件（除明确需要的之外）。
  - QA happy: 上述 6 条 grep/diff 逐条执行，输出存 `.omo/evidence/session-right-panel-plan-overhaul/F4-scope-fidelity.txt`
  - QA failure: 任一条非预期命中 → 判 FAIL 并定位到具体文件行，修复后复跑
  - Commit: `chore(verify): F4 范围保真复核证据`

## Commit strategy

- **按波提交**：每个 Wave 一个 commit（词表 / worker / 自动归档 / 计划Tab / 右栏结构 / 缺陷 / 门禁文档），避免跨层大提交。
- **提交信息前缀**：`feat(right-panel):` / `feat(plan):` / `feat(artifact):` / `fix(right-panel):` / `test(...)` / `docs(...)`。
- **三包分目录提交边界**：`server/`、`worker/`、`web/` 各自改动独立成段；词表 5 位点（server 4 + web 1）必须**同一 commit**（拆开会造成 parity 门中间态失败）。
- **不提交**：`.omo/` 下本计划外的临时文件、`server/coverage/`、playwright 运行产物（证据目录 `.omo/evidence/` 按既有惯例单独提交）。
- 回滚单位 = 波次 commit；C3b 出问题可单独 revert 而不影响词表与结构。

## Success criteria

1. **结构**：右栏团队 Tab 只有 2 个子页、任务 Tab 只有 4 个子页（无「配置」），有任务默认落「任务」，切换主 Tab 子页状态保留，状态卡为三层布局且无队列摘要行，产出页无「任务详情」。
2. **计划内容有货**：`category=计划` 的产出物与三目录计划文件在同一「计划文档」区以来源徽章展示；任务进入 `pending_review` 后三目录 `*.md` 自动归档为 `type=file, category=计划` 产出行。
3. **不控制 agent**：`grep` 全仓提示词（`server/prisma/seed.ts`、角色 prompt、技能描述）与改动前一致（`git diff` 无提示词类变更）；`category` 在 MCP schema 中仍为 optional。
4. **词表一致**：5 位点全部含「计划」，两条 parity/grep 命令 exit 0。
5. **错误可辨**：6 处列表在接口失败时显示错误态，与「真空」文案可区分；未登录不再卡「加载中」。
6. **门禁全绿**：`server` jest --runInBand 目标套件、`worker npm run test`、`worker npm run typecheck`、`web/server npx tsc --noEmit`、双端 lint、`npx playwright test --project=pages --project=docs` 全部通过。
7. **零越界**：`git diff` 中不存在 Scope OUT 第 1–12 条任何一项（尤其：无提示词变更、无 `PLAN_DOCS_DIR` 变更、无读路径写库、无 category 必填、无孤儿 spec 接线）。
8. **原型同步**：改码完成后重新部署原型，`docker cp` 覆盖 `aiagents-compose-server:/app/uploads/session-right-panel-v2.tsx` 后，`curl -sS -H "Authorization: Bearer $TOKEN" "http://localhost:13000/api/v1/docs-site/t_0000000001/prototypes/session-right-panel-v2/index.tsx" | grep -c "grid-cols-2"` 输出 ≥1（且 `curl -sS -o /dev/null -w "%{http_code}" http://localhost:13001/docs/t_0000000001` → `200`），证明文档站原型 Tab 呈现最终设计。
