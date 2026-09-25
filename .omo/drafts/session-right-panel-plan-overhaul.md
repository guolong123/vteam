---
slug: session-right-panel-plan-overhaul
status: plan-created
intent: clear
review_required: false
pending-action: append todos then fill TL;DR in .omo/plans/session-right-panel-plan-overhaul.md
approval: GRANTED by user ("批准") 2026-09-22 — authorization covers writing the plan file ONLY; execution starts in a separate worker session via $start-work.
approach: 右栏结构对齐原型（团队 5→2、任务 5→4、默认落任务、去 3 处重复、状态卡按钮分层）+ 计划 Tab 保持原型 3 卡（计划状态 / 计划文档 / 执行步骤），「计划文档」卡为唯一内容聚合区（worker 三目录感知 + category=计划 产出物）+ **计划目录自动归档**（不传 category 也由系统扫描补齐）+ 词表双源加「计划」并同步 3 处硬编码枚举串 + **角色提示词一律不改** + P0–P2 缺陷全修；测试策略 tests-after
scaffold_note: 本会话无 shell 工具，scaffold-plan.mjs 不可执行；草稿与最终计划均须手写，头部字段与模板顺序严格对齐（首标题必须是 `## TL;DR (For humans)`）。所有命令型验收标注由**执行 worker**运行。
---

# Draft: session-right-panel-plan-overhaul

## Components (topology ledger)

| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| C1-structure | 右栏结构对齐原型：团队 5→2、任务 5→4（删配置）、默认落任务、去 3 处重复、状态卡按钮分层 | ready | TeamRightPanel.tsx:174,282-292,752,1041-1052,1293,1058-1071,1063-1065,1179-1183,317-334,406-411; 原型 .omo/drafts/session-right-panel-proto/index.tsx:572-685,395-457 |
| C2-plan-tab | 计划 Tab 保持原型 3 卡；「计划文档」卡=唯一内容区（三目录感知文件 + category=计划 产出物，来源徽章）+ isError/门禁/定位修复 | ready | TeamRightPanel.tsx:1090-1176,493-498; plan-steps.service.ts:52-59; plan-docs.service.ts:85-103; worker exec-server.ts:143 |
| C3-category-vocab | 词表双源加「计划」+ **3 处硬编码枚举串同步** + parity 复验；**category 保持可选** | ready | artifacts.constants.ts:16-24; web/src/lib/artifact-categories.ts:7-14; platform-mcp.tools.ts:226-231; platform-mcp.service.ts:2713; artifacts.service.ts:101; evidence task-4-category-write.md:18 |
| C3b-auto-archive | **计划目录自动归档**：扫描任务目录三处计划路径 → `archiveFile` 带 `category=计划`，补 agent 未传 category 的缺口 | ready | artifacts.service.ts:395-496 archiveFile（sha256 去重）; platform-mcp.service.ts:6361-6414 fetchAndArchiveAttachment（自动归档先例） |
| C3c-no-prompt-control | **角色/技能提示词一律不改**：不加 category 引导、不改 seed.ts、不加回填迁移 | ready | 用户 D7 红线；seed.ts:507-509,566,568,583,1386,1855（现状只读参考，不改） |
| C4-p0p1-fixes | P0×2 + P1×4 | ready | TeamRightPanel.tsx:374-375,219,693,1115,1152,1189,1223,496,1193,1227; plan-steps.service.ts:52-59 |
| C5-p2-fixes | P2×3 | ready | TeamRightPanel.tsx:76-101,317-333,819; tasks.service.ts:1817 toTaskDto vs :81,:400,:706,:1722 |
| C6-quality-gate | tests-after：双端 tsc + 双端 lint + server jest --runInBand + parity 一行 + playwright 限已接线 project | ready | 见 Findings「F 测试基建」 |

## Decisions (owner-answered)

| id | 决策 | 出处 |
| --- | --- | --- |
| D1 | **计划 Tab 混合方案**：category=「计划」聚合 **+ worker 感知**（`.opencode/plans` / `.omo/plans` / **`.omo/drafts`** 有文件即读出）；**只做一个展示地区** | 用户原话 2026-09-22 |
| D2 | **不回填**历史产出物分类（只对新增生效，不动已验收基线，无迁移脚本） | 用户 Q2 |
| D3 | **category 保持可选**（不改 MCP 公开契约、不破坏前向兼容） | 用户 Q3 |
| D4 | 右栏按原型落地，但**保留**计划 Tab 评审闭环全部控件（轮次账本/归档回执/冻结哈希/定稿与确认按钮/执行清单/文档上传） | 原型简化过头 |
| D5 | 全范围 C1–C6，不做 MVP/分阶段裁剪 | 用户「所有已知问题」 |
| D6 | 改码前先把原型补到最终设计并重新部署 | 原型工作流已验证 |
| D7 | **不过度控制 agent 行为**（第二轮红线）：agent 按**自身习惯**写本地计划目录；`submit_artifact` 归档时 category **可选**；**不传也由系统扫描自动上传（归档）**；**撤销原「提示词强引导」**——角色/技能提示词一律不改、不写 seed.ts、不加回填迁移 | 用户第二轮原话 2026-09-22 |
| D8 | 计划 Tab 卡片结构**以当前原型为准**（3 张卡） | 用户 Q5 |
| D9 | 测试策略 **tests-after** | 用户 Q4 |

**D8 的口径消歧**（用户同时说过「只做一个展示地区」与「以当前原型为准」，原型 `TaskPlan` 实为 3 卡）——取后到且更具体的「以当前原型为准」：
- 计划 Tab = **3 张卡照原型**：计划状态 / 计划文档 / 执行步骤；
- **「计划文档」卡即那个唯一的展示地区**——聚合 (a) worker 三目录感知出的计划文件 + (b) `category=计划` 产出物（含 C3b 自动归档产生的），统一带来源徽章、可点开正文；
- 计划状态卡原样承载全部评审闭环控件；执行步骤卡保留。

## Announced defaults (veto at gate)

| assumption | adopted default | rationale |
| --- | --- | --- |
| **自动归档范围** | **三处全归档**（Q7）：`.opencode/plans` + `.omo/plans` + `.omo/drafts` —— 与展示范围一致，不做「草稿仅展示」特例 | 用户 Q7 选定；做特例会让展示/归档两侧范围不一致，UI 还得区分「已归档/仅本地」 |
| **自动归档触发时机** | **任务进入 `pending_review`（mark-pending-review）时扫描一次**，`accept` 幂等兜底再扫一次；**不在 GET plan-docs 读路径上写库** | 读路径写副作用差；集中一次快照避免 agent 反复改稿刷版本；配合 `archiveFile` 既有 sha256 去重（`artifacts.service.ts:411-420`）同内容不重复、变了才 append |
| 自动归档的落库形态 | 复用 `archiveFile(taskId, {fileRef, storedUrl, storedName, sha256, title, category:'计划'})` | 已有自动归档先例：`fetchAndArchiveAttachment`（`platform-mcp.service.ts:6361-6414`，group_post fileRef 拉取→落盘→归档），行为一致、不新造链路 |
| 主题 | 沿用 `web/src/theme/tokens.ts` 浅色 | 我从未提出改主题；原型暗色是文档站预览环境产物 |
| 「历史任务」按钮 | 移到概览团队信息卡作次级链接 | 原型口径，操作子页解散 |
| worker 扫描目录 | `PLAN_DOCS_DIRS` **末尾**追加 `.omo/drafts`；写入落点 `PLAN_DOCS_DIR=PLAN_DOCS_DIRS[0]` 不动 | `exec-server.ts:1011` 同名先命中优先，追加不改既有优先级 |
| parity 门 | 沿用 evidence 一行 diff，不新造脚本/CI | 仓库无 CI、无根 package.json |
| e2e 策略 | 新 testid 断言写进已接线的 `pages.spec.ts`，不接回 16 个孤儿 spec | 接线孤儿 spec 是独立工程，超范围 |
| 身份不明的计划文件 | 自动归档时 `category` 恒为 `计划`，**不做内容猜测分类** | 用户 D7：不过度控制；扫描对象本身就是计划目录 |

## Findings (cited - path:lines)

### A. 实测（live 探测 t_0000000001，pending_review）

| 接口 | 返回 | 判读 |
| --- | --- | --- |
| `GET /tasks/t_0000000001/plan` | `status:"draft"`；summary/scopeIn/scopeOut/frozenVersion/frozenHash/confirmedBy/finalizedBy 全 null；rejectCount 0 | 计划行仅 auto-ensure 草稿，生命周期从未推进 |
| `GET .../plan-steps` | `steps:[]` `workerId:"w_compose_worker"` `degraded:false` | 会话可达但 agent 从未建 todo |
| `GET .../plan-docs` | `files:[]` `directory:"/data/vteam-worker/tasks/t_0000000001"` `degraded:false` | 目录可读且真空——从未写过计划文件 |
| `GET .../artifacts?pageSize=20` | total **7**，含「实施计划 v1.0」「实现方案」「需求说明书」 | 计划内容确实产出，被 submit_artifact 收走 |

7 条的 type/category/title：
```
file 设计    会话右侧面板改版
text 其他    总结报告 | 全链复盘+问题清单
file 测试报告 验证报告 | demo.py（T4 独立验证）
file None    demo.py
file 设计    实现方案 | demo.py CLI 契约（T2）
file 设计    实施计划 v1.0 | 流程走通演示     ← 计划被塞进「设计」
file None    需求说明书 | 流程走通演示        ← 需求竟未分类
```
**根因**：计划 Tab 三源（DB plans / 文件 / todo）从头到尾没被写过 = 结构性空壳；词表无「计划」类可认领；**全仓无任何提示词提过 `category`**（grep `submit_artifact`：seed.ts:507-509,566,568,1386 均只讲产出物不讲分类；唯一提及是协议文档 `docs/12-产出物协议与文档库.md:337`）。→ 这正是 D7 的依据：与其逼 agent 传 category，不如系统自己补。

### B. 结构差距（原型 10 点，真代码一个未落地）

- 团队子页 5：`overview|settings|memory|channels|actions` — `:174`，tab `:282-292`
- 任务子页 5：`status|plan|config|output|triggers` — `:752`，tab `:1041-1052`
- 主 Tab 默认「团队」— `:1293`
- 成员列表卡 — `:317-334`（应删，提示「成员管理在左侧面板」）
- 创建任务藏在「操作」— `:406-411`（应上提）
- 状态卡队列摘要行 — `:1063-1065`（应去）
- 状态卡三按钮横排 — `:1058-1071`（应改三层：标题全宽 → 状态+次级编辑 → grid-cols-2 主操作）
- 产出页任务详情重复 — `:1179-1183`（应去）
- 子页状态：`:261`/`:1007` 独立 state → **天然满足**
- 反向差距（**必须保留**）：轮次账本 `:522-547,617-635`、归档回执 `:636-659`、冻结版本哈希 `:591-608`、定稿/确认 `:660-681`、执行清单 `:685-710`、文档上传 `:1099-1108`

### C. 词表与 MCP 契约

- `ARTIFACT_TYPES=['text','doc','file']`（存储形态）— `artifacts.constants.ts:6`
- `ARTIFACT_CATEGORIES=['需求','设计','实现','测试用例','测试报告','运维','其他']`（**缺「计划」**）— `:16-24`；注释指唯一源 + web 镜像 + parity 门
- web 镜像同七类 — `web/src/lib/artifact-categories.ts:7-14`
- `submit_artifact`：`type` 必填 enum（`platform-mcp.tools.ts:215-219`）、`category` **optional** enum(ARTIFACT_CATEGORIES)（`:226-231`）
- `validateArtifactDeclaration` `artifacts.service.ts:92-103`；**未知字段忽略** `:52`
- **分类仅新建行写入**：`archiveFile` 注释 `:423-424`、`:438`；`append` 命中已有行只递增版本、`data` 不含 category（`:249-253`）→ 首次漏传后续补传无效
- 过滤管道现成：`QueryArtifactsDto.category`（`artifact.dto.ts:76`，是 `string` 非 enum）、`QueryTeamArtifactsDto extends`（`:102`）、`findByTask`（`artifacts.service.ts` ~:513）、`findByTeam`（~:600）→ `GET /tasks/:id/artifacts?category=计划` 直接可用

**⚠️ 新增：3 处硬编码枚举串（改词表必须同步，否则报错文案/工具描述与真实词表漂移）**
1. `server/src/platform-mcp/platform-mcp.tools.ts:230` — `describe('分类标签（可选）：需求/设计/实现/测试用例/测试报告/运维/其他其一；不传为未分类')`（工具 schema 给模型看的说明）
2. `server/src/platform-mcp/platform-mcp.service.ts:2713` — `'category 须为需求/设计/实现/测试用例/测试报告/运维/其他其一，不传为未分类'`（BadRequest 文案）
3. `server/src/artifacts/artifacts.service.ts:101` — `'非法声明：category 须为需求/设计/实现/测试用例/测试报告/运维/其他其一'`（validate 文案）
→ 三处 + `artifacts.constants.ts:16` + `web/src/lib/artifact-categories.ts:7` = **5 个必须一致的位点**，其中只有前两个是「数组本身」，parity 一行 diff **覆盖不到这 3 处串** → 计划须单独加一条同步 todo + 验收断言。

### D. 计划数据链（C2/C3b 的全部锚点）

**计划文件链（worker 扫描，D1 落点）**
- `worker/src/exec/exec-server.ts:143` **`export const PLAN_DOCS_DIRS = ['.omo/plans', '.opencode/plans'] as const;`** ← **`.omo/drafts` 缺失**
- `:145 PLAN_DOCS_DIR = PLAN_DOCS_DIRS[0]`（=`.omo/plans`，上传落点）
- `:451-452` 路由 `/plan-files` → `handlePlanFilesList`；`:988` 实现；`:1011` 注释「同名文件以**先命中的目录**为准（PLAN_DOCS_DIRS 顺序即优先级）」；`:1020 for (const rel of PLAN_DOCS_DIRS)`；`:1057` 日志 join；`:1069/:1136` 写路径恒 `PLAN_DOCS_DIR`
- server 只透传 directory：`plan-docs.service.ts:76-78 taskDirectory()` → `taskDirOf(work-dir.util.ts:34)` = `<WORK_DIR>/tasks/<taskId>`；`:85-103 listPlanDocs` → `locateWorker` → `workerClient.listPlanFiles`（`worker.client.ts:540`，GET `/plan-files?directory=`）
- `PlanDocsResult` 语义 `:19-20`：`degraded=false + files=[]` 才是「确实还没有计划」
- controller：`tasks.controller.ts:191-206`（GET plan-docs）、`:209-235`（POST 上传，tasks.edit 权限，worker 不可达 → 503）

**自动归档链（C3b 复用）**
- `artifacts.service.ts:395-496 archiveFile(taskId, {fileRef, storedUrl, storedName, sha256, title?, category?}, category?)` — sha256 去重（`:411-420`）、同 title append 新版（`:426-493`）、`artifactCategory = category ?? args.category ?? null`（`:424`）
- **自动归档先例**：`platform-mcp.service.ts:6361-6414 fetchAndArchiveAttachment` — worker fetchFile → `FileStorageService.saveBufferFile` → 算 sha256 → `archiveFile(...).catch(warn)` → 失败不阻断主流程
- 落盘工具：`FileStorageService.saveTextFile/saveBufferFile`（`uploads.service`）；`contentRef` 归一 `normalizeFileRef`

**计划步骤链（P1-5 修复点）**
- `plan-steps.service.ts:52-59` **`session.findFirst({ where: { teamId, teamMemberId: mainAgentMemberId }, orderBy: { updatedAt: 'desc' } })`** ← **不带 taskId 过滤**（实证）
- `:60-62` 缺 workerId/instanceRef → degraded；`:69-71` worker offline → degraded；`:74-78 listTodos(instanceRef)`
- `tasks.controller.ts:174-188` 定位链文档

**计划状态链** — `GET /tasks/:id/plan` 由 `PlanLifecycleService.getPlan` 提供；任务详情 `tasks.controller.ts:165-171` → `tasksService.findOne` → `toTaskDto`（`tasks.service.ts:1817`）

**提示词面（D7：只读，不改）**
- `seed.ts:507-509`（PM 产出物三类引导）、`:566,:568`（测试计划/报告）、`:583`（**计划员「计划全文落盘 `.opencode/plans/<kebab-name>.md`（唯一落盘位置）」**）、`:1855`（计划技能同款）、`:1772,:1775`、`:167 return '**.opencode/plans/**'`、`:1386`（工具注册「提交产出物到任务文档库」，无 category 说明）
- 原型技能示例不带 category：`docs/26-prototype-designer-skill.md:185`、`seed.ts:1622`
- **提示词是 DB 行**：`migrations/20260919000008_populate_builtin_role_prompts`、`20260919000009_backfill_split_agent_prompts` → 改提示词需 seed+迁移。**D7 决定：不改，故此链路整体移出范围。**

### E. 缺陷清单（全部带行号）

P0:
1. **reuseMutation no-op** — `TeamRightPanel.tsx:374` `onClick={() => reuseMutation.mutate(reuseSession)}`、`:375` keydown 同错；应传 `!reuseSession`（对照正确路径 `:386 onToggleReuse={(next)=>reuseMutation.mutate(next)}`）
2. **计划 Tab 结构性空壳** — 见 A 段

P1:
3. **6 处错误伪装成空**（无 isError 分支，失败与真空同文案）：渠道 `:219`、执行清单 `:693`、计划文档 `:1115`、执行步骤 `:1152`、产出物 `:1189`、待办 Issue `:1223`；唯一带 isError 的是触发器 `:920-923`
4. **plan 查询 isMember 门** — `:496 enabled: !!taskId && isMember`，`isMember = !!viewer?.id`（`:483-485`）
5. **plan-steps 会话定位不带 taskId** — `plan-steps.service.ts:52-59`
6. **产出物/Issue 截断 5 条** — `:1193 slice(0, 5)`、`:1227 slice(0, 5)`（实测产出 7 条被截）

P2:
7. **队列空无空态文案** — `:76-101` `length>0 ? ... : null`
8. **成员列表空无空态** — `:317-333` map 空数组
9. **触发器 `retry:false` + 30s 轮询** — `:819`，出错每 30s 刷错误条
10. **`resetAfterComplete` 不在 `toTaskDto`** — DTO 起于 `tasks.service.ts:1817`；字段仅出现 `:81,:400,:706-707,:1709,:1722`

### F. 测试基建（QA 只引用可运行命令）

- **web 零单测**：`web/package.json` 无 `test` script、无 vitest/jest 依赖、无 `*.test.*`
- **web e2e 22 spec，默认只跑 6** — `playwright.config.ts` projects（L36-64）过滤；实测 `npx playwright test --list` → 54 tests / 7 files（login, pages, docs-unified, team-user-members, perf, guard + auth.setup）
- **16 孤儿 spec 不可运行**（`npx playwright test plan-status --list` → `No tests found`）：`plan-status`/`plan-finalize`/`plan-archive`/`session-unification` 等；历史靠 `.t*.playwright.config.ts`、`/tmp/su12...` 跑，**全部缺失**
- **testid 断言覆盖**：6 个目标 testid 里**只有 `plan-status-badge` 被断言**（且只在孤儿 spec + `reference/testids.ts:214`）；`task-subtab-triggers`/`team-queue-card`/`trigger-empty`/`plan-doc-row-*`/`plan-step-*` **零断言**
- 默认可跑且沾右栏：`pages.spec.ts:88-108`（right-tab-status/config/output）、`:234`（artifacts→docs）、`docs-unified.spec.ts:251`（7 类 chips 契约）、`guard.spec.ts`
- **server**：`npm run test` = `jest --runInBand`（`server/package.json:16`，串行）；artifacts×3（`artifacts.service.spec.ts:1166` 有 category 套件）、plan×10、`docs-site/prototypes.service.spec.ts`；`test:cov` 与 `test:e2e` 非串行
- **typecheck**：两端均无 script → `npx tsc --noEmit -p tsconfig.json`（先例 `task-4-category-write.md:16`）
- **lint**：`npm run lint --prefix web` / `--prefix server`
- **parity 门**：非脚本/非 CI/非测试，是 evidence 一行 diff —— `.omo/evidence/docs-artifacts-merge/task-4-category-write.md:18`；`scripts/verify-instruction-parity.mjs` 是**另一个**门
- **无 `.github/workflows`、无根 package.json** → 所有门都是本地命令
- playwright 证据落 `.omo/evidence/phase5-t9-playwright.json`（`playwright.config.ts:27`）；跑前需 `next dev` :3001 + server :13000 + 系统 Chrome（`:6` 不自启 webServer）

### G. 上游已知事实（避免执行期重复踩坑）

- 原型已部署：产出物 `art_0000000007`，`fileRef=/uploads/session-right-panel-v2.tsx`，源码端点 `GET /docs-site/t_0000000001/prototypes/session-right-panel-v2/index.tsx` 200 且含新布局
- 原型规范：`export const meta={id,name,device}`（正则 `/export\s+const\s+meta\s*=\s*(\{[^}]+\})/s`，meta 内不可嵌套花括号）+ `export default function`；hooks 必须 `import … from "react"`；沙箱内 `@proto/shared` 被 stub → 原型须自包含 react+tailwind
- `.tsx` 不在上传白名单（`uploads/constants.ts`）→ 更新原型须 `docker cp` 进容器 + 产出物 append
- 产出物 append 空 content 会撞空串 sha256 返回 `duplicate`（版本不涨）；原型读 `contentRef` 路径文件，改文件即可
- 登录用 JWT（`POST /api/v1/auth/login` → `accessToken`，后续 `Authorization: Bearer`），不是 Cookie
- `vteam_submit_artifact` MCP 因本会话不在任务活跃成员集合并无团队会话，传 `current` 403 `PLATFORM_MCP_FORBIDDEN` → 只能走 REST
- **本会话无 shell 工具（bash 不可用）** → 凡「跑脚本/跑测试」类步骤必须写明由**执行 worker**运行；规划阶段不可代跑

## Resolved questions (owner-answered)

| # | question | answer | 出处 |
| --- | --- | --- | --- |
| Q1 | 计划 Tab 方案 | **混合**：category=「计划」聚合 + worker 感知（三目录含 `.omo/drafts`）；**只做一个展示地区** | 用户原话 2026-09-22 |
| Q2 | 历史分类回填 | **不回填** | 用户选定 |
| Q3 | category 必填？ | **保持可选** | 用户选定 |
| Q4 | 测试策略 | **tests-after** | 用户选定 2026-09-22 |
| Q5 | 「只一个展示地区」读法 | **以当前原型为准** → 3 张卡 | 用户选定 2026-09-22 |
| Q6 | 是否用提示词强引导 category | **否，撤销**；改为系统扫描自动归档 + **不控制 agent 行为** | 用户第二轮原话 2026-09-22 |
| Q7 | 自动归档是否含 `.omo/drafts` 草稿 | **三处全归档**（`.opencode/plans` + `.omo/plans` + `.omo/drafts`），扫描与归档范围一致、无特例；靠 `archiveFile` 既有 sha256 去重挡重复，改稿 append 新版本即计划工作痕迹 | 用户选定 2026-09-22 |

## Scope IN

- **C1** 右栏结构：团队 5→2（概览合并设置+记忆、渠道保留、删成员列表卡、创建任务上提、历史任务降次级链接、操作子页解散）；任务 5→4（删「配置」，字段并入状态卡元信息）；有任务默认落「任务」；切换保留子页状态；状态卡去队列摘要行 + 按钮三层；产出去任务详情。
- **C2** 计划 Tab：保持原型 3 卡；状态卡保留全部评审闭环；**「计划文档」卡=唯一内容区**，聚合三目录感知文件 + `category=计划` 产出物（来源徽章）；补 6 处 isError 与 degraded/真空区分；修 isMember 门；plan-steps 定位补 taskId 过滤。
- **C3** 词表：server+web 双源加「计划」；**同步 3 处硬编码枚举串**；parity 一行复验；**category 仍可选**（schema `describe` 串改成含「计划」的准确描述，属事实校正非行为引导）。
- **C3b** **计划目录自动归档**：任务进入 `pending_review` 时（`accept` 幂等兜底）扫描 `<任务目录>/{.opencode/plans,.omo/plans,.omo/drafts}/*.md`，对未归档内容复用 `archiveFile` 落产出物库并带 `category=计划`；失败仅 warn 不阻断（对齐 `fetchAndArchiveAttachment`）。
- **C3c** worker 扫描：`PLAN_DOCS_DIRS` 末尾追加 `.omo/drafts`（读取面），写入落点不动；注释/日志同步。
- **C3d** **角色/技能提示词一律不改**（D7 红线）：不加 category 引导、不改 `seed.ts`、不加提示词回填迁移。
- **C4** P0×2 + P1×4 修复。
- **C5** P2×3 修复。
- **C6** 质量门：双端 `tsc --noEmit`、双端 lint、server `npx jest --runInBand` 相关套件、parity 一行、`npx playwright test --project=pages --project=docs`；新 testid 断言落 `pages.spec.ts`。
- **原型同步**：改码前把原型补到最终设计并 `docker cp` + 产出物 append 重部署。
- **文档**：`docs/agent-platform/12-产出物协议与文档库.md` 补「计划」类 + worker 多目录 + 自动归档说明。

## Scope OUT (Must NOT have)

- **不改任何角色/技能提示词**（不加 category 引导、不改 `seed.ts`、不加提示词回填迁移）——D7 红线。
- 不重建计划生命周期状态机（plans 表流转、评审轮次账本、冻结哈希机制语义一律不动）。
- 不删除或降级：轮次账本、归档回执、冻结版本哈希、定稿/确认按钮、执行清单、计划文档上传。
- 不把 `category` 改必填、不改 `type` 的 text/doc/file 语义、不改未知字段忽略的前向兼容。
- 不回填/改写任何历史产出物分类。
- 不改 artifacts 表结构、不加 DB 表、不动版本/验收/去重语义。
- **不改 `PLAN_DOCS_DIR`（写入落点）**——只扩读取扫描目录，上传仍落 `.omo/plans`。
- **不在 GET plan-docs 等读路径上写库**（自动归档只走状态机事件点）。
- 不动 worker 执行引擎其他部分、platform-mcp 其他工具、realtime/事件链路、RBAC、throttle 配额。
- 不把 16 个孤儿 playwright spec 接回 config。
- 不改站点主题、不做视觉重设计。

## Approval gate
status: awaiting-approval
approach: 见 frontmatter approach（C1–C6 + D1–D9 + Announced defaults；Q1–Q7 已定，无未决分叉）
next-action: **等待用户显式批准** → 手写 `.omo/plans/session-right-panel-plan-overhaul.md`（scaffold 无 shell 不可执行，手工按模板头部顺序生成，首标题 `## TL;DR (For humans)`）→ 派 Metis 缺口分析 → APPEND Todos（实施行 `- [ ] N.`、验证行 `- [ ] F<n>.` 均顶格）→ 回填 TL;DR → 结构自检 → 因 `review_required:false`，交付时把「直接开工 / 先跑高精度双复核」作为唯一问题交回用户
<!-- Durable gate: on resume, read this field and continue at plan creation; do NOT re-explore. -->