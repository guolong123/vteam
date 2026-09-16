# T2 证据 — 回填脚本（幂等 + dry-run）

- Plan: `.omo/plans/docs-artifacts-merge.md` todo 2 / Appendix A（有序规则原文见该附录）
- Script: `server/scripts/backfill-artifact-category.ts`（new，lone script，未入任何 module/package.json/CI）
- Branch: `feat/docs-artifacts-merge`（未切换、未 push）
- DB 访问一律进容器（宿主机无到 compose MySQL 的 TCP 路由，沿 T1 模式）

## 1. 前置断言：列存在（T1 迁移已落库）

```sh
$ docker exec aiagents-compose-server node -e "...SHOW COLUMNS FROM \`artifacts\`..."
id,task_id,type,title,current_version,created_at,updated_at,category
```

`category` 在列 → 通过。注：物理表名是 `artifacts`（`@@map`），裸 `DESCRIBE Artifact`
在 `prisma db execute` 下报 P1014（`Unknown table ... Artifact` 被映射），脚本内前置断言
用的是 `SHOW COLUMNS FROM \`artifacts\` LIKE 'category'`（语义等价，见脚本注释）。
`prisma db execute` 对 SHOW/DESCRIBE 只回 `Script executed successfully.` 不打印结果集，
故可读性查询一律用 PrismaClient `$queryRawUnsafe`。

## 2. 脚本 dry-run（基线脏数据，退出 0，无写入）

```sh
$ docker cp server/scripts/backfill-artifact-category.ts aiagents-compose-server:/app/t2_backfill.ts
$ docker exec aiagents-compose-server npx ts-node --transpile-only \
    --compiler-options '{"module":"commonjs","moduleResolution":"node"}' /app/t2_backfill.ts --dry-run
will update: 设计: 2
will update: 实现: 3
will update: 测试用例: 1
will update: 测试报告: 8
will update: TOTAL: 14
EXIT:0
```

（首次执行前曾报 `Unknown argument 'category'`：容器内 generated client 是 T1 之前生成的；
容器内跑 `npx prisma generate --schema prisma/schema.prisma` 刷新后通过。只影响容器
node_modules，不污染仓库。）

## 3. QA fixture（11 行，容器内脚本直写，跑后已删）

fixture 构造（`/tmp/t2qa-fixture.ts` → `docker cp` 到容器执行，源码未入库）：

| id | title | type | 预设 category | contentRef | 期望 |
| --- | --- | --- | --- | --- | --- |
| t2qa_01 | 用户登录需求规格说明书PRD | doc | NULL | 正文 | 需求 |
| t2qa_02 | 系统架构设计方案评审稿 | doc | NULL | 正文 | 设计 |
| t2qa_03 | 支付模块开发说明文档 | doc | NULL | 正文 | 实现 |
| t2qa_04 | 登录功能测试用例清单 | doc | NULL | 正文 | 测试用例 |
| t2qa_05 | v2.1测试报告终版 | doc | NULL | 正文 | 测试报告 |
| t2qa_06 | 一期项目验收报告 | doc | NULL | 验收正文 | 测试报告 |
| t2qa_07 | 生产环境部署上线手册 | doc | NULL | 正文 | 运维 |
| t2qa_08 | 中性标题原型页无关键词 | file | NULL | /uploads/t2qa/index.tsx | 设计 |
| t2qa_09 | 中性标题原型配置无关键词 | file | NULL | /uploads/t2qa/app.prototype.json | 设计 |
| t2qa_10 | 需求变更评审纪要初稿 | doc | **运维** | 正文 | 运维（不覆盖） |
| t2qa_11 | 随机杂记xyz123无规则命中 | doc | NULL | 正文 | NULL（留空） |

```sh
$ docker cp /tmp/t2qa-fixture.ts aiagents-compose-server:/app/t2qa-fixture.ts
$ docker exec aiagents-compose-server npx ts-node --transpile-only \
    --compiler-options '{"module":"commonjs","moduleResolution":"node"}' /app/t2qa-fixture.ts
fixture upserted: 11
EXIT:0
```

## 4. dry-run（含 fixture，退出 0）

```sh
will update: 设计: 5
will update: 实现: 4
will update: 测试用例: 2
will update: 测试报告: 10
will update: 需求: 1
will update: 运维: 1
will update: TOTAL: 23
DRY_EXIT:0
```

增量 = 基线 14 + fixture 9（设计+3、实现+1、测试用例+1、测试报告+2、需求+1、运维+1），
t2qa_10（已有值）与 t2qa_11（无命中）未计入 → dry-run 零写入断言通过。

## 5. 实跑 → 复跑（幂等）

```sh
$ ... /app/t2_backfill.ts
updated: 设计: 5
updated: 实现: 4
updated: 测试用例: 2
updated: 测试报告: 10
updated: 需求: 1
updated: 运维: 1
updated: TOTAL: 23
REAL_EXIT:0
$ ... /app/t2_backfill.ts
updated: TOTAL: 0
RERUN_EXIT:0
```

二次运行 0 变更 → 幂等通过。

## 6. 映射正确性 + 不覆盖守卫 + 列 untouched

```sh
t2qa_01 | 用户登录需求规格说明书PRD | doc | 需求 | 需求规格说明书 v1
t2qa_02 | 系统架构设计方案评审稿 | doc | 设计 | 架构设计稿 v2
t2qa_03 | 支付模块开发说明文档 | doc | 实现 | 开发说明正文
t2qa_04 | 登录功能测试用例清单 | doc | 测试用例 | 用例清单正文
t2qa_05 | v2.1测试报告终版 | doc | 测试报告 | 测试报告正文
t2qa_06 | 一期项目验收报告 | doc | 测试报告 | 验收报告正文
t2qa_07 | 生产环境部署上线手册 | doc | 运维 | 上线手册正文
t2qa_08 | 中性标题原型页无关键词 | file | 设计 | /uploads/t2qa/index.tsx
t2qa_09 | 中性标题原型配置无关键词 | file | 设计 | /uploads/t2qa/app.prototype.json
t2qa_10 | 需求变更评审纪要初稿 | doc | 运维 | 已有人值，标题虽命中需求也不许覆盖
t2qa_11 | 随机杂记xyz123无规则命中 | doc | null | 杂项正文
```

- 9 行映射全对（含 `.tsx` / `.prototype.json` → 设计、验收报告 → 测试报告）。
- t2qa_10：标题命中"需求"但预设 `运维` 未被覆盖 → 不覆盖守卫通过。
- t2qa_11：保持 NULL（未写 `其他`）→ 通过。
- `type` / `contentRef` 两列原样 → 未碰非 category 列通过。

## 7. 词表门（GROUP BY）

```sh
$ SELECT `category`, CAST(COUNT(*) AS CHAR) ... GROUP BY `category`
[{"category":"设计","n":"5"},{"category":"实现","n":"4"},{"category":null,"n":"27"},
 {"category":"测试用例","n":"2"},{"category":"测试报告","n":"10"},
 {"category":"需求","n":"1"},{"category":"运维","n":"2"}]
$ ... WHERE `category` IS NOT NULL AND `category` NOT IN ('需求','设计','实现','测试用例','测试报告','运维','其他')
non-vocab: [{"n":"0"}]
```

只有词表内值或 NULL，无 `其他`（COUNT(*) 需 CAST，容器 node 下 BigInt 无法 JSON 序列化）。

## 8. 清理收据

```sh
versions removed: 11 artifacts removed: 11
remaining t2qa_ rows: 0
$ docker exec aiagents-compose-server sh -c 'rm -f /app/t2_backfill.ts /app/t2qa-fixture.ts && ls /app/t2*'
ls: /app/t2*: No such file or directory
```

fixture 11+11 行全删，容器临时脚本已清。注：实跑同时回填了 14 行基线 NULL 行
（按附录规则的合法回填，正是本脚本的用途；二次运行 0 变更已证幂等）。

## 9. 回归门

```sh
$ npx tsc --noEmit --strict --skipLibCheck --module commonjs --target es2022 \
    --moduleResolution node scripts/backfill-artifact-category.ts   # server/ 下
TSC_EXIT:0
$ npm test --prefix server -- --runInBand src/artifacts
PASS src/artifacts/artifacts.service.spec.ts
PASS src/artifacts/artifacts.controller.spec.ts
PASS src/artifacts/artifact-slug.spec.ts
Test Suites: 3 passed, 3 total / Tests: 66 passed, 66 total
```

宿主机 `npx ts-node ... --dry-run` 未直接跑：宿主机无到 compose MySQL 的路由
（T1 已证），等价的 `--dry-run EXIT:0` 在容器内用同一文件+同一命令完成。
