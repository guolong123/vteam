# T4 证据 — 后端写路径与查询：category 落库 + 过滤 + 透出

## 变更文件
- `server/src/artifacts/artifacts.constants.ts`：加 `ARTIFACT_CATEGORIES` 七类中文词表（server 唯一源）+ 互指注释
- `web/src/lib/artifact-categories.ts`（新建）：同字面量七类镜像 + 头注释互指 server 源，无逻辑
- `server/src/artifacts/dto/artifact.dto.ts`：`CreateArtifactDto.category` + `QueryArtifactsDto.category`（`@IsOptional @IsIn(ARTIFACT_CATEGORIES)`）
- `server/src/artifacts/artifacts.service.ts`：`ArtifactSubmittedPayload.category?`；`validateArtifactDeclaration` 校验 category（非法→`{valid:false}`，未知字段仍忽略，`type` 三态不动）；`append()` 新建行写 `category`（缺省 NULL），命中已存在行只递增 `currentVersion`（不覆盖原值）；`archiveFile(taskId, args, category?)` 三参（`category ?? args.category ?? null`，仅新建行写入）；`findByTask()` where 加 `category`；`toArtifactListItem` 加 `category`（`?? null`）
- `server/src/artifacts/artifacts.controller.ts`：`append` 透传 `dto.category`
- `server/src/artifacts/artifacts.service.spec.ts`：新增 `category` describe（11 用例）+ 存量新建 v1 期望补 `category: null`
- `server/src/artifacts/artifacts.controller.spec.ts`：存量期望补 `category: undefined` + 新增透传用例

## 命令与结果
1. `npx prisma generate --schema prisma/schema.prisma`（server/，host）：成功；`grep -c category node_modules/.prisma/client/index.d.ts` → `40`（T1 后 host client 陈旧，必须重生成，否则 `tx.artifact.create({category})` 过不了 tsc）
2. `npx jest --runInBand src/artifacts src/platform-mcp/plan-removal.guard.spec.ts`（server/，前台）：**4 suites / 77 tests 全绿**（含 `plan-removal.guard.spec.ts` 三态锁）
   - 新增覆盖：validate 合法/非法/缺省/NULL/未知字段忽略；persist-on-create（含 NULL 缺省）；append-no-overwrite（update 精确断言 `data:{currentVersion:2}` 且结果保留原值）；invalid-category-400（service 抛 400 `ARTIFACT_INVALID_DECLARATION`，零写库）；event-path invalid 不抛错；findByTask where 透传；列表项缺省 null；archiveFile 新建写/append 不覆盖
3. `npx tsc --noEmit -p tsconfig.json`（server/）：退出 0；`npx tsc --noEmit -p tsconfig.json`（web/）：退出 0
4. DTO 运行时校验（ts-node 直调 class-validator）：`create-invalid-errors: 1` / `create-valid-errors: 0` / `create-optional-errors: 0` / `query-invalid-errors: 1`
5. 词表 parity 门：`diff <(sed -n "/ARTIFACT_CATEGORIES/,/] as const/p" server/src/artifacts/artifacts.constants.ts | grep -o "'[^']*'" | sort) <(grep -o "'[^']*'" web/src/lib/artifact-categories.ts | sort)` → **退出 0**（`VOCAB_GATE=PASS`）
6. 全局确认无漂移定义：`grep -rn "ARTIFACT_CATEGORIES" server/src web/src --include="*.ts"` → 仅 constants 定义 + dto/service 引用 + web 镜像（见下）

## Live curl（未达标，原因明确记录，未伪造）
- 现状：compose `aiagents-compose-server`（healthy）在运，但其镜像构建于 T4 代码之前。
- 实测收据（token 经 `POST /api/v1/auth/login` seed-admin 获取）：
  - `GET /tasks/t_0000000001/artifacts?pageSize=2` → 200，items **无 `category` 字段**（旧代码形状）
  - `GET /tasks/t_0000000001/artifacts?category=需求` → 200 但返回**未过滤**全量（旧代码忽略未知 query），故 `jq -e '.items | length>0 and all(.category=="需求")'` 在此部署上不可成立
- 结论：完整 live 断言需等含 T4 的 server 镜像重部署后由 T12 统一验证；本 todo 以 jest 同义断言覆盖（filter where 精确断言 + 透出断言 + 非法值 400），不伪造 curl 输出。T2 回填 fixture 行（`t2qa_*`）未动，无需清理（本 todo 未写 live 行）。

## 未碰项
`ARTIFACT_TYPES`、sha256 幂等键、accepted 语义、版本递增、completed→in_progress 回退、`platform-mcp`、`uploads.controller` 均未改。

## 风险
- 下游 T5 `findByTeam` 复用 `findByTask` where 形状：本实现用 `{taskId, ...(type), ...(category)}` 展开，T5 照抄加 `task.teamId` 约束即可
- T7 透传：`append` 经 `submission.category`，`archiveFile` 经第三参 `category`（兼容 `args.category`），参数名均为 `category`
