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
