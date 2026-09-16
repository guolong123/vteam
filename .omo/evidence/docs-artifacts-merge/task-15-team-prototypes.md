# T15 — 团队级原型列表 `GET /teams/:id/prototypes` 证据

## 1. 变更文件（本次提交内）
- `server/src/docs-site/prototypes.service.ts` — 新增导出类型 `PrototypeListItem` / `TeamPrototypeListItem`（后者 = 前者 + `taskId`/`taskName`）+ `listPrototypesByTeam(teamId)`；原 `listPrototypes` 循环体下沉为共用私有 `mapRowToItems`（当前版本过滤、`/uploads/` 前缀、`.tsx`/`.prototype.json` 后缀、slug helper、meta 正则、兜底/跳过语义逐字保留）；`readPrototype` 零改动。
- `server/src/docs-site/docs-site.controller.ts` — 新增裸挂载 `TeamPrototypesController`（`@Controller()` + `@Get('teams/:id/prototypes')`，T5 同形）+ 方法级 `assertTeamMember`（未知团队 404 `TEAM_NOT_FOUND`，非成员 403 `PERMISSION_TEAM_NOT_MEMBER`，仿 `artifacts.controller.ts:162-186`）；既有 `DocsSiteController` 两路由 + `assertMember` 零改动。
- `server/src/docs-site/docs-site.module.ts` — `controllers` 追加 `TeamPrototypesController`（+ 注释 3 行）。
- `server/src/docs-site/prototypes.service.spec.ts` — `mockProtoRows` 上提外层作用域（+ 可选 `taskId` 透传进 `artifact` mock）+ 新增 `listPrototypesByTeam` describe（5 用例）；既有 13 用例期望未动。
- `server/src/docs-site/docs-site.controller.spec.ts` — prisma mock 追加 `team.findUnique`、service mock 追加 `listPrototypesByTeam`、新增 `GET /teams/:id/prototypes` describe（5 用例）；既有 8 用例期望未动。
- 本证据文件。

## 2. 语义（冻结契约，供前端并发任务消费）
- 路由：`GET /api/v1/teams/:id/prototypes` → `{ items: Array<{ id, metaId?, name, file, artifactId?, taskId, taskName }> }`。
- 每项字段 = 任务级字段原样 + `taskId`/`taskName`；排序 `id` 再 `taskId`（`localeCompare` 双键）。
- `listPrototypesByTeam` 逻辑：一次 `task.findMany({ where: { teamId }, select: { id, title } })` 建 id→title 映射（ONE 查询，无 N+1）→ 无任务直接 `[]` → `artifactVersion.findMany({ where: { artifact: { taskId: { in }, type: 'file' } } })` → 共用 `mapRowToItems` → 附加 `taskId`/`taskName`（映射恒命中，`?? ''` 仅防御）。
- 鉴权：全局 JwtAuthGuard + 方法级 `assertTeamMember`（T5 同链；docs-site 不挂类级守卫，避免改变既有两任务路由行为）。源码仍走任务级 `GET /docs-site/:taskId/prototypes/<file>`（UNCHANGED，本任务仅加列表）。
- 未复用“共享 helper”：codegraph 查实 `assertTeamMember` 无共享实现（artifacts/questions/issues 各自私有拷贝），故按 T5 先例在 controller 内私有方法镜像（未知团队先 404 再 403 顺序与 artifacts 一致）。

## 3. 命令 + 结果
- `npx tsc --noEmit -p tsconfig.json`（server/）：退出 0。
- `npx eslint src/docs-site/*`：1 处 prettier error（新增 import 换行）经 `--fix` 修后干净；其余 5 warnings 均为既有（spec 未用 import×2、`require()` 复用 T6 既有模式×3）。
- `npm test -- --runInBand src/docs-site`：2 suites / 31 tests 全绿（新增 10：service 5 + controller 5；任务级回归 21 全过，形状字节一致由既有期望锁定）。
- Live（compose server :13000，seed-admin 登录 200 取 token，token 不落库）：
  - `GET /api/v1/teams/tm_0000000001/prototypes` → `404 {"message":"Cannot GET ...","error":"Not Found","statusCode":404}`（镜像早于本变更，见 §4）。
  - 回归：`GET /api/v1/docs-site/t_0000000001/prototypes` → `200 {"items":[]}`（任务级路由/形状不受影响）。
- 路由碰撞：`grep teams/:id/prototypes server/src` 事前 0 命中；裸挂载路径经单测 Reflect 元数据锁定（`PATH_METADATA '/'` + 方法 `'teams/:id/prototypes'` + `RequestMethod.GET`）。

## 4. 新旧对照收据（诚实记录：live HTTP 未过，走 deferred + jest-equivalence）
- OLD（live 镜像无此路由）：`curl -H "Authorization: Bearer $TOKEN" .../api/v1/teams/tm_0000000001/prototypes` → 上述 404（`Cannot GET` 口径 = Nest 无路由，与 T5/T11 同一判据）。
- NEW（jest 同义断言覆盖，HTTP 层 live 重验留待重部署后）：多任务聚合 + taskId/taskName 透出 + 双键排序（service happy）；空团队 `[]` 且不查版本表；未知团队 404 `TEAM_NOT_FOUND` / 非成员 403 `PERMISSION_TEAM_NOT_MEMBER` 且不调 service（controller）；路由注册元数据断言。任务级 8+13 旧用例全绿即“行为字节一致”门。
- 未走容器 harness 的原因：禁令不许 restart/rebuild；harness 只能证明 service 直读（jest 已同义覆盖），证明不了 HTTP 路由——两种路径同样止于“重部署后重验”，故选零侵入的 deferred。

## 5. 清理收据
- host `/tmp/t15_token`（bearer 暂存）已 `rm`；`ls /tmp | grep -c t15` → 0。容器零写入（未 docker cp/exec 写操作，只读 curl）。无 fixture 行（live 断言只读既有团队/任务）。
- `.omo/notepads/docs-artifacts-merge/learnings.md` 已追加 T15 一节（append-only）；该文件另有他波未提交行，故**未随本提交入库**（循 T5 §5 先例，留待归拢）。
- 外来 hunk 交代：`prototypes.service.ts` / `prototypes.service.spec.ts` 工作区事前各带他波 prettier `--fix` 空白 hunk（service 3 行、spec 两处换行，零逻辑；`git diff` 已验），本提交 absorption 不可避免（同文件），此处明示；其余 ~40 脏文件零触碰。

## 6. 风险与交接
- 风险低：新增路径独立（新方法 + 新 controller 类 + 新 spec describe）；任务级查询 where/select、映射语义、排序、返回形状均由旧用例锁定。
- 前端契约冻结如 §2；若需偏离（例如 `taskName` null 回退），停下先报告——当前实现恒为 string。
- 重部署后 live 重验项（一条 curl 即可）：`GET /api/v1/teams/:id/prototypes | jq -e '.items | length>0 and all(.taskId and .taskName and .file)'` + 非成员 403 + 未知团队 404。
