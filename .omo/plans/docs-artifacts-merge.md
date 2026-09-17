# docs-artifacts-merge - Work Plan

## TL;DR (For humans)

**What you'll get:** `/artifacts?teamId=` 与 `/docs/:taskId` 合并为唯一的团队级文档站 `/docs?teamId=&taskId=&doc=`。合并后文档站支持全部产出物类型（含之前被镜像层丢掉的**结论文本 `text`**，直接按 md 渲染）、支持分类标签（需求/设计/实现/测试用例/测试报告/运维/其他/未分类）筛选、支持更多文件类型的展示或下载（PDF 原生沙箱预览、Word/表格下载卡片、txt/csv/json 预览）。数据源统一为 DB API + `/uploads`，退役磁盘镜像派生层（`DocsMirrorService`），原型 tab 改为按 DB `contentRef` 直读 uploads，能力不变。

**Why this approach:** 两页是同一份 `Artifact/ArtifactVersion` 数据的两套渲染：`/artifacts` 读实时 DB API（有 text、有版本、无 md 渲染），`/docs` 读磁盘镜像派生视图（有 md 渲染、无 text、无版本）。镜像层还是有损的（丢 text、丢历史）、易失的（无 compose 卷，recreate 即丢）、脏的（`docs-root` 未 gitignore）。DB API + `/uploads` 已能给出所有字节（含原型 `.tsx` 源码），单源是最短收敛路径；分类必须做成与 `type` 正交的可空元数据列（`plan-removal.guard.spec` 断言 `ARTIFACT_TYPES` 恒为三态，加第 4 种 type 会直接挂测试）。

**What it will NOT do:** 不引入 mammoth/docx 解析库（Word 下载卡片）；不改 `ARTIFACT_TYPES`；不碰任务/权限/实时等无关模块；不做全文搜索；不考古历史磁盘镜像（只迁移当前版本）；`POST /uploads?taskId=` 归档路径不传 category（回填覆盖，展示为"未分类"）。

**Effort:** Large — 13 个实现任务分 4 波：schema/回填 → 后端 API → 前端合站 → 删除与测试收尾。
**Risk:** Medium — 主要风险是原型 tab 在镜像删除后黑屏（用"先改直读、验证非空、再删镜像"+零引用 grep 门收敛）、slug 深链断裂（先统一 slug+单测锁定）、text-as-markdown XSS（显式 `urlTransform` 白名单 + Playwright 负测）。
**Decisions to sanity-check:** 1) 退役镜像（Metis 裁决：bake in，不留双读 fork）；2) 分类词表用中文七类 + 可空，未分类用 NULL 而非 '其他'（回填只写能命中的，`其他` 留给人/Agent 显式选）；3) `/artifacts` 做 Next.js 客户端 `router.replace` 重定向而非 308（server 是纯 API 进程，无页面 serving 层）。

Your next move: 批准后运行 `$start-work docs-artifacts-merge` 启动执行；或先跑高精度复审。

---

> TL;DR (machine): Large/Medium — merge /artifacts + /docs/:taskId into team-scoped /docs (DB-only), add nullable Artifact.category + team aggregation endpoint, retire DocsMirrorService (prototypes re-plumbed to /uploads), extend render matrix (text→md, pdf→sandboxed iframe, office→download)

## Scope
### Must have
- Prisma：`Artifact.category String?` + `@@index([taskId, category])` + migration `20260919000000_add_artifact_category`（仅可空列，不设 NOT NULL/默认值）；`prisma validate` 通过
- 回填脚本 `server/scripts/backfill-artifact-category.ts`：幂等 + `--dry-run`，标题关键词有序规则（见附录），跑两次第二次 0 行变更；命中不了的保持 NULL（展示"未分类"）
- slug 去重优先：新建 `server/src/artifacts/artifact-slug.ts` + `web/src/lib/artifact-slug.ts`（同一逻辑双实现，注释互指），两端单测锁定 8+ 用例（空格/中文/重名/case/后缀），替换 `DocsMirrorService.docIdFor/toSlug` 与 `web/src/components/tasks/task-detail-types.ts:150 docIdFor` 全部调用方；`?doc=` 生成与解析只准 import 它
- 后端写路径：`ARTIFACT_CATEGORIES` 常量（server 唯一源，web 用字面量镜像 + grep 门）；`CreateArtifactDto.category`（`@IsOptional @IsIn`）+ `validateArtifactDeclaration` 保持未知字段忽略；`append()`/`archiveFile()` 落库；`QueryArtifactsDto.category` + `findByTask()` 过滤；`toArtifactListItem` 透出 `category`
- 新端点 `GET /teams/:id/artifacts?taskId=&type=&category=&accepted=&page=&pageSize=`：复用 `findByTask` 形状 + `taskName`，`PermissionGuard` + `artifacts.view`，团队成员域校验与任务端点同权；团队视图只准调它，删除前端 per-task fan-out 循环
- `submit_artifact` zod 加可选 `category`（enum + 中文词表描述）并透传；`doclib` 清单/详情透出 `category`；更新 `seed.ts:1460-1491` 过时 registry 描述注释
- 原型改直读（删镜像前必须先绿）：`GET /docs-site/:taskId/prototypes` 与 `GET .../prototypes/*` 改为 DB 查询（`type='file'` 当前版本 + `.tsx`/`.prototype.json` 后缀）+ `readUploadedFile` 读 `contentRef`，响应形状与文件名白名单**原样保留**（`name/index.tsx` / `name.json`），复用 `prototypeSlug/prototypeFileName`（搬移不改写）；前端 hooks 不动；Prototype tab 非空验证通过才允许删镜像
- 统一页 `web/app/(main)/docs/page.tsx`：团队选择器 + 任务选择器 + 分类/type/验收 chips（复用 `SegmentedTabs` 或 artifacts pill 范式，`data-active` 契约保留）+ 文档树 + 富渲染（复用 `DocsMarkdown`，纯文本卡片复用共享 `Markdown`）+ 全类型版本查看器 + 删除按钮（原 docs 页同权）；数据源只准团队聚合端点 + `GET /artifacts/:id` + `GET /artifacts/:id/versions/:v`
- 渲染矩阵（见附录）：`text→DocsMarkdown`（显式 `urlTransform` 仅 http/https/mailto）+ `txt/csv/json→<pre>`（256KB 截断）+ `pdf→sandbox` iframe（无 `allow-scripts`/`allow-top-navigation`，加载失败回退下载卡）+ `doc/docx/xls/xlsx→` 下载卡 + 图片内嵌（svg 保持 `<img>` 上下文，不做 innerHTML）
- 路由：`/artifacts/page.tsx` 改为读 `searchParams` 全量透传 `router.replace('/docs?...')` 的瘦重定向页；`/docs/[taskId]/page.tsx` 改为同组件薄别名（`taskId` 预填，不二次跳转）；改 `board/page.tsx:509` 与 `session/page.tsx:1311` 的两处 `/artifacts` 跳转为 `/docs?teamId=`；其余 `/docs/:id` 跳转保持不动（别名兼容）
- 删除：`docs-mirror.service.ts` + spec、`DocsSiteModule` 在 `ArtifactsModule` 的接线、`append` 内 `syncTask` 调用、`registry`/`prd/:file` 端点 + spec、`toSlug/docIdFor` 旧实现；`.gitignore` 加 `server/docs-root/`；零引用 grep 门
- 测试：更新 `artifacts.service/controller.spec`、`platform-mcp` submit_artifact/doclib、`pages.spec.ts:223`/`guard.spec.ts:15` 改断言重定向、删除孤儿 `docs-site.spec.ts`（不在任何 playwright project，删除而非接入）、新增 `web/e2e/docs-unified.spec.ts`（happy/edge/failure/XSS 四组，见验证策略）

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不改 `ARTIFACT_TYPES`（guard spec 锁定三态）；不给 `submit_artifact` 加必填参数；不动任务/权限/实时/gate 逻辑
- 不引入 mammoth/docx-preview/pdfjs/sheetjs 及任何 Office 解析依赖；不建"通用预览框架"抽象；不换 TOC/主题库；`tokens.ts` 基线不动
- 不建 `packages/shared`（server/web 分开部署，跨包共享是范围蔓延；词表/slug 用"双实现 + 互指注释 + grep/单测门"收敛，偏离 Metis 默认已记录在附录）
- 不做全文搜索、分页重构、实时协作；不迁移磁盘历史版本（只认 DB 当前版本）；不动 4 处导航之外的 IA
- 不提交/不追踪 `docs-root` 内容；不给 compose 加卷（删镜像后无磁盘写入）
- 删除 `DocsMirrorService` 不许留半截接线（死 import、空目录写、孤儿端点），以 grep 门验收

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + 缺口补齐（server `jest --runInBand` 补 category/聚合端点/原型直读单测；web 以 `playwright` 覆盖合站；`tsc --noEmit` 双包 + `eslint` 双包）
- Evidence: `.omo/evidence/docs-artifacts-merge/task-<N>-<slug>.md`（每 todo 一份，命令 + 断言 + 日志/截图路径）
- 关键命令：`npm run lint --prefix web`、`npm run lint --prefix server`、`npm test --prefix server -- --runInBand`、`npx tsc --noEmit -p web/tsconfig.json`、`npx tsc --noEmit -p server/tsconfig.json`、`npx playwright test web/e2e/docs-unified.spec.ts --reporter=line`
- UI QA（Playwright，非人工）：happy — 进 `/docs?teamId=T&taskId=K&doc=<slug>` 断言 md 渲染 + TOC + 版本查看器 + 原型 tab 非空；edge — `txt/csv/json` 断言 `<pre>`、`pdf` 断言 `iframe[sandbox][src*="/uploads/"]`、`docx` 断言下载卡且无 iframe；failure — 未知 `?doc=` 空态、无 `teamId` 团队选择器
- 安全 QA：提交 `type='text'` 含 `<script>alert(1)</script>` 与 `[x](javascript:alert(1))` 的产出物，断言脚本被剥离且 console 无执行；断言 PDF iframe 含 `sandbox` 且无 `allow-scripts`
- 回填 QA：`--dry-run` → 实跑 → 再跑（第二次 0 行变更），`SELECT count(*) ... WHERE category IS NOT NULL` 与预期命中数一致
- 零行覆盖要求：seed 零 Artifact 行，QA fixture 由 T12 内 e2e global-setup 经 API 直写的脚本化 setup 保证（至少 1 text 含 XSS payload + 1 md + 1 txt + 1 pdf + 1 docx + 1 tsx 原型，分布 category）

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1（无依赖，可并行）：T1 schema 迁移 + T3 slug 去重 — T3 是深链不断裂的前提，必须与 T1 同波先行
- Wave 2（后端，可并行）：T2 回填脚本（需 T1 落库）+ T4 写路径（需 T1）+ T6 原型改直读（需 T3 slug）+ T7 MCP（需 T4 落库语义）— T4/T6/T7 同波不同文件可并行，T5 需 T4 完成
- Wave 3（前端，可并行）：T5 聚合端点收尾后 → T8 合站 + T9 渲染矩阵（同目录串行，T9 blocked by T8 防冲突）+ T10 路由（需 T8 组件落位）
- Wave 4（收尾串行）：T11 删镜像（需 T6、T8 双绿）→ T12 测试与 QA fixture → T13 证据与文档

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,4 | 3 |
| 2 | 1 | 12 | 3,4,6 |
| 3 | — | 6,8,10 | 1,2 |
| 4 | 1 | 5,7 | 2,3,6 |
| 5 | 4 | 8 | 6,7 |
| 6 | 3 | 11 | 2,4,5,7 |
| 7 | 4 | 12 | 2,5,6 |
| 8 | 3,5 | 9,10,11 | — |
| 9 | 8 | 12 | 10 |
| 10 | 8 | 12 | 9 |
| 11 | 6,8 | 12 | — |
| 12 | 2,7,9,10,11,14 | 13 | — |
| 13 | 12 | — | — |
| 14 | 8 | 12 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.

- [x] 1. Prisma 加 `Artifact.category` 可空列与迁移
  What to do / Must NOT do: `schema.prisma` 的 `Artifact` 加 `category String?` + `@@index([taskId, category], map: "idx_artifacts_task_category")`；新建 `server/prisma/migrations/20260919000000_add_artifact_category/migration.sql`（仅 `ADD COLUMN category TEXT NULL` + 建索引，不许 NOT NULL/DEFAULT）；跑 `prisma validate` + 零行库 `migrate deploy` 烟测；Must NOT 动 `type` 列、`ArtifactVersion`、`@@unique([artifactId, version])`、`idx_artifacts_task_type`
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,4
  References (executor has NO interview context - be exhaustive): `server/prisma/schema.prisma:417-432` Artifact 模型与索引命名惯例、`server/prisma/migrations/20260918000000_add_plan_frozen_columns/migration.sql` 最新迁移文件格式、`server/prisma/migrations/20260827000000_expand_artifact_content/migration.sql` 上一次 artifact 形变、`server/src/artifacts/artifacts.service.ts:110-118 onModuleInit resyncIdPrefix`（新列不涉及 id 域，不许碰）
  Acceptance criteria (agent-executable): `npx prisma validate --schema server/prisma/schema.prisma` 退出 0；`grep -A2 "ADD COLUMN" server/prisma/migrations/20260919000000_add_artifact_category/migration.sql | grep -qi "NOT NULL"` 为空（无非空约束）；`grep -c "category" server/prisma/schema.prisma` ≥ 2（字段 + 索引）；`npx prisma migrate deploy --schema server/prisma/schema.prisma` 退出 0 且 `npx prisma db execute --schema server/prisma/schema.prisma --stdin <<< "DESCRIBE Artifact;" | grep -q category`（迁移已在执行库 APPLY，不止写文件）
  QA scenarios (name the exact tool + invocation): happy — `npm test --prefix server -- --runInBand src/artifacts/artifacts.service.spec.ts` 全绿（schema 变更无回归），证据 `.omo/evidence/docs-artifacts-merge/task-1-category-migration.md`；failure — 把列改成 `String` 必填后 `migrate deploy` 在有 NULL 行的库上失败，证明可空是必须的（记录，不提交该改动）
  Commit: Y | feat(artifacts): add nullable category column

- [x] 2. 回填脚本（幂等 + dry-run）
  What to do / Must NOT do: 前置断言列存在（`DESCRIBE Artifact` 含 category，否则停止）；新建 `server/scripts/backfill-artifact-category.ts`（prisma 直连，lone script 不入 module）：按附录关键词有序规则逐行 `updateMany`（仅 `category IS NULL` 行，不许覆盖已有值）；`--dry-run` 只打印将写行数；二次运行 0 变更；Must NOT 写 `其他`（命中不了就留 NULL）、Must NOT 碰 `type/title/contentRef`
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 12
  References: `server/prisma/seed.ts`（零 Artifact 行的现状依据）、附录"分类词表与回填规则"、`server/src/prisma/prisma.service.ts` 连接方式（抄既有 script 的取用 Muster，若无则抄 `rebuildAll` 的 `prisma.task.findMany` 调用形）
  Acceptance criteria (agent-executable): `npx ts-node server/scripts/backfill-artifact-category.ts --dry-run` 退出 0 且输出 `will update: N`；实跑后复跑输出 `updated: 0`；`SELECT category, count(*) ... GROUP BY category` 只有词表内值或 NULL
  QA scenarios: happy — 构造 10 行混合标题 fixture 跑脚本，断言映射全对且复跑 0 变更，证据 `.omo/evidence/docs-artifacts-merge/task-2-backfill.md`；failure — 故意给一行已设 category 的行换标题复跑，断言其值不变（不覆盖守卫）
  Commit: Y | feat(artifacts): idempotent category backfill script

- [x] 3. slug 逻辑去重（server + web 双实现 + 单测锁死）
  What to do / Must NOT do: 新建 `server/src/artifacts/artifact-slug.ts`（`toSlug/docIdFor` 从 `docs-mirror.service.ts:505-525` 原样搬移，注释互指 web 镜像）+ `web/src/lib/artifact-slug.ts`（从 `task-detail-types.ts:147-175` 搬移）；两端各建 `*.spec.ts` 覆盖 8+ 用例（空格/中文/纯符号/大小写/重名去重/空标题/超长/数字）；替换 `docs-mirror.service.ts` 与 `task-detail-types.ts` 内调用为 import（旧函数删或转调，不许留两套逻辑）；Must NOT 改 slug 算法本身（深链兼容）
  Parallelization: Wave 1 | Blocked by: — | Blocks: 6,8,10
  References: `server/src/docs-site/docs-mirror.service.ts:467-525` buildRegistry 去重 + toSlug/docIdFor 全量、`web/src/components/tasks/task-detail-types.ts:140-180` docIdFor 全量、`web/app/(main)/teams/[id]/session/page.tsx:1321-1324` 深链生成侧（只读，不改）
  Acceptance criteria: `npm test --prefix server -- --runInBand src/artifacts/artifact-slug.spec.ts` 全绿；`grep -rn "function docIdFor\|function toSlug\|const toBase\|function toDocSlug" server/src web/src --include="*.ts" --include="*.tsx" | grep -v "artifacts/artifact-slug.ts\|lib/artifact-slug.ts" | wc -l` → `0`（定义只许存在于两新文件；web 内 `toBase` 闭包为搬移算法本体，不计）；`grep -rn "docIdFor" server/src/docs-site/docs-mirror.service.ts` 命中 import 而非定义
  QA scenarios: happy — 8 用例全绿且 server/web 同输入同输出抽查一致，证据 `.omo/evidence/docs-artifacts-merge/task-3-slug.md`；failure — 改 web 实现大小写规则后单测变红，证明锁有效（记录后还原）
  Commit: Y | refactor(artifacts): dedupe slug logic server+web

- [x] 4. 后端写路径与查询：category 落库 + 过滤 + 透出
  What to do / Must NOT do: `artifacts.constants.ts` 加 `ARTIFACT_CATEGORIES = ['需求','设计','实现','测试用例','测试报告','运维','其他'] as const`（server 唯一源）；新建 `web/src/lib/artifact-categories.ts` 导出同字面量七类（文件头注释互指 server 源，不许各自演进）；`CreateArtifactDto` 加可选 `category`（`@IsOptional @IsIn`）；`append()` 新建/append 事务写入 `category`（submission/args 透传；append 命中已存在行时不许覆盖原 category）；`archiveFile()` 签名加可选 `category`（默认 undefined）；`QueryArtifactsDto` 加可选 `category` + `findByTask()` where；`toArtifactListItem` 加 `category`；补 service/controller 单测（落库/过滤/透出/非法值 400）；Must NOT 改 `ARTIFACT_TYPES`、幂等键、accepted 语义
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5,7
  References: `server/src/artifacts/artifacts.constants.ts:1-18`、`server/src/artifacts/dto/artifact.dto.ts:18-78`、`server/src/artifacts/artifacts.service.ts:140-280 append` + `389-460 archiveFile` + `toArtifactListItem/findByTask`（`lsp_goto_definition` 定位）、`server/src/artifacts/artifacts.service.spec.ts` 现有 `append/findByTask` 用例形（照抄 fixture 风格）、`server/src/platform-mcp/plan-removal.guard.spec.ts`（三态断言，跑通即未破坏）
  Acceptance criteria: `npm test --prefix server -- --runInBand src/artifacts src/platform-mcp/plan-removal.guard.spec.ts` 全绿；`curl -H "Authorization: Bearer $E2E_TOKEN" "$BASE/api/v1/tasks/$TID/artifacts?category=需求" | jq -e '.items | length>0 and all(.category=="需求")'`；非法 category 返回 400 `ARTIFACT_INVALID_DECLARATION`；`grep -Fq "'测试用例'" web/src/lib/artifact-categories.ts` 且 `diff <(sed -n "/ARTIFACT_CATEGORIES/,/] as const/p" server/src/artifacts/artifacts.constants.ts | grep -o "'[^']*'" | sort) <(grep -o "'[^']*'" web/src/lib/artifact-categories.ts | sort)` 退出 0（只比词表块，不误伤文件内其它字符串）
  QA scenarios: happy — 落库/过滤/透出/append 不覆盖旧值四断言绿，证据 `.omo/evidence/docs-artifacts-merge/task-4-category-write.md`；failure — 传 `category=不存在的类` 断言 400，否则失败
  Commit: Y | feat(artifacts): persist/filter/expose category

- [x] 5. 新聚合端点 `GET /teams/:id/artifacts`
  What to do / Must NOT do: `ArtifactsController` 加 `@Get('teams/:id/artifacts')`（`PermissionGuard` + `artifacts.view`；团队成员域校验对齐任务端点的反查语义）；service 加 `findByTeam(teamId, {taskId?, type?, category?, accepted?, page, pageSize})`（`task.teamId` 约束 + 复用 `findByTask` 的 where/分页逻辑，返回项 = 列表项 + `taskName`）；分页锁死数值：`page` 默认 1，`pageSize` 默认 20、上限 100，超限截断到 100（与任务端点同值）；补 controller/service 单测（含非成员 403/404）；Must NOT 改现有 6 个端点签名
  Parallelization: Wave 2/3 | Blocked by: 4 | Blocks: 8
  References: `server/src/artifacts/artifacts.controller.ts:38-50` 端点与守卫叠加形、`server/src/tasks/tasks.controller.ts:72-80` 团队作用域分页惯例（page 默认 20 上限 100）、`web/app/(main)/artifacts/page.tsx:797-822` 现有 N+1 fan-out（新端点要替代的语义）
  Acceptance criteria: `curl -H "Authorization: Bearer $E2E_TOKEN" "$BASE/api/v1/teams/$TID/artifacts?category=需求" | jq -e '.items | length>0 and all(.category=="需求")'` 且返回项含 `taskName/taskId`；`pageSize=1000` 请求返回 `pageSize<=100`；`npm test --prefix server -- --runInBand src/artifacts` 全绿
  QA scenarios: happy — `taskId/type/category/accepted` 四过滤器各断言一次 + 越权 403，证据 `.omo/evidence/docs-artifacts-merge/task-5-team-endpoint.md`；failure — 非成员调新端点不断言 403 则失败
  Commit: Y | feat(artifacts): team-scoped aggregation endpoint

- [x] 6. 原型改直读（删镜像的前置门）
  What to do / Must NOT do: `listPrototypes/readPrototype` 改为 DB 实现：查 `type='file'` 当前版本且 `contentRef` 以 `.tsx`/`.prototype.json` 结尾的行，`prototypeSlug/prototypeFileName` 必须搬入 `server/src/artifacts/artifact-slug.ts`（追加导出，不新建文件，逻辑不动）算名，`readUploadedFile(contentRef)` 取源码，meta 正则解析保留；响应形状 `{id,metaId?,name,file,artifactId}` 与白名单（`name/index.tsx`/`name.json`）原样；`doSyncTask` 的原型写盘保留到 T11（本 todo 只改读）；前端 hooks 不动；Must NOT 改 `prototype-sandbox` iframe 属性
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 11
  References: `server/src/docs-site/docs-mirror.service.ts:226-368 listPrototypes/readPrototype` 全量（逻辑蓝本）、`web/src/features/docs-site/hooks.ts:45-76 usePrototypes/usePrototypeSource`（契约消费侧，不动）、`web/src/features/docs-site/prototype-sandbox.tsx:72,170-171` iframe 取数与 sandbox 属性
  Acceptance criteria: 有 tsx 原型的任务 `curl -H "Authorization: Bearer $E2E_TOKEN" "$BASE/api/v1/docs-site/$TID/prototypes" | jq -e '.items | length>0 and all(has("id") and has("name") and has("file") and has("artifactId"))'`；`GET .../prototypes/<file>` 内容与 uploads 源字节一致（`diff` 退出 0）；mirror spec 中原型读用例改测 DB 实现后全绿
  QA scenarios: happy — Playwright 进 `/docs/<taskId>?proto=<id>` 原型 tab 非空且沙箱渲染，证据 `.omo/evidence/docs-artifacts-merge/task-6-proto-direct.md`；failure — 停掉磁盘 `prototypes/` 目录后列表仍非空（证明已脱离磁盘），否则失败
  Commit: Y | feat(docs-site): serve prototypes from DB+uploads

- [x] 7. `submit_artifact` + `doclib` 透出 category
  What to do / Must NOT do: `platform-mcp.tools.ts:204-220 submitArtifactSchema` 加 `category: z.enum(ARTIFACT_CATEGORIES).optional()` + 描述写清中文词表；handler 透传给 `append`；`doclib` 清单/详情加 `category`；`controller.spec` 的 "26 个工具"/schema 断言同步；`seed.ts:1460-1491` registry 旧描述注释更新为 DB 直读；补 `submit_artifact` category 用例；Must NOT 加必填项、不动其它工具
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 12
  References: `server/src/platform-mcp/platform-mcp.tools.ts:204-222`、`server/src/platform-mcp/platform-mcp.service.spec.ts:2496` submit_artifact describe 块、`server/src/platform-mcp/platform-mcp.controller.spec.ts` 工具数/schema 断言、`server/prisma/seed.ts:1460-1491`
  Acceptance criteria: `npm test --prefix server -- --runInBand src/platform-mcp` 全绿；MCP 调 `submit_artifact` 带 `category=测试用例` 落库可查
  QA scenarios: happy — 带/不带 category 双路径 + doclib 透出断言，证据 `.omo/evidence/docs-artifacts-merge/task-7-mcp-category.md`；failure — 缺 category 的旧调用回归失败则本 todo 失败
  Commit: Y | feat(platform-mcp): submit_artifact/doclib category passthrough

- [x] 8. 统一文档站页 `/docs`（团队级外壳，DB-only）
  What to do / Must NOT do: 新建 `web/app/(main)/docs/page.tsx`：读 `?teamId=&taskId=&doc=`；团队/任务双选择（`GET /tasks?teamId=` 复用 board 页模式）；分类 chips 数据源只准 `import { ARTIFACT_CATEGORIES } from "@/src/lib/artifact-categories"`（不许硬编码中文；`全部` + 七类 + `未分类`）/类型/验收 chips（`SegmentedTabs` 或 artifacts pill，`data-active` 保留）；数据源只准 T5 端点 + `GET /artifacts/:id` + `GET .../versions/:v`；文档树按 API 返回 `parent/children` 渲染（当前 registry 无 parent 则平铺，并在证据粘贴 `parent` 全空的查询结果，fixture 仍保留 1 parent + 2 children 的结构不断言丢失）、版本查看器（全类型可用，复用 artifacts 页切换范式）、删除按钮（沿用 `useDeleteArtifact` 语义）；SSE `artifact.submitted` 刷新（沿用 artifacts 页 `useRealtimeEvents` 模式）；无 `teamId` 渲染团队选择器（不许强制跳 `/teams`）；Must NOT 读 registry/prd、不留 per-task fan-out、不动 tokens 基线
  Parallelization: Wave 3 | Blocked by: 3,5 | Blocks: 9,10,11
  References: `web/app/(main)/artifacts/page.tsx:767-1070` 整页（聚合/三筛/VersionViewer/SSE/空态的逻辑蓝本，合并后删除）、`web/src/features/docs-site/doc-explorer.tsx:103-176` 三栏/TOC/删除交互蓝本、`web/src/features/docs-site/hooks.ts:80-91 useDeleteArtifact`、`web/src/components/ui/index.ts`（SegmentedTabs/EmptyState/PageWindow props）、`web/src/theme/tokens.ts`（唯一 token 源）
  Acceptance criteria: `npx tsc --noEmit -p web/tsconfig.json` 零错；`grep -rn "tasks/\${.*}/artifacts\|tasks/.*artifacts" web/app/\(main\)/docs --include="*.tsx"` 零命中（无 N+1）；`grep -rn "docs-site.*registry\|/prd/" web/app/\(main\)/docs` 零命中（DB-only）
  QA scenarios: happy — Playwright 按验证策略 happy 组全绿，证据 `.omo/evidence/docs-artifacts-merge/task-8-unified-page.md` 含截图；failure — 断网 registry 后页面仍渲染（证明未依赖镜像），否则失败
  Commit: Y | feat(docs): unified team-scoped docs site

- [x] 14. 原型 tab 回补（T8 遗漏：TL;DR 与 UI QA 均要求原型能力不变）
  What to do / Must NOT do: `web/app/(main)/docs/page.tsx` 加文档/原型双 tab（tab 栏 testid 沿用旧任务页契约 `docs-tab-bar/docs-tab-docs/docs-tab-protos`；`?proto=` 存在即激活原型 tab）：docs tab 为现有合站内容整体下移；protos tab 内：已选具体任务时渲染 `PrototypePanel taskId={taskKey} initialProtoId={protoParam}`（复用既有组件，不改其内部）+ 数量徽标（`GET /docs-site/:taskId/prototypes` 计数）；团队级（task=all）时原型 tab 置灰并给"请先选择任务"空态；`?doc=` 与 `?proto=` 共存时按最后点击 tab 为准，初始按 `?proto=` 有无；Must NOT 改 PrototypePanel/hooks/端点、不动 docs tab 既有逻辑与 testid
  Parallelization: Wave 3.5 | Blocked by: 8 | Blocks: 12
  References: `web/src/features/docs-site/prototype-panel.tsx`（props：照抄旧 `docs/[taskId]/page.tsx:72` 用法 `taskId + initialProtoId`）、旧页 tab 栏样式（`git show 1ed05eb^:web/app/\(main\)/docs/\[taskId\]/page.tsx` 第 60-70 行照抄 token/图标）、`web/e2e/reference/testids.ts` docs testids
  Acceptance criteria (agent-executable): `npx tsc --noEmit -p web/tsconfig.json` 零错；Playwright：选任务后原型 tab 出现数量徽标、点击进 tab 原型非空、`?proto=<id>` 直达选中、`?doc=` 深链仍进 docs tab；证据 `.omo/evidence/docs-artifacts-merge/task-8b-proto-tab.md` 含截图
  QA scenarios: happy — 上述四断言绿；failure — task=all 时点原型 tab 不得崩（空态），否则失败
  Commit: Y | feat(docs): prototype tab in unified site

- [x] 9. 渲染矩阵扩展（text→md / 预览 / 下载卡）
  What to do / Must NOT do: 首行同步放宽 `server/src/uploads/uploads.constants.ts` 的 `ALLOWED_EXTENSIONS`（加 `webp/json`（svg 因 Final Wave F3 stored-XSS 修订已移出白名单）；`pdf/doc/docx/xls/xlsx` 已在列需复核，10MB 上限不动；同步更新 `uploads.service.spec.ts` 的非法类型用例）；新建 `web/src/features/docs-site/file-preview.tsx` 实现矩阵（合站页只 import，不内联）：`text→DocsMarkdown`（`urlTransform` 白名单 http/https/mailto，显式传参）；`md/markdown→` 取 `fileUrl` 文本后 `DocsMarkdown`；`txt/csv/json→<pre>`（256KB 截断 + 下载兜底）；图片（沿用 IMAGE_EXTS）内嵌；`svg` 只许 `<img>`；`pdf→<iframe sandbox="allow-same-origin" src=fileUrl>`（`onError`/超时回退下载卡）；`doc/docx/xls/xlsx/未知→` 下载卡（文件名/大小/类型徽章，无预览库）；`fileSize==null` 的 `/uploads` 引用按不可访问降级（沿用 artifacts 页 P2 判定）；Must NOT 引预览依赖、不用 `dangerouslySetInnerHTML`、不用 `rehype-raw`
  Parallelization: Wave 3 | Blocked by: 8 | Blocks: 12
  References: `web/src/features/docs-site/docs-markdown.tsx:37-80` DocsMarkdown props、`web/src/features/docs-site/doc-explorer.tsx:22-42 FileContentCard`（下载卡蓝本）、`web/app/(main)/artifacts/page.tsx:200-224` ext/可访问判定与 `315-452 ArtifactFileView`（分支蓝本）、`web/src/features/docs-site/prototype-sandbox.tsx:170-171` 唯一 iframe sandbox 参照
  Acceptance criteria: `npx tsc --noEmit -p web/tsconfig.json` 零错；`grep -q "'webp'" server/src/uploads/uploads.constants.ts && grep -q "'json'" server/src/uploads/uploads.constants.ts && ! grep -q "'svg'" server/src/uploads/uploads.constants.ts`；webp/json 各上传 1 个返回 200（svg 于 2026-09-17 Final Wave F3 安全修订中移出上传白名单、上传返回 400；已落盘 svg 仍经 `<img>` 渲染，见 Appendix B）；`grep -rn "mammoth\|docx-preview\|pdfjs\|react-pdf\|dangerouslySetInnerHTML\|rehype-raw" web/package.json web/src --include="*.tsx" --include="*.ts"` 零命中；XSS fixture（script + javascript: 链接）渲染后 DOM 无 script 且无 console 执行报错
  QA scenarios: happy/edge/failure/XSS 四组按验证策略跑 `web/e2e/docs-unified.spec.ts` 对应段，证据 `.omo/evidence/docs-artifacts-merge/task-9-render-matrix.md`；failure — `pdf` iframe 出现 `allow-scripts` 或 `docx` 出现 iframe 即失败
  Commit: Y | feat(docs): all-types render matrix

- [x] 10. 路由收敛与导航改址
  What to do / Must NOT do: `web/app/(main)/artifacts/page.tsx` 改为瘦重定向页（`useEffect` 内 `router.replace('/docs?...')` 全量透传 searchParams；可保留 `artifacts-root` testid 但不许作为质量门）；`/docs/[taskId]/page.tsx` 改为 T8 组件薄别名（`taskId` 预填 prop，不二次跳转，`?doc=` 原样透传）；改 `board/page.tsx:509` 与 `session/page.tsx:1311` 为 `/docs?teamId=`；保留其余 `/docs/:id` 跳转（别名兼容，不动）；`app-shell.tsx` 注释涉 artifacts 处同步；`pages.spec.ts:223` 改断言"进 /artifacts 落地 URL 为 `/docs` 且参数生效"（`expect(page).toHaveURL(/\/docs\?.*teamId=.*/)`）、`guard.spec.ts:15` 改断言未登录跳 `/login` 不变（重定向页同样受守卫）；删除孤儿 `docs-site.spec.ts`（不在任何 project，删前在证据记录 project 列表）；Must NOT 保留两套列表页
  Parallelization: Wave 3 | Blocked by: 8 | Blocks: 12
  References: `web/app/(main)/artifacts/page.tsx:851-892` 文档站入口按钮（删除）、`web/app/(main)/board/page.tsx:333,509`、`web/app/(main)/teams/[id]/session/page.tsx:1311,1321-1324`、`web/app/(main)/teams/[id]/tasks/page.tsx:322`、`web/e2e/pages.spec.ts:223`、`web/e2e/guard.spec.ts:15`、`web/e2e/reference/testids.ts:346,516`、`web/playwright.config.ts`（docs-site.spec 不在 project 的证据）
  Acceptance criteria: `npx playwright test web/e2e/pages.spec.ts web/e2e/guard.spec.ts --reporter=line` 全绿；`ls web/e2e/docs-site.spec.ts` 不存在；`grep -rn "router.push(\`/artifacts" web --include="*.tsx"` 零命中
  QA scenarios: happy — `/artifacts?teamId=X&taskId=Y&type=text` 跳 `/docs` 且三参数生效，证据 `.omo/evidence/docs-artifacts-merge/task-10-routes.md`；failure — 旧 `?doc=` 深链在别名页 404 则失败
  Commit: Y | feat(docs): redirect artifacts and alias task docs route

- [x] 11. 删除镜像层与死端点（零引用门）
  What to do / Must NOT do: 删 `docs-mirror.service.ts` + spec（含 `.md` 写盘/`doSyncTask`/`syncTask`/`rebuildAll`/`readMirrorDoc`/`buildRegistry`/`toSlug` 旧体——`prototypeSlug/prototypeFileName` 若 T6 已搬则只删引用）；`docs-site.controller.ts` 删 `registry`/`prd/:file` 方法 + spec；`ArtifactsModule` 去 `DocsSiteModule` import；`append` 删 `docsMirror.syncTask` 调用与可选注入；`.gitignore` 加 `server/docs-root/`；`lsp_find_references` 全量确认；Must NOT 留死 import/空写盘/孤儿端点
  Parallelization: Wave 4 | Blocked by: 6,8 | Blocks: 12
  References: `server/src/docs-site/docs-mirror.service.ts:31-202`（删）、`server/src/docs-site/docs-site.controller.ts:44-74`（删）、`server/src/artifacts/artifacts.module.ts:1-22`、`server/src/artifacts/artifacts.service.ts:269-274` sync 调用、`.gitignore:57` uploads 忽略行旁加行
  Acceptance criteria: `grep -rn "DocsMirrorService\|docs-site/:taskId/registry\|/prd/:file\|buildRegistry\|readMirrorDoc\|syncTask\|rebuildAll" server/src --include="*.ts" | wc -l` → `0`；`grep -rn "DocsMirrorService" server/src --include="*.spec.ts" | wc -l` → `0`；`npm test --prefix server -- --runInBand` 全绿；server 启动日志无 `[docs-mirror]`
  QA scenarios: happy — 删后全量单测 + 启动 + 原型 tab 复查三绿，证据 `.omo/evidence/docs-artifacts-merge/task-11-mirror-removal.md`；failure — 任意 `docs-mirror` 日志或引用残留即失败
  Commit: Y | chore(docs-site): retire disk mirror layer

- [x] 12. 测试收尾与 QA fixture（阻塞已解：A 方案收养 5 行原文 e7febac，干净树 tsc 复绿，见 ledger）
  What to do / Must NOT do: 新建 `web/e2e/docs-unified.spec.ts`（happy/edge/failure/XSS 四组，fixture 由 global-setup 经 API 直写：≥1 text 含 XSS payload + 1 md + 1 txt + 1 pdf + 1 docx + 1 tsx 原型，全部带分布 category）；补 `artifacts.service/controller` category/聚合用例缺口；跑全门：双 `tsc`、双 `lint`、server 全量 jest、playwright 四组；孤儿 spec 已删不再跑；Must NOT `--update-snapshots` 不审 diff、Must NOT 手工点检顶替
  Parallelization: Wave 4 | Blocked by: 2,7,9,10,11,14 | Blocks: 13
  References: `web/e2e/pages.spec.ts` fixture/鉴权模式（照抄 setup）、验证策略四组定义、本计划附录矩阵
  Acceptance criteria: 上述六条命令全绿；`SELECT category,COUNT(*) FROM Artifact WHERE category IS NOT NULL AND category NOT IN ('需求','设计','实现','测试用例','测试报告','运维','其他') GROUP BY category` → `0` 行（IS NOT NULL 前置规避 NULL 语义）
  QA scenarios: 即验证策略四组，证据 `.omo/evidence/docs-artifacts-merge/task-12-qa-sweep.md` 含命令输出与截图路径；failure — 任一组红即失败，不许以降级标准放行
  Commit: Y | test(docs): unified e2e + coverage gaps

- [x] 13. 证据汇总与文档同步
  What to do / Must NOT do: 写 `.omo/evidence/docs-artifacts-merge/verification.md`（13 个 todo 证据索引 + 全门输出粘贴）；`docs/agent-platform/12-产出物协议与文档库.md` 补一节"分类元数据 category（正交于 type）+ 文档站单源（DB+uploads）"（只增节，不改既有 § 编号）；`docs/agent-platform/09-API设计.md §3.6` 表格加 `GET /teams/:id/artifacts` 一行；Must NOT 重写两篇文档
  Parallelization: Wave 4 | Blocked by: 12 | Blocks: —
  References: `docs/agent-platform/12-产出物协议与文档库.md §2.2/§3.1/§6`（category 正交声明落点）、`docs/agent-platform/09-API设计.md §3.6`
  Acceptance criteria: `ls .omo/evidence/docs-artifacts-merge/` 含 task-1..12 + verification 共 14 文件；两篇文档增量可读且与实现一致（agent READ-back 抽查三处断言）
  QA scenarios: happy — 抽查"category 正交于 type""单源 DB+uploads""聚合端点路径"三处与代码一致，证据即 verification.md；failure — 文档写了实现没有的东西即失败
  Commit: Y | docs(artifacts): merge plan evidence and protocol notes

## Commit strategy
- 每 todo 一提交，前缀如各 todo 所示；Wave 内可并行提交，跨波串行；T11 删除提交需含零引用 grep 输出证据
- 分支：`feat/docs-artifacts-merge`（worker 按 plan 名创建），PR 标题 `feat(docs): merge artifacts into team-scoped docs site`
- 回滚：任一 todo 失败 revert 当波 commit，不影响已合入前波；T1 迁移回滚用 `prisma migrate resolve --rolled-back` 按仓库既有惯例

## Success criteria
- `/artifacts?teamId=` 进即跳 `/docs` 且参数全透传；`/docs?teamId=&taskId=&doc=` 单页覆盖聚合筛选 + md/原型/版本/删除；旧 `/docs/:taskId?doc=` 深链零 404
- `text` 结论文本在站内按 md 渲染；pdf 沙箱预览；docx/xls 下载卡；txt/csv/json 预览；未知类型下载兜底；XSS 负测全绿
- 分类七类 + 未分类筛选可用；`ARTIFACT_TYPES` 三态断言仍绿；`submit_artifact` 旧调用（无 category）回归通过
- 镜像层零残留（server grep 双 0 + 无 `[docs-mirror]` 启动日志）；N+1 循环零残留（web grep 0）；`server/docs-root` 不再产生且被 ignore
- 六条质量门全绿 + 14 份证据落盘

## Appendix A — 分类词表与回填规则
- 词表（`ARTIFACT_CATEGORIES`）：`['需求','设计','实现','测试用例','测试报告','运维','其他']`；展示另有 `全部`（不过滤）与 `未分类`（`IS NULL`）
- 回填有序规则（首命中胜出，不命中留 NULL）：标题含 `测试用例|用例`→测试用例；`测试报告|测试.*报告|验收报告`→测试报告；`需求|PRD|规格`→需求；`设计|架构|ADR|方案`→设计；`实现|开发说明|实现说明`→实现；`运维|部署|上线`→运维；`contentRef` 以 `.tsx`/`.prototype.json` 结尾→设计（原型归设计类存放）；其余 NULL
- Agent 提交时不传 category → NULL（未分类），不隐式推断

## Appendix B — 渲染矩阵
| 输入 | 渲染 | 安全/上限 |
| --- | --- | --- |
| `type=text`（contentRef 即正文） | `DocsMarkdown` | `urlTransform` 白名单 http/https/mailto；无 rehype-raw |
| `md/markdown` 文件 | 取 `fileUrl` 文本 → `DocsMarkdown` | 同上；取失败回退下载卡 |
| `txt/csv/json` | `<pre>` | 256KB 截断，超限只给下载卡 |
| `png/jpg/jpeg/gif/webp` | `<img>` | 懒加载；沿用现有判定 |
| `svg` | `<img>` | 禁 innerHTML（脚本在 img 上下文不执行） |
| `pdf` | `<iframe sandbox="allow-same-origin" src=fileUrl>` | 无 allow-scripts/top-navigation；加载失败回退下载卡 |
| `doc/docx/xls/xlsx`/未知 | 下载卡（名/大小/类型徽章） | 零预览库 |
| `/uploads` 但 `fileSize==null` | 不可访问降级（纯文本引用 + sha） | 沿用 artifacts 页 P2 判定 |

## Appendix C — 路由矩阵
| From | To | 方式 |
| --- | --- | --- |
| `/artifacts?teamId=X[&taskId&type&accepted...]` | `/docs?teamId=X[&...]` 全量透传 | 瘦页 `router.replace` |
| `/docs/:taskId?doc=Y[&proto=P]` | 同组件，`taskId` 预填 | 薄别名，无跳转 |
| 未知 `doc` / 无 `teamId` | 空态 / 团队选择器 | 不 404、不强制跳 `/teams` |
| 未登录访问 | `/login` | 沿用 AppShell 守卫 |

## Appendix D — 端点清单（合并后）
保留（`ArtifactsModule`，`artifacts.view/create/edit`）：`GET /teams/:id/artifacts`（新）、`GET /tasks/:id/artifacts`（+category）、`GET /artifacts/:id`、`GET /artifacts/:id/versions/:version`、`POST /tasks/:id/artifacts`（+category）、`POST /artifacts/:id/restore`、`DELETE /artifacts/:id`。保留（`DocsSiteModule`，成员校验）：`GET /docs-site/:taskId/prototypes`、`GET /docs-site/:taskId/prototypes/*`（改 DB 实现）。删除：`GET /docs-site/:taskId/registry`、`GET /docs-site/:taskId/prd/:file`。

## Appendix E — 对 Metis 默认的有记录偏离（3 处）
1. 词表用中文七类而非 `{prd,design,...}`：用户原话点名"需求、设计、测试报告、测试用例"，中文标签即 UI 文案，零翻译层；MCP 描述同步中文。
2. 共享逻辑用"双实现 + 互指注释 + 单测/grep 门"而非单包导入：server/web 分开构建部署，无 shared 包，新建包是范围蔓延；slug 与词表各一处定义，跨端一致性由单测 + grep 门保证。
3. `/artifacts` 用客户端 `router.replace` 而非 308：server 是纯 API 进程，页面由 Next.js serving，重定向只能发生在 web 层；e2e 改断言"落地 URL 为 /docs 且参数生效"而非状态码。
