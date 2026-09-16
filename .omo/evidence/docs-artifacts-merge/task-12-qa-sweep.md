# T12 测试收尾与 QA sweep — 证据（task-12-qa-sweep）

- Plan: `.omo/plans/docs-artifacts-merge.md` todo 12 · Branch: `feat/docs-artifacts-merge`
- Date: 2026-09-16/17 UTC · Executor: T12 · HEAD 起点 `9ded27c`
- 永久产物：`web/e2e/docs-unified.spec.ts`（17 tests/5 groups）+ `docs` project
 （`web/playwright.config.ts`）+ `web/e2e/fixtures/t12qa-demo.tsx`（tsx 字节源）+
  `artifacts.service.spec.ts` +1（findByTeam 零产出物）。

## 1. 服务器镜像重建（hand-patched dist → 正式镜像）

- 现状评估：运行容器 `/app/dist` 为 T8/T11 worktree-overlay 手工补丁（含
  `prototypes.service.js`、category 13 处、`findByTeam`、webp allowlist、
  docs-mirror 零命中），与 HEAD server 代码一致
  （`git diff ffb36fd..HEAD --stat -- server/` → 空；T14 纯 web）。
- 回滚点：`docker tag aiagents-server:latest aiagents-server:pre-t12`
 （`be3b2d7a12f5`，保留）。
- `docker compose build server`（干净 worktree `/tmp/t12clean` = HEAD）**失败**，
  唯一原因 `npm run build`（nest build）报 2 errors，均为
  `platform-mcp.service.ts:1670/1942` 他波合并漂移（T8/T11 已记录）：
  所需符号在另一波未提交 hunk 内（`task.constants.ts` +4 行等）。
  证据：clean-HEAD 构建 `Found 2 error(s)`；脏树 host
  `npx tsc --noEmit -p tsconfig.build.json` → EXIT 0（符号被他波文件补齐）。
  结论：pristine-HEAD `nest build` 红是 pre-existing 跨波漂移，不顺手修（会吸收他人工作）。
- 正式镜像做法（与 T8/T11 同源、落到镜像层）：运行容器 dist == HEAD 构建产物
  已验证 → `docker commit aiagents-compose-server aiagents-server:t12-fresh`
  （`785a94fe266d`）→ `docker tag ...:latest` →
  `docker compose up -d server` 重建（uploads_data 卷保留，infra 不中断）。
  结果：`Up (healthy)`；新 boot 日志 `grep -c docs-mirror` → **0**，
  `Nest application successfully started`。
- 重建后复验（fresh image，seed-admin token）：
  `GET /docs-site/t_0000000001/registry` → **404**；
  `.../prd/whatever.md` → **404**；
  `GET /teams/tm_0000000001/artifacts?pageSize=2` → **200**（total=13，全员含 taskName）；
  `GET /docs-site/t_0000000001/prototypes` → **200**（当时空库 `{"items":[]}`，
  后由本 todo fixture 填入 t12qa-demo，见 §3）。
- 回滚：`docker tag aiagents-server:pre-t12 aiagents-server:latest &&
  docker compose up -d --force-recreate server`（未启用；记录备用）。

## 2. 六门（exact commands + results）

1. `npx tsc --noEmit -p tsconfig.json`（web/）→ EXIT **0**。
2. `npx tsc --noEmit -p tsconfig.json`（server/）→ EXIT **0**。
3. `npm run lint --prefix web` → **1 error + 731 warnings**；唯一 error 在
  `web/shot-omo3.tmp.cjs`（`git check-ignore` → **IGNORED**，他波 gitignored 临时文件，
  未动）；本 todo 文件（spec/config/fixture）`npx eslint` → EXIT **0**。
4. `npm run lint --prefix server` → **0 errors**，56 warnings（pre-existing 未用变量类）。
5. `npm test --prefix server -- --runInBand`（全量）→ **117 suites / 2651 tests 全绿**
  （2650 基线 + 本 todo 新增 1；1 snapshot pass）。
6. Playwright（host dev `:3001` + `API_PROXY_TARGET=http://localhost:13000`）：
   - `npx playwright test --project=docs` → **17 passed**（`docs-unified.spec.ts` 全组，
     含自播种 beforeAll + 全删 afterAll）。
   - `npx playwright test --project=pages --project=guard` → **24 passed, 2 failed**；
     2 失败见 §5（pre-existing，非回归）。

## 3. Deferred live gates（全部在本 todo 对 fresh 镜像诚实重验）

Fixture（`t_0000000001`，art_0000000043–0052，afterAll 已全删，见 §7）：
text-XSS（测试报告）/ md（需求）/ txt（设计）/ pdf（测试用例）/ docx（运维）/
text v1→v2 append（实现，复验不覆盖）/ text（其他）/ text NULL（删除用）/
ghost 缺失引用 / tsx 原型（设计，`docker cp` 卷内字节 + 行注册，
`GET prototypes` → `id=t12qa-demo/file=t12qa-demo/index.tsx`）。

- T4 `?category=` HTTP：`GET /tasks/t_0000000001/artifacts?category=<测试报告>`
  → total=1，allMatch，含 t12qa-xss-report；非法 category POST → **400** ✅
- T5 team-endpoint HTTP：`GET /teams/tm_0000000001/artifacts?category=<设计>`
  → total=3 全命中全含 taskName（含 t12qa-design-txt）；seed-admin 调
  `tm_0000000002` → **403 PERMISSION_TEAM_NOT_MEMBER**；未知团队 → **404 TEAM_NOT_FOUND**；
  `pageSize=1000` → **100** ✅
- T9 webp/svg/json upload-200s：`POST /api/v1/uploads` 七文件
  （md/txt/pdf/docx/webp/svg/json）→ 全部 **201**（含此前 400 的三项）；
  证明文件已删（见 §7）✅
- T6/T11：prototypes 非空 200（上）+ registry/prd 双 404（§1）✅
- SQL 门：`SELECT category,COUNT(*) ... NOT IN (七类) GROUP BY` → **0 rows**；
  分布 `设计:2/实现:3/NULL:26/测试用例:1/测试报告:8` ✅

## 4. 覆盖缺口（genuine only）

- 先跑 `src/artifacts` 3 suites/80 全绿 + 通读 findByTeam/category 分支：
  T4（11）+T5（10）已覆盖全部 category/聚合路径；唯一真缺口
  `findByTeam` 团队有任务但零产出物（service.ts:600-602，未查版本表）。
- 加 1 用例 `empty：团队有任务但零产出物 → 空分页（不查版本表）`；
  service.spec 55/55 绿；全量 2651 绿。零 padding。

## 5. T10 三失败逐项处置

T10 记录：4b/17 board-drawer、`team-session zero-task`、12/17 skills `search-input`。

1. **4b/17 board-drawer** → 本轮 **PASS**（seed 出现 task-card；
   moving-target 自愈，非回归，无需修）。
2. **`team-session zero-task`**（`team-right-empty` 不存在）→ **pre-existing 漂移**：
   该 testid 在 `web/app + web/src` **零命中**（仅 spec + reference/testids 有），
   且 `git grep -c @ HEAD` 同样零命中；本 todo web diff
   （docs/alias/redirect/chips/file-preview，`git diff --name-only` 无 session/skill 交集）
   不可能产生。不修（修 spec 或补 testid 均属他人域）。
3. **12/17 skills `search-input`** → 同上 **pre-existing**：testid 全仓仅 spec 侧存在，
   HEAD 同样缺失；页面本身渲染正常（`skills-tools-manage-root/manage-tabs` 先行断言已过，
   死在第 3 个断言）。不修，留他人波。

## 6. 截图（gitignored，本地路径）

- `.omo/evidence/docs-artifacts-merge/img/t12-protos-tab.png`（111KB，原型 tab 非空）
- `.omo/evidence/docs-artifacts-merge/img/t12-pdf.png`（62KB，pdf 沙箱分支）
- `.omo/evidence/docs-artifacts-merge/img/t12-xss.png`（121KB，XSS 探针字面展示）
- 手工点检顶替断言：无（截图 + 17 断言双轨）。

## 7. 清理收据（teardown）

- Fixture 行：10 行（art_0000000043–0052）经 spec afterAll + 手工复查
  `total: 13` 且 `t12qa` 零命中；`GET /artifacts/art_0000000050`（UI 删除的那行）→ 404。
- Uploads：本轮 7 个 201 证明文件 + spec 每次自播种的 UUID 文件，经
  “mtime 窗口 + DB contentRef/filePath 全表无引用” 双重核对后 `rm`（保留
  `/app/uploads/t12qa-demo.tsx` 200B 确定性种子供永久 spec 重跑，
  源在 `web/e2e/fixtures/t12qa-demo.tsx` 已入库，重播种命令见 spec 头）。
- 临时：`/tmp/t12*`、`t12_token.json`、`t12_uploads.log` 全删；
  `git worktree remove --force /tmp/t12clean`（`worktree list` 仅剩主检出）；
  `web/test-results/`、`web/.auth/`（gitignored，再生件）已清；
  host web dev `:3001` 已停（`lsof -i :3001` 空）。
- 未 push；`aiagents-server:pre-t12` 备份 tag 保留。

## 8. 风险/交接（给 T13）

- 永久 spec 依赖卷内 `t12qa-demo.tsx` 字节（`down -v` 后需重 `docker cp`，命令在 spec 头）。
- pristine-HEAD `nest build` 红（platform-mcp 他波漂移，§1）：任何
  `compose up --build` 会失败，与本计划无关，需他波合入后自愈；当前运行镜像已是 HEAD 等价。
- `web/shot-omo3.tmp.cjs`（gitignored）致 web lint 1 error：删之即绿，但属他波文件未动。
- 已知残留（out-of-scope，未动）：`doc-explorer.tsx`、`useDocsRegistry/useDocContent`、
  `resolveDocsRoot` 死代码（删之会断其 importers，tsc 红；T13 verification 记录即可）。
