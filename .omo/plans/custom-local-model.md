# custom-local-model - Work Plan

## TL;DR (For humans)

**What you'll get:** 在现有“模型管理”单一入口内新增“添加自定义/本地模型”能力，支持配置本地 OpenAI 兼容端点（baseUrl 必填、apiKey 可空），本地模型在目录、Provider 列表、Agent 选择与 Worker 调度中与云端模型一致可用。

**Why this approach:** 复用现有 `Model` 目录与 `ProviderID` 粒度（最小侵入），仅扩展 `baseUrl/providerType` 字段并让 `ModelCredential` 对本地无鉴权场景可选缺省，避免另建新表或网关；Worker 侧通过保证 `hasKey` 可用性判断与 `baseUrl` 配置写入让 opencode 将本地模型视为 active。

**What it will NOT do:** 不做模型文件上传/本地进程托管，不做网关代理与自动健康探测，不改云端模型现有加密/下发语义，不重写 opencode 发现协议。

**Effort:** Medium
**Risk:** Medium - opencode `GET /provider` 可用性依赖 `key` 非空，本地无 token 需验证伪造/跳过策略是否让本地模型仍上报 active
**Decisions to sanity-check:** Q1 已确认 A（支持空 token）；baseUrl 存 per-model 而非 per-provider；创建时仅 URL 格式校验不做连通性探测

Your next move: 批准后运行 `/start-work` 启动执行。Full execution detail follows below.

---

> TL;DR (machine): Medium effort, Medium risk, deliverables = Prisma 扩展+迁移、后端目录/凭据分支、Worker 注入兼容、前端本地模型表单与 Agent 打通、测试与证据

## Scope
### Must have
- Prisma：`Model` 新增 `baseUrl String? @db.Text` + `providerType String @default("cloud")`（cloud|local|custom），兼容存量行；新迁移并生成 client；seed 增加示例本地模型（如 `ollama-local/qwen3`）
- 后端 DTO/校验：`CreateModelDto/UpdateModelDto` 新增 `baseUrl?`、`providerType?`，规则：当 `providerType` 为 `local|custom` 时 `baseUrl` 必填且为 `http(s)://` URL，cloud 时忽略；`apiKey/token` 对 local/custom 可空；`QueryModelsDto` 支持按 `providerType` 过滤
- 后端服务/控制器：`ModelsService.create/update/findAll/findOne/listProviders/listCatalogModels/findCatalogByRef` 返回 `baseUrl/providerType`；`setCredential/getCredential/revoke` 对本地空 token 场景跳过建行/允许缺省；`listProviders` 同时统计本地模型；`ModelsController` 暴露扩展字段
- Worker：`model-credential-injector` 支持无 token 本地 provider（跳过或写 dummy key 并保证 `V1Driver.listModels` 仍判 hasKey=true 使本地模型上报 active），并支持将 `baseUrl` 写入 opencode 配置（`$HOME/.config/opencode/opencode.json` 或 `~/.local/share/opencode/opencode.json` 的 provider 配置，或环境变量覆盖）使 `GET /provider` 的模型可用；`driver` 与 `index` 注册逻辑兼容
- 前端：`web/src/types/models.ts` 扩展类型；`/models` 目录 Tab 新增“添加本地/自定义模型”按钮与弹窗（字段：providerID/modelID/name/providerType/baseUrl/apiKey 可选/enabled），编辑弹窗支持修改 baseUrl/providerType，凭据徽章对本地无 token 显示“本地·无鉴权”；`providers-tab.tsx` 配置弹窗支持可选 token 提示；`/agents` 的 `model-select` 能选择本地模型
- 测试：server 单测/e2e 覆盖新增校验与分支，worker 单测覆盖 injector 无 token 与 baseUrl 写入，web 交互校验
- 文档：README/模型管理说明更新

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不新增模型网关/代理层或负载均衡
- 不实现大模型二进制/权重文件上传、下载或本地进程（ollama serve）拉起/启停
- 不新增独立的 `/local-models` 页面破坏“单一入口”约定（必须在 `/models` 内完成）
- 不在创建时对 `baseUrl` 做实时网络连通性探测（仅格式校验）
- 不改变现有云端模型的 AES-256-GCM 加密、指纹、吊销与下发语义
- 不重写 opencode `GET /provider` / `GET /api/model` 发现协议，仅适配

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + 契约/单测/集成，框架：server `jest --runInBand` + web `playwright`（可选）+ worker `jest`
- Evidence: `.omo/evidence/custom-local-model/task-<N>-custom-local-model.<ext>`（若在 `omo ulw-loop` 内则为 `.omo/evidence/ulw/<session>/<goalId>/a<attempt>/task-<N>-custom-local-model.<ext>`）
- 每个 Todo 的 QA 必须同时覆盖 happy 与 failure，需指明精确工具与调用（如 `npm run test -- models.service.spec`、`curl -X POST /api/v1/models`、`npm --prefix worker test -- model-credential-injector.spec`）

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1: Todo 1（Prisma 迁移）与 Todo 2（后端 DTO 校验）可并行（2 可先以 stub 字段开发，1 完成后联调）
- Wave 2: Todo 3（后端服务/控制器）依赖 Wave1；Todo 4（Worker 注入）可与 Todo 3 并行（接口契约已定）
- Wave 3: Todo 5（前端模型管理）与 Todo 6（Agent 打通）依赖 Wave2 的 API 形状确定后并行
- Wave 4: Todo 7（种子/文档/全链路证据）收敛

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2,3 | 2 |
| 2 | 1 (字段名对齐) | 3,5 | 1,4 |
| 3 | 1,2 | 5,6 | 4 |
| 4 | 1,2 | 5,6 | 3 |
| 5 | 3,4 | 7 | 6 |
| 6 | 3,4 | 7 | 5 |
| 7 | 5,6 | - | - |

## Todos
- [x] 1. Prisma Model 扩展本地模型字段并生成迁移
  What to do / Must NOT do: 在 `server/prisma/schema.prisma` 的 `Model` 上新增 `baseUrl String? @db.Text @map("base_url")` 与 `providerType String @default("cloud") @map("provider_type")`（取值 cloud|local|custom，应用层常量校验），保持 `@@unique([providerID, modelID])` 不变；创建新迁移 `add_model_local_fields`（MySQL 可移植类型，不用 @db.VarChar 定长），运行 `npx prisma migrate dev`/`deploy` 与 `npx prisma generate`；为存量行默认 cloud，无 baseUrl；更新 `server/prisma/seed.ts` 新增示例本地模型如 `providerID=ollama-local modelID=qwen3-8b name=Qwen3 8B baseUrl=http://host.docker.internal:11434/v1 providerType=local enabled=true`（不配凭据）；不改 `ModelCredential` 表结构。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2,3
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma:481-495 server/prisma/migrations/20260808145108_add_models_catalog/migration.sql server/prisma/seed.ts server/src/models/models.service.ts:375-396 (upsertCatalogModel) worker/src/credentials/model-credential-injector.ts
  Acceptance criteria (agent-executable): `npx --prefix server prisma migrate status` 显示新迁移已应用；`npx --prefix server prisma generate` 成功；`SELECT column_name FROM information_schema.columns WHERE table_name='models' AND column_name IN ('base_url','provider_type')` 返回两行；seed 后 `GET /api/v1/models?providerID=ollama-local` 能查到示例本地模型且 `baseUrl` 正确回显
  QA scenarios (name the exact tool + invocation): happy: `npm --prefix server run test -- models.service.spec -t "create local"` 需通过且创建带 baseUrl 的本地模型成功；failure: POST `/api/v1/models` 带 `providerType=local` 但无 `baseUrl` 期望 400 且 `code` 含校验错误，证据落 `.omo/evidence/custom-local-model/task-1-custom-local-model.md`
  Commit: Y | feat(models): prisma model 支持本地自定义模型 baseUrl/providerType 与示例种子

- [x] 2. 后端 DTO 扩展本地模型校验与查询
  What to do / Must NOT do: 更新 `server/src/models/dto/create-model.dto.ts` 新增 `@IsOptional @IsString @MaxLength(512) @Matches(/^https?:\/\//) baseUrl?` 与 `@IsOptional @IsIn(['cloud','local','custom']) providerType?`，并加类级条件校验（`ValidateIf` 或服务层分支）当 `providerType in ['local','custom']` 时 `baseUrl` 必填且为 http(s) URL；`UpdateModelDto` 同步；`QueryModelsDto` 新增可选 `providerType` 过滤；`SetModelCredentialDto` 对 local provider 允许 `token` 为空（`@IsOptional` 分支，不抛 400）；不改 `MODEL_SLUG_PATTERN`，不放宽 providerID/modelID 格式。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3,5
  References (executor has NO interview context - be exhaustive): server/src/models/dto/create-model.dto.ts:1-66 server/src/models/dto/update-model.dto.ts server/src/models/dto/query-models.dto.ts server/src/models/dto/set-model-credential.dto.ts server/src/models/models.constants.ts
  Acceptance criteria (agent-executable): `npm --prefix server run test -- models.controller.spec` 新增用例通过；`POST /api/v1/models` 以下均符合预期：A) `providerType=local`+合法 `baseUrl` → 201 且返回含 `baseUrl/providerType`；B) `providerType=local` 缺 `baseUrl` → 400；C) `providerType=cloud` 不传 `baseUrl` → 201；D) `baseUrl=ftp://...` → 400
  QA scenarios (name the exact tool + invocation): happy: curl 创建 local/custom 各一；failure: 非法 URL、缺 baseUrl、providerType 非法值 均 400，证据 `.omo/evidence/custom-local-model/task-2-custom-local-model.md`
  Commit: Y | feat(models): DTO 支持本地模型 baseUrl/providerType 校验与可选凭据

- [x] 3. 后端服务与控制器打通本地模型与可选凭据
  What to do / Must NOT do: 修改 `server/src/models/models.service.ts`：`create`/`update` 持久化 `baseUrl/providerType`（trim 后落库，cloud 时 baseUrl 置 null，且同 `providerID` 下多模型的 `baseUrl` 必须一致——不一致时 400 `MODEL_BASEURL_CONFLICT`，新增该错误码到 `models.constants.ts`），`findAll` 支持 `where.providerType` 与回显 `baseUrl/providerType`，`findOne`/`listCatalogModels`/`findCatalogByRef`/`listProviders` 返回扩展字段且 `listProviders` 同时计入 local 模型并返回 `providerType/baseUrl` 摘要，`syncFromWorkerCapabilities` 在 `upsertCatalogModel` 时保留用户配置的 baseUrl（worker 上报不覆盖），`setCredential` 当 `providerType=local|custom` 且 `token` 为空时跳过 `ModelCredential` upsert 与 `dispatchAfterSave` 直接返回 `configured:false` 视图（仍需记录审计日志 `logger.log` 本地无鉴权跳过），`getCredential` 对无行本地 provider 返回 `configured:false` 而非 404，`revokeCredential*` 对无行本地 provider 返回 404 `MODEL_CREDENTIAL_NOT_FOUND`；新增 `GET /models/:id` 与 `GET /models` 的 Swagger `@ApiProperty` 标注新字段；控制器透传新字段；不改加密服务。
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 5,6
  References (executor has NO interview context - be exhaustive): server/src/models/models.service.ts:100-122 (findAll) 144-201 (listProviders) 207-262 (create/update) 288-335 (sync/upsert) 430-520 (set/get/revoke) server/src/models/models.controller.ts:33-157 server/src/models/models.constants.ts server/src/common/credential-crypto.service.ts worker/src/credentials/model-credential-injector.ts:42-51
  Acceptance criteria (agent-executable): `npm --prefix server run test -- models.service.spec` 全绿（含新增本地分支与同 provider baseUrl 冲突用例）；手动验证 `POST /api/v1/models/:id/credentials` 对 local 空 token 不建行且 `GET /api/v1/models/:id/credentials` 返回 `configured:false`，对 cloud 仍强校验 token 必填；`POST /api/v1/models` 同 provider 不同 baseUrl 期望 400
  QA scenarios (name the exact tool + invocation): happy: 创建 local 带/不带 token 两链路、查询回显、listProviders 计数；failure: 对不存在 modelId 设凭据 404，`providerType` 非法 400，同 provider baseUrl 冲突 400，证据 `.omo/evidence/custom-local-model/task-3-custom-local-model.md`
  Commit: Y | feat(models): service/controller 支持本地模型 per-model baseUrl 与空 token 分支

- [x] 4. Worker 注入兼容本地无 token 与 baseUrl 配置（含前置路径探测）
  What to do / Must NOT do: 分两步：(4a) 探测——在本地先实测 opencode 1.18.x 的 provider `baseUrl` 配置落点（候选：`$HOME/.config/opencode/opencode.json`、`$HOME/.local/share/opencode/opencode.json`、`$WORK_DIR/.opencode/config.json`），执行 `opencode --help`/`cat` 验证 `providers.<providerID>.baseUrl` 或 `OPENCODE_*_BASE_URL` 环境覆盖是否生效，并将结论写入 `worker/docs/opencode-local-config.md`（或代码注释）；(4b) 实现——修改 `worker/src/credentials/model-credential-injector.ts`：`buildAuthJson` 仍仅对有 key 的 entry 产出 `type:api`，新增 `buildOpencodeConfig(providerBaseUrls: Map<providerID, baseUrl>)` 按探测结论写入对应文件（无文件时创建，保持 600 权限），并约束同 `providerID` 的多模型 `baseUrl` 必须一致（不一致时取首个并 `logger.warn`）；保证无 token 本地 provider 仍让 `V1Driver.listModels` 判定为可用——优先实现为对 `providerType=local|custom`（需 server 通过新 dispatch `model-metadata` 或复用 `model-credentials` 的扩展字段同步 `providerType/baseUrl`，或约定 `providerID` 前缀 `local-*`/`ollama-*`/`custom-*`）的 `hasKey` 分支视为有 key，无需 dummy key 亦可但需保留 dummy fallback；`worker/src/index.ts` 在注册/心跳后同步 `Model` 的 `baseUrl/providerType` 元数据到 opencode config；`writeAuthJson` 保持 600 权限，不写空 key；不改 `OpencodeServer` 的 `--pure` 启动方式。
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 5,6
  References (executor has NO interview context - be exhaustive): worker/src/credentials/model-credential-injector.ts:1-89 worker/src/driver/v1-driver.ts:375-410 worker/src/index.ts:100-180 worker/src/runtime/opencode-server.ts:289-310 worker/src/config.ts server/src/models/models.service.ts:144-201 (listProviders providerType) docs/agent-platform/21-平台MCP-Server设计方案.md
  Acceptance criteria (agent-executable): 探测结论有书面记录；`npm --prefix worker run test -- model-credential-injector.spec` 新增用例：A) 有 baseUrl 无 token 的 local 仍生成 opencode config 且 listModels 视 local 分支为有 key 返回 `ollama-local/qwen3-8b` 且 status=active；B) 有 token 的 local 仍写 auth.json；C) 同 providerID 多 baseUrl 不一致时 warn 且保留首个；`node` 启动 worker 后 `GET http://127.0.0.1:<servePort>/provider` 中本地 provider 的 models 状态为 active
  QA scenarios (name the exact tool + invocation): happy: 启动带本地模型的 worker，`driver.listModels()` 含 `ollama-local/qwen3-8b` 且 status=active；failure: baseUrl 非 http(s) 时 config 写入跳过并打 warn 不崩溃，空 `providerKeys` 不产非法 JSON，证据 `.omo/evidence/custom-local-model/task-4-custom-local-model.md`（含探测记录）
  Commit: Y | feat(worker): 支持本地模型无 token 与 baseUrl 的 opencode 注入及可用性上报

- [x] 5. 前端模型管理新增本地/自定义模型表单与展示
  What to do / Must NOT do: 更新 `web/src/types/models.ts` 的 `ApiModel/ProviderSummary` 增加 `baseUrl?: string | null`、`providerType?: 'cloud'|'local'|'custom'`；在 `web/app/(main)/models/page.tsx` 目录 Tab 增加“添加自定义模型/本地模型”按钮与弹窗（字段：providerID、modelID、name、providerType 下拉、baseUrl（local/custom 必填，http(s) 校验）、enabled），复用 `POST /api/v1/models`，成功后 `invalidateQueries(["models","model-providers","workers"])`；`ModelRow` 增加 baseUrl 与类型徽章（local=紫/自定义=橙）；凭据徽章对本地无 token 显示“本地·无鉴权”（而非未配置红）；`web/app/(main)/models/providers-tab.tsx` 的 `ConfigureModal` 将 token 输入提示改为“可选（本地无鉴权可留空）”，保存时若 token 为空则仍提示将跳过凭据存储；不新增独立路由，保持双 Tab 结构内完成。
  Parallelization: Wave 3 | Blocked by: 3,4 | Blocks: 7
  References (executor has NO interview context - be exhaustive): web/app/(main)/models/page.tsx:1-748 web/app/(main)/models/providers-tab.tsx:1-1038 web/src/types/models.ts:1-71 web/src/theme/tokens.ts web/lib/api.ts
  Acceptance criteria (agent-executable): `npm --prefix web run lint` 通过；`npm --prefix web run build` 成功；手动 e2e（playwright 可选）：以 admin 登录 → /models → 添加本地模型（providerType=local, baseUrl=http://host.docker.internal:11434/v1, 空 token）成功后列表出现且 baseUrl 可见，凭据徽章为本地无鉴权态；编辑 baseUrl 成功；cloud 模型不显示 baseUrl 列
  QA scenarios (name the exact tool + invocation): happy: 添加 local/custom 各一、编辑切换类型、空 token 保存；failure: local 缺 baseUrl、baseUrl 非 http(s)、providerID 非 slug 均前端校验拦截，证据 `.omo/evidence/custom-local-model/task-5-custom-local-model.md`（含截图路径或 DOM 断言日志）
  Commit: Y | feat(web): 模型管理支持添加本地/自定义模型与空 token 展示

- [x] 6. Agent 模型选择与凭据展示打通本地模型
  What to do / Must NOT do: 更新 `web/app/(main)/agents/page.tsx` 的 `model-select` 数据源与展示：下拉按 `providerType` 分组（云端/本地/自定义），本地模型项展示 `name + baseUrl` 副标题，选择后 `ConfigPanel` 的凭据区若为本地无 token 则显示“本地模型·无鉴权（直连 baseUrl）”且隐藏 token 输入，`tokenQuery` 对本地无行不报错；后端 `server/src/agents/agents.service.ts` 的 `available-models` 校验允许 `defaultModelId` 指向本地模型（复用 `findCatalogByRef` 已支持）；不改工具权限与角色逻辑。
  Parallelization: Wave 3 | Blocked by: 3,4 | Blocks: 7
  References (executor has NO interview context - be exhaustive): web/app/(main)/agents/page.tsx:740-1350 server/src/agents/agents.service.ts server/src/models/models.service.ts:343-360 (findCatalogByRef)
  Acceptance criteria (agent-executable): 创建/编辑 Agent 时可选择新建的本地模型并保存成功，`GET /api/v1/agents/:id` 的 `defaultModelId` 为 `ollama-local/qwen3-8b` 且前端回显正确；`worker/src/driver/v1-driver.ts` 的 `sendMessage` 使用该模型 `model: {providerID:'ollama-local', modelID:'qwen3-8b'}` 能发起会话（即使本地服务未在线也应走到模型路由而非参数校验失败）
  QA scenarios (name the exact tool + invocation): happy: 选择本地模型保存 Agent → 触发会话 `POST /api/v1/chat` 模型解析通过；failure: 选择不存在的模型 id 后端 400，证据 `.omo/evidence/custom-local-model/task-6-custom-local-model.md`
  Commit: Y | feat(web+agents): Agent 配置打通本地模型选择与无鉴权展示

- [x] 7. 种子、文档、测试与全链路证据收敛
  What to do / Must NOT do: 更新 `server/prisma/seed.ts` 与 `docs/agent-platform/*`（08 架构/14 Agent 配置/21 MCP 可补充模型目录扩展说明）、`server/README.md` 与 `web/README.md` 的模型管理章节；补单测：`server/src/models/models.service.spec.ts`、`models.controller.spec.ts` 增加本地分支，`worker/src/credentials/model-credential-injector.spec.ts` 增加无 token+baseUrl 分支；跑 `npm --prefix server run test` 与 `npm --prefix worker run test` 全绿；在 `.omo/evidence/custom-local-model/` 下产出 task-1..6 证据与本 todo 的汇总证据（含迁移记录、API curl 日志、前端截图/断言）；不引入新依赖。
  Parallelization: Wave 4 | Blocked by: 5,6 | Blocks: -
  References (executor has NO interview context - be exhaustive): server/prisma/seed.ts docs/agent-platform/08-平台架构设计.md docs/agent-platform/14-Agent配置与虚拟团队模型.md server/src/models/models.service.spec.ts worker/src/credentials/model-credential-injector.spec.ts
  Acceptance criteria (agent-executable): `npm --prefix server run test -- --runInBand` 与 `npm --prefix worker run test` 均通过；`npx --prefix server prisma migrate status` 无待应用迁移；`GET /api/v1/models?providerType=local` 与 `GET /api/v1/models/providers` 均正确区分本地/云端；证据目录结构完整
  QA scenarios (name the exact tool + invocation): happy: 全量回归；failure: 回滚迁移后重新 `migrate deploy` 仍幂等，证据 `.omo/evidence/custom-local-model/task-7-custom-local-model.md`
  Commit: Y | docs(models): 补充本地模型种子、文档与测试证据

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- 每个 Todo 独立提交（feat/fix/docs 前缀 + scope），信息遵循 `type(scope): summary`，不 squash 直到最终复审通过
- 提交前 `npm --prefix server run lint -- --fix`（若存在）与 `npx --prefix server tsc --noEmit` 类型检查
- 迁移提交与代码提交分离，便于回滚（先迁后码）

## Success criteria
- 模型目录可创建并查询到 `providerType=local|custom` 且 `baseUrl` 为 http(s) 的本地模型，cloud 模型不受影响
- 本地无 token 模型不要求 `ModelCredential`，`GET /credentials` 返回 `configured:false` 且 Worker 仍上报该模型为 active（通过 dummy key 或分支后 hasKey）
- Worker 能将 `baseUrl` 写入 opencode 配置，`GET /provider` 中本地 provider 的模型可见且可被 `sendMessage {model:{providerID,modelID}}` 选中
- 前端在 `/models` 内完成添加/编辑本地模型，凭据区正确显示“本地·无鉴权”，Agent 可绑定本地模型
- `server` 与 `worker` 单测全绿，`prisma migrate status` 无漂移，证据落盘完整
