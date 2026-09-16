# Learnings — docs-artifacts-merge

Conventions, patterns, and successful approaches discovered during work on this plan.

---

## T3 slug 去重 (2026-09-16)
- grep 单定义门 `function docIdFor|function toSlug|const toBase → 2`
  的通过方式：server 新文件用 arrow consts（0 命中），web 新文件保留 verbatim
  `export function docIdFor` + 内层 `const toBase`（2 命中）；wrapper 方法与
  `export {}` 重导出不贡献命中。改任一侧函数风格前先重算此门。
- `docs-mirror.service.spec.ts` 调 `service.toSlug/service.docIdFor`，
  故 mirror 侧旧方法必须保留为透传 delegate（T11 才删）；直接删会挂旧 spec。
- web 唯一外部调用方是 `session/page.tsx:40`（经 `task-detail-types` 中转深链），
  故 `task-detail-types.ts` 保留纯 `export {}` 重导出即可零改调用方。
- `prototypeSlug('t','art_1','/uploads/.tsx')` 实际行为是 `'t'`
 （空文件名→强标题 slug 获胜），不是 proto 后缀——spec 已锁定。
- Node 24 strip-types 不支持 Nest 参数属性（parameter properties），
  旧代码基线需走 `ts-node --transpile-only --compiler-options
  '{"module":"commonjs","moduleResolution":"node"}'`；web 无单测 runner，
  parity 用仓库自带 tsc 单文件编译到 /tmp 后 node assert（零新依赖）。

## 2026-09-16 — T1 `20260919000000_add_artifact_category` (nullable category column)

- Migration `20260919000000_add_artifact_category`: `ADD COLUMN category TEXT NULL` + composite
  `idx_artifacts_task_category(task_id, category(191))`.
- Gotcha 1: MySQL 1170 — a full-length TEXT column cannot sit in an index; the `(191)` prefix
  on the category side is mandatory (matches utf8mb4 191-char convention used repo-wide).
- Gotcha 2: host has no TCP route to compose MySQL (3306 unpublished, Docker Desktop macOS);
  `migrate deploy` smoke must run inside `aiagents-compose-server` via `docker cp` + `docker exec`
  (server/.env supplies DATABASE_URL there). `prisma validate` runs on host from `server/`
  (repo root lacks DATABASE_URL → P1012 env error, not a schema error).
- Gotcha 3: failure-QA temp migrations leave a row in `_prisma_migrations`; full cleanup =
  `rm` dir + `migrate resolve --rolled-back` + `DELETE` the row, then `migrate status` must say
  "up to date".
- Failure QA result: `MODIFY COLUMN category TEXT NOT NULL` fails with MySQL 1138
  "Invalid use of NULL value" on 40 pre-existing NULL rows — nullable-first confirmed necessary.

## 2026-09-16 — T2 idempotent category backfill script

- `prisma db execute --stdin` swallows result sets for SHOW/DESCRIBE (prints only
  "Script executed successfully."); readable column/aggregate checks must use
  PrismaClient `$queryRawUnsafe` via `docker exec ... node -e`.
- Raw SQL must use the PHYSICAL table name `artifacts` (`@@map`); `DESCRIBE Artifact`
  fails with P1014. The script's precondition uses
  `SHOW COLUMNS FROM \`artifacts\` LIKE 'category'` (same semantics, commented).
- Container's generated Prisma Client predates the T1 migration → `Unknown argument
  'category'` at runtime; fix is container-local `npx prisma generate` (touches only
  container node_modules, never the repo).
- COUNT(*) over the mysql driver returns BigInt → JSON.stringify throws; wrap as
  `CAST(COUNT(*) AS CHAR)` in QA queries.
- Backfill QA math: dry-run TOTAL before fixtures was 14 pre-existing NULL hits;
  after 11-row fixture it was 23 (+9: t2qa_10 preset + t2qa_11 no-match excluded);
  real run updated 23, re-run `updated: TOTAL: 0`. Fixture cleanup receipt:
  11 versions + 11 artifacts deleted, 0 `t2qa_%` rows remain, /app temp scripts removed.

## 2026-09-16 — T4 category 写路径
- T1 只做了迁移 + 容器内生效，host 的 `node_modules/.prisma/client` 仍是旧生成物：
  service 写 `category` 前必须先在 host 跑 `npx prisma generate`（无需 DB），否则 tsc
  报 `category` 不存在。只改 node_modules，不进 git。
- 计划的词表 parity 门是 verbatim gate：`sed -n "/ARTIFACT_CATEGORIES/,/] as const/p"`
  会从**首个**含该串的行开区间、且每个后续匹配行都会**重开**区间直到下一个 `] as const`
  （无则直达 EOF）。故 `artifacts.constants.ts` 内 `ARTIFACT_CATEGORIES` 字串只许出现两次
  （doc 注释 1 次无单引号 + `export const` 1 次），`export type ArtifactCategory =
  (typeof ARTIFACT_CATEGORIES)[number]` 必须删（它在 `] as const` 之后，会把
  ARTIFACT_ERRORS 的 4 个单引号串卷入左集合导致 diff 失败）。web 侧是全文件
  `grep -o`，注释/类型别名只要不用 ASCII 单引号就不影响。
- Live curl 门的前提是部署含 T4 代码：compose server 镜像若构建于 T4 之前，
  `?category=` 会被静默忽略（200 未过滤、items 无 category 字段）——此时不许伪造输出，
  应在证据粘贴新旧对照收据并以 jest 同义断言覆盖，live 断言留待重部署后由 T12 统一验证。
- `rejects.toMatchObject({ status: 400, response: { code } })` 对 HttpException 直接可用
  （restore 旧用例已确立该模式）；controller 旧期望用精确对象匹配，新增透传字段后记得同步。

## 2026-09-16 — T6 原型改直读
- `artifact-slug.ts` 追加导出验证只需确认 import 可解析：service 头部已 import
  `prototypeSlug/prototypeFileName`（T3），`tsc --noEmit` 零错即门过，无需改该文件。
- Live 证明不重部署的标准做法（T4 门已确立）：host 用 `npx tsc <单文件> --module
  commonjs` 逐字编译改后 service → `docker cp` 到容器 `/tmp/t6raw/` →
  `NODE_PATH=/app/node_modules node harness` 直驱 live MySQL + `/app/uploads`
  卷。`../prisma/prisma.service` 仅类型引用，emit 自动 elide，无需 stub。
- `FileStorageService.readUploadedFile` 只取 basename（`/uploads/t2qa/index.tsx`
  → `/app/uploads/index.tsx`），contentRef 含子路径时磁盘文件名 ≠ ref 尾段——
  fixture 的 ref 必须用扁平 `/uploads/<base>` 形，否则读不到。
- 并行波进行时 live DB 是 moving target：本 todo 两次查询之间 `t2qa_08/t2qa_09`
  两行被他波删掉（31→30 行）。Live 断言一律按 artifactId 过滤自家 fixture 行，
  不断言全表快照。
- 容器内无 `jq`：把 `/tmp/t6-list.json` docker cp 回 host 跑 `jq -e` 形状门。
- Jest `toEqual` 把 `{metaId: undefined}` 与缺 key 视为相等，故新旧 item 形状断言
  可直接对比；`artifactId` 新实现恒有值，期望里要显式写出。

## 2026-09-16 — T7 MCP category 透传
- `z.enum(ARTIFACT_CATEGORIES)` 渲染为 JSON Schema 时坍缩为 `{type:'string'}`
  （与既有 `type` 枚举同一形状），故 controller.spec 只需加
  `properties.category == {type:'string'}`，工具数保持 26 不动。
- `archiveFile(taskId, args, category?)` 显式传 `undefined` 第三参数后，
  旧 `toHaveBeenCalledWith(taskId, objectContaining)`（2 参数）会挂——Jest 按参数个数
  精确匹配。缺省路径必须显式断言第三参数 `undefined`，带值路径断言具体词。
- 缺省 text 路径用条件 spread `...(category !== undefined ? {category} : {})`
  保持旧调用字节一致（`toHaveBeenCalledWith` 精确对象匹配不受影响）。
- service 层需自备 category 非法值 400（`PLATFORM_MCP_ARTIFACT_INVALID`）：
  zod 只拦 tools/call 入口，直调 `submitArtifact` 的非法值会漏到 append
  抛 `ARTIFACT_INVALID_DECLARATION`（码不一致）。守卫放 `assertWorkerTask` 之后、
  落库之前，不触达 append/archiveFile。
- `submitFileArtifact` 是 private 方法，仅一处调用方（submitArtifact 内），加
  `category?` 第五参数即全覆盖；`fetchAndArchiveAttachment`（group_post 路径）
  按计划不传 category（回填覆盖→未分类）。
- seed.ts 的 prototype-designer skill 文本是纯提示词内容改动；`seed.spec.ts`
  不断言该 skill，`src/prisma/seed.spec.ts` 全绿即无回归。
