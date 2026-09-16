# T5 — 新聚合端点 `GET /teams/:id/artifacts` 证据

## 1. 变更文件（本次提交内）
- `server/src/artifacts/dto/artifact.dto.ts` — 新增 `QueryTeamArtifactsDto extends QueryArtifactsDto`（仅追加可选 `taskId?: string`；`type/category/accepted/page/pageSize` 全部继承，过滤全可选）。
- `server/src/artifacts/artifacts.service.ts` — 新增 `findByTeam(teamId, query)`（import 加 `QueryTeamArtifactsDto`；`findByTask`/`toArtifactListItem` 零改动）。
- `server/src/artifacts/artifacts.controller.ts` — 新增 `@Get('teams/:id/artifacts')`（`PermissionGuard` + `artifacts.view` + `assertTeamMember`）；构造器追加 `PrismaService`（全局模块提供）；其余 6 端点零改动。
- `server/src/artifacts/artifacts.service.spec.ts` — 新增 `findByTeam` describe（10 用例）；共享 prisma mock 仅追加 `team.findUnique` + `task.findMany`（既有 mock 行未动）。
- `server/src/artifacts/artifacts.controller.spec.ts` — 新增 `GET /teams/:id/artifacts` describe（4 用例）；`PrismaService` mock 追加 `team`/`teamUserMember` 委托，既有期望未动。

## 2. 语义（供 T8 消费，响应形状冻结）
- 路由：`GET /api/v1/teams/:id/artifacts?taskId=&type=&category=&accepted=&page=&pageSize=`。
- 鉴权：`PermissionGuard` + `artifacts.view`；未知团队 → `404 TEAM_NOT_FOUND`；非成员 → `403 PERMISSION_TEAM_NOT_MEMBER`。成员校验仿 `questions.controller.ts:119-133 assertTeamMember`（直接 `teamId → teamUserMember`，非任务反查——团队路由无需反查；与任务端点的反查语义同权：同为“归属团队成员可见”）。
- 未用类级 `TeamMembershipGuard` 的原因：其 `resolveTeamId` 把 `:id` 先按团队解释、回退任务反查——挂到 `ArtifactsController` 类级会连带改变既有 6 端点行为（`tasks/:id/artifacts` 会突然对非成员 403）。方法级显式校验是唯一零回归方案。
- `findByTeam` 逻辑：团队存在性 404 → 一次 `task.findMany({where:{teamId}})` 取 id→title 映射（`taskId` 参数仅在映射内过滤，非本团队 id → 空集，不泄露）→ `artifact.findMany({taskId:{in}, type?, category?}, createdAt desc)` → 一次 `artifactVersion.findMany` 取当前版本 → accepted 内存过滤（与 `findByTask` 同构）→ 同款 `normalizePage/normalizePageSize`（page 默认 1，pageSize 默认 20、上限 100、超限截断）。
- 返回项 = `toArtifactListItem` 输出 + `taskName: string | null`（映射缺失回退 null；正常恒有值）。字段清单：`id, taskId, taskName, type, title, category, currentVersion, acceptedFlag, authorAgentId, createdAt, updatedAt[, fileUrl]`。

## 3. 命令 + 结果
- `npx tsc --noEmit -p tsconfig.json`（server/）：退出 0。
- `npx eslint <5 files> --fix` 后复查：`LINT_CLEAN`（9 处 prettier 换行，均系新增行超长）。
- `npm test --prefix server -- --runInBand src/artifacts`：3 suites / 80 tests 全绿（含新增 14：service 10 + controller 4）。
- Live（compose server 镜像早于本变更，HTTP 路由本身 404，见 §4）→ 按 T6 模式把新 service 代码逐字编译后在容器内直驱 live MySQL（只读），`jq -e` 三门全过：
  - `.cat.items | length==8 and all(.category=="测试报告") and all(.taskName != null and .taskId != null)` → true（`tm_0000000002?category=测试报告`，8 行全命中，taskName 均为 “S9 历史数据准确性测试…”）。
  - `.taskType.items | length>0 and all(.taskId=="t_0000000001" and .type=="file" and .taskName != null)` → true（total=13）。
  - `.combined.total==5 and .clamp.pageSize==100 and .emptyTeam.total==0 and .missing.code=="TEAM_NOT_FOUND"` → true（联合过滤命中已知 5 行 text 测试报告；`pageSize=1000→100`，total=27；无任务团队 `tm_0000000006` 空集；未知团队 404）。
- `git status` 确认提交仅含上述 6 文件（5 代码 + 本证据）；未 push。

## 4. 新旧对照收据（诚实记录：live HTTP 未过）
- OLD（live 镜像无此路由）：`curl -H "Authorization: Bearer $TOKEN" .../api/v1/teams/tm_0000000001/artifacts` → `{"message":"Cannot GET /api/v1/teams/tm_0000000001/artifacts","error":"Not Found","statusCode":404}`（对照：同前缀未知路径 `nonexistent-xyz` 同为 404 口径；此前一次空 body 400 系 URL 内未编码中文 `需求` 所致，重测编码后一致 404）。
- NEW（jest + 容器内 harness 同义断言覆盖，见 §3）：HTTP 层 live 重验留待 T12（重部署后跑计划原 curl 门：`.../teams/$TID/artifacts?category=需求 | jq -e '.items | length>0 and all(.category=="需求")'`——注意 live 当前无 `需求` 行，届时需按 §3 改用 `测试报告` 或 T12 fixture 行）。
- accepted=true 的 live 行当前不存在（抽查分类行 acc 全 0），true 分区仅 jest 覆盖；false/联合已 live 覆盖。

## 5. 清理收据
- 容器：`rm -rf /tmp/t5raw /tmp/t5-live.json`，`ls /tmp | grep -c t5` → 0（`CONTAINER_TMP_CLEAN`）。host `/tmp/t5raw|t5-live.json|t5_token.txt|t5_old_route.json` 为 git 外临时文件，不入库。
- fixture：全程只读，无写入、无 fixture 行，无需清理。live 断言按已知 artifactId 验收（moving-target 安全：期间 total=27 与抽查一致）。
- `.omo/notepads/docs-artifacts-merge/learnings.md` 已追加 T5 一节（append-only）；该文件另有他波未提交行（T2/T6 节），故**未随本提交入库**，留待 T13 归拢。

## 6. 风险与交接
- 风险低：新增代码路径独立；`findByTask`、6 端点签名、`toArtifactListItem` 形状、分页常量均未触碰（diff 可验）。
- T8 约束：团队视图只调本端点；`taskName` 可能为 null（仅防御分支），前端按 string 渲染前做 `?? ''` 即可。
- T12 live 重验项：HTTP 200 + `category=测试报告` 过滤门 + 非成员 403（需两个 token）+ 未知团队 404。
