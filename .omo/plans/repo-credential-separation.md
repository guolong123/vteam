# repo-credential-separation - Work Plan

## TL;DR (For humans)

**What you'll get:** 凭证可独立创建/管理并被多个仓库复用；创建仓库时从下拉选择已有凭证，不再每次重复填私钥/token；授权仍按仓库粒度。

**Why this approach:** 复用现有 AES-256-GCM 加密与 Worker 下发链路，仅拆数据模型（凭证池 `name` 唯一 + 仓库表 `credentialId` 外键 + 授权表改 `repoId`），前端同页双 Tab 最小改动且符合现有设计语言。

**What it will NOT do:** 不做存量数据迁移（破坏性重建）、不改动 SSH 临时文件/askpass 逻辑、不引入组织/项目级隔离、不新增审计历史表。

**Effort:** Medium
**Risk:** Medium - Prisma 破坏性迁移 + Worker 过滤链路改 join，漏改一处即导致下发空
**Decisions to sanity-check:** 凭证 `name` 全局唯一；`GitCredential` 保留 `gc_`，新 `GitRepo` 用 `gro_` 前缀；双 Tab 而非双页面；409 阻断被引用凭证删除

Your next move: approve via `$start-work repo-credential-separation` or request high-accuracy review. Full execution detail follows below.

---

> TL;DR (machine): Medium effort, Medium risk, 1凭证:N仓库拆分 + 双Tab前端 + Worker join 下发

## Scope
### Must have
- Prisma: `GitCredential` 重塑为凭证池（`name` 唯一 + `authType`+`credentialRef`+`fingerprint`+`description`+`createdBy`+`revokedAt`），新增 `GitRepo`（`id, repoUrl唯一, credentialId FK→GitCredential, revokedAt, createdBy, createdAt`），`GitRepoGrant` 改 `repoId` 关联（`agentId+repoId` 唯一，保留 `permission/effect/grantedBy/grantedAt/revokedAt`）
- 常量: 新增 `GIT_REPO_ID_PREFIX='gro'`（或 `grpo_` 需与 `gr_` 不冲突），新增错误码 `CREDENTIAL_NOT_FOUND/CREDENTIAL_IN_USE/CREDENTIAL_NAME_EXISTS`
- DTOs: 新增 `CreateGitCredentialDto/UpdateGitCredentialDto`（`name, authType, key, description?`），重构 `CreateGitRepoDto` 为 `repoUrl, credentialId, grantedAgents?`（移除 `authType/key`），`UpdateGitRepoDto` 为 `credentialId?, grantedAgents?`
- 后端凭证域: `GitCredentialsService/Controller` 独立 CRUD ` /api/v1/git-credentials`（`GET` 脱敏列表/`POST` 加密/`PATCH :id` 重加密/`DELETE :id` 被引用则409），`AdminGuard` 写保护，`GET` 成员可读
- 后端仓库域重构: `GitReposService` 改为按 `credentialId` 校验凭证存在且未吊销，`findAll/toView` 通过 `credentialId` join 凭证取 `authType/fingerprint`，`create/update/remove` 维护 `GitRepo`+`GitRepoGrant(repoId)` 并触发 `dispatchGitCredentials`
- Worker 链路: `WorkersService.resolveWorkerActiveRepoUrls/buildGitCredentialsPayload/dispatchGitCredentials/replayGitCredentials` 改为 `GitRepo(active+repoId) → GitCredential(解密)` join，`credentials` 仍按 `repoUrl` 去重取最高权限，保持 `GitCredentialEntry{repoUrl,authType,key,fingerprint,permission}` 落盘格式不变
- 前端类型: `web/src/types/git-repos.ts` 拆为 `GitCredentialView{ id,name,authType,fingerprint,description,revokedAt,createdAt }` + `GitRepoView{ id,repoUrl,credentialId,credentialName,authType,fingerprint,grantedAgents[] }` + 对应 Payload 类型
- 前端页面: `web/app/(main)/git-repos/page.tsx` 同页双 Tab（仓库 Tab | 凭证 Tab），凭证 Tab 支持增改删（`name/authType/key` 表单），仓库 Tab 创建/编辑改为 `repoUrl` 输入 + 凭证下拉（`GET /git-credentials` 数据源）+ 授权多选，空态/冲突/409 提示
- 迁移与模块: `server/prisma/migrations` 破坏性迁移（因无需兼容存量），`GitReposModule` 注册新 `GitCredentialsService/Controller`，`RealtimeModule` 保留

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不提供存量 `gc_` 数据自动回填/回滚脚本（用户明确不需要）
- 不改动 `worker/src/git/git-tools.ts` 的 `normalizeSshKey/writeTempKey/writeAskpass/buildGitEnv/runGit` 逻辑
- 不改动 `ModelCredential` 域与 `CredentialCryptoService` 加密实现
- 不引入按 `project/organization` 的凭证隔离或角色/项目粒度授权
- 不新增凭证版本历史/审计日志表（沿用 `revokedAt` 软删）
- 不改动全局 `JwtAuthGuard/AdminGuard` 鉴权模型
- 不将 `authType` 冗余存于 `GitRepo`（以凭证为准，避免不一致）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + framework `jest --runInBand` (server) + `playwright` smoke (web)
- Evidence: `.omo/evidence/repo-credential-separation/task-<N>.log` (outside ulw-loop use `.omo/evidence/`)
- 关键断言: `GET /git-credentials` 脱敏无 `credentialRef/key` 明文；`POST /git-repos` 无 `credentialId` 400；引用不存在凭证 404；删除被引用凭证 409；`GET /git-repos` 返回 `credentialName/authType/fingerprint` 正确 join；`WorkersService` 单测 mock Prisma 验证 dispatch 产出 `repoUrl+authType+key` 正确；前端双 Tab 切换与仓库下拉联动

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1: Schema + 常量 + DTOs (todos 1-4) 可并行启动，1 为阻塞根
- Wave 2: 后端服务 (todos 5-7) 依赖 Wave 1，5 与 6 可部分并行，7 依赖 5+6
- Wave 3: 前端 + 收尾验证 (todos 8-10) 依赖 Wave 2，8 与 9 可并行，10 聚合

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2,3,4,5,6,7 | - |
| 2 | 1 | 5,6 | 3,4 |
| 3 | 1 | 5 | 2,4 |
| 4 | 1 | 6 | 2,3 |
| 5 | 1,2,3 | 7,8,9 | 6 |
| 6 | 1,2,4 | 7,8,9 | 5 |
| 7 | 5,6 | 9,10 | - |
| 8 | 5,6 | 9,10 | 9 |
| 9 | 5,6,7,8 | 10 | 8 |
| 10 | 7,8,9 | - | - |

## Todos
- [x] 1. Prisma schema 重构为凭证池+仓库分离
  What to do / Must NOT do: 修改 `server/prisma/schema.prisma`：`GitCredential` 重塑为凭证池 `id(String gc_)/name(String @unique)/authType(String)/credentialRef(String @db.Text)/fingerprint(String)/description(String? @db.Text)/createdBy(String)/createdAt(DateTime)/revokedAt(DateTime?)` 移除 `repoUrl`；新增 `GitRepo` `id(String gro_)/repoUrl(String @unique)/credentialId(String @map("credential_id"))/createdBy/createdAt/revokedAt` + FK 逻辑关联（不建 Prisma relation 以保 Restrict）；`GitRepoGrant` 字段 `repoUrl(String)` → `repoId(String @map("repo_id"))` 并改 `@@unique([agentId, repoId])` + `@@index([repoId])`；保留 `@@map` 表名；Must NOT 改动其他 18 张表/字段
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2,3,4,5,6,7
  References (executor has NO interview context - be exhaustive): server/prisma/schema.prisma:534-576, server/src/git-repos/git-repos.constants.ts:8-10, server/src/common/id-generator.ts, server/prisma/migrations
  Acceptance criteria (agent-executable): `npx prisma validate` 通过；`npx prisma migrate dev --name repo-credential-separation --create-only` 生成迁移 SQL 含 `CREATE TABLE git_repos` 与 `ALTER TABLE git_credentials` 移除 `repo_url` 唯一键且 `git_repo_grants` 改 `repo_id`；`grep -r "repoUrl" server/prisma/schema.prisma` 仅出现在 `GitRepo.repoUrl`
  QA scenarios (name the exact tool + invocation): happy: `npx prisma validate` + `npx prisma migrate dev --name repo-credential-separation --create-only --skip-seed` 生成文件存在；failure: 故意保留 `repoUrl` 于 GitCredential 则 `prisma validate` 提示重复列 检查迁移 SQL 不应含 `repo_url` 于 `git_credentials`；Evidence `.omo/evidence/repo-credential-separation/task-1-prisma.log`
  Commit: Y | feat(prisma): split GitCredential pool and GitRepo with repoId grants

- [x] 2. 常量与 ID 前缀及错误码更新
  What to do / Must NOT do: 编辑 `server/src/git-repos/git-repos.constants.ts` 新增 `GIT_REPO_ID_PREFIX='gro'`（与 `gc_`/`gr_` 不冲突，供 `GitRepo`），保留 `GIT_CREDENTIAL_ID_PREFIX='gc'` 给凭证池、`GIT_REPO_GRANT_ID_PREFIX='gr'` 给授权；扩展 `GIT_REPOS_ERRORS` 新增 `CREDENTIAL_NOT_FOUND/CREDENTIAL_NAME_EXISTS/CREDENTIAL_IN_USE`；同步更新 `GIT_AUTH_TYPES/GIT_PERMISSIONS/GIT_EFFECTS` 导出不变；Must NOT 改动 `worker` 常量
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5,6
  References (executor has NO interview context - be exhaustive): server/src/git-repos/git-repos.constants.ts:1-53, server/src/git-repos/git-repos.service.ts:19-24, server/src/common/id-resync.ts
  Acceptance criteria (agent-executable): `grep -q "GIT_REPO_ID_PREFIX" server/src/git-repos/git-repos.constants.ts` 且值为 `gro`；`tsc --noEmit` 通过；`node -e "require('./dist/git-repos/git-repos.constants.js')"` 可加载
  QA scenarios (name the exact tool + invocation): happy: `npm run build` 成功且常量被 service 引用无未定义；failure: 前缀与 `gr_` 冲突导致 `resyncIdPrefix` 覆盖错误 构造两行 `gc_` 与 `gro_` 校验不重叠；Evidence `.omo/evidence/repo-credential-separation/task-2-constants.log`
  Commit: Y | feat(git-repos): add repo prefix and credential error codes

- [x] 3. 凭证域 DTOs 新建
  What to do / Must NOT do: 新建 `server/src/git-repos/dto/create-git-credential.dto.ts` 与 `update-git-credential.dto.ts`：`CreateGitCredentialDto` 含 `name(string @IsString @IsNotEmpty @MaxLength(64))+authType(@IsIn ssh_key/https_token)+key(@IsString @IsNotEmpty)+description?(@IsString @MaxLength(256) @IsOptional)`；`UpdateGitCredentialDto` 含 `name?+key?+description?` 全可选；添加 `ApiProperty` Swagger；Must NOT 在此 DTO 中包含 `repoUrl/grantedAgents`
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5
  References (executor has NO interview context - be exhaustive): server/src/git-repos/dto/create-git-repo.dto.ts:1-87, server/src/git-repos/dto/update-git-repo.dto.ts:1-37, server/src/models/dto/set-model-credential.dto.ts:1-59
  Acceptance criteria (agent-executable): `npm run build` 通过；`class-validator` 单测：`validate(new CreateGitCredentialDto({name:'',authType:'ssh_key',key:'x'}))` 返回 `name` 错误；`name` 超长 65 字符 400
  QA scenarios (name the exact tool + invocation): happy: POST `/git-credentials` 合法负载 201；failure: `authType=invalid` 400 `AUTH_TYPE_INVALID`，`name` 重复 409 `CREDENTIAL_NAME_EXISTS`；Evidence `.omo/evidence/repo-credential-separation/task-3-credential-dto.log`
  Commit: Y | feat(git-repos): add credential DTOs with name validation

- [x] 4. 仓库域 DTOs 重构为 credentialId 引用
  What to do / Must NOT do: 重构 `server/src/git-repos/dto/create-git-repo.dto.ts` 移除 `authType/key` 新增 `credentialId(string @IsString @IsNotEmpty)` 保留 `repoUrl(string @IsString @IsNotEmpty)` 与 `grantedAgents?(GitGrantInput[])`；`update-git-repo.dto.ts` 改为 `credentialId?(string)+grantedAgents?`；更新 `GitGrantInput` 保持 `permission/effect` 默认逻辑；Must NOT 保留 `key` 字段于仓库 DTO
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 6
  References (executor has NO interview context - be exhaustive): server/src/git-repos/dto/create-git-repo.dto.ts:54-87, server/src/git-repos/dto/update-git-repo.dto.ts:1-37, server/src/git-repos/git-repos.service.ts:130-195
  Acceptance criteria (agent-executable): `grep -q "credentialId" server/src/git-repos/dto/create-git-repo.dto.ts` 且 `grep -q "key" server/src/git-repos/dto/create-git-repo.dto.ts` 返回空；`POST /git-repos` 缺 `credentialId` 400
  QA scenarios (name the exact tool + invocation): happy: `credentialId` 合法创建 201 返回含 `credentialName`；failure: `credentialId` 指向不存在凭证 404 `CREDENTIAL_NOT_FOUND`，`repoUrl` 空 400；Evidence `.omo/evidence/repo-credential-separation/task-4-repo-dto.log`
  Commit: Y | feat(git-repos): refactor repo DTOs to credentialId reference

- [x] 5. 凭证池独立 Service/Controller CRUD 实现
  What to do / Must NOT do: 新建 `server/src/git-repos/git-credentials.service.ts` 与 `git-credentials.controller.ts`：`findAll` 查 `revokedAt=null` 脱敏返回 `GitCredentialView(id,name,authType,fingerprint,description,revokedAt,createdAt)`；`create` 校验 `name` 唯一（未吊销）→409，`authType` 合法→400，`encrypt(dto.key)`+`fingerprint` 落库 `gc_`；`update` 支持 `name/key/description` 部分更新（`name` 冲突409，`key` 重加密）；`remove` 软撤前查 `GitRepo` 存在 `credentialId` 引用且 `revokedAt=null` 则409 `CREDENTIAL_IN_USE` 否则软撤；`onModuleInit` 增加 `resyncIdPrefix(gitCredential, gc_)`；`Controller` 路由 `GET/POST /git-credentials` `PATCH/DELETE /git-credentials/:id`，`POST/PATCH/DELETE` 加 `AdminGuard`，`GET` 成员只读；复用 `CredentialCryptoService/IdGeneratorService/PrismaService`；Must NOT 返回 `credentialRef/key` 明文，Must NOT 在凭证模块触发 Worker 下发（仓库变更才触发）
  Parallelization: Wave 2 | Blocked by: 1,2,3 | Blocks: 7,8,9
  References (executor has NO interview context - be exhaustive): server/src/git-repos/git-repos.service.ts:76-393, server/src/git-repos/git-repos.controller.ts:1-87, server/src/git-repos/git-repos.module.ts:1-26, server/src/common/credential-crypto.service.ts, server/src/models/models.controller.ts
  Acceptance criteria (agent-executable): `curl -H "Authorization: Bearer <admin>" GET /api/v1/git-credentials` 200 返回数组无 `credentialRef`；`POST /git-credentials {name,authType,key}` 201 且二次同名 POST 409；`DELETE /git-credentials/:id` 被仓库引用时 409 非引用时 200；`npm run test -- git-credentials` 通过
  QA scenarios (name the exact tool + invocation): happy: 创建 ssh_key 凭证→列表含 fingerprint→更新 description→删除未引用成功；failure: 非 admin POST 403，`name` 空 400，删除被引用 409 提示 `CREDENTIAL_IN_USE`；Evidence `.omo/evidence/repo-credential-separation/task-5-credential-service.log`
  Commit: Y | feat(git-repos): add credential pool CRUD with 409 in-use guard

- [x] 6. 仓库 Service 重构为引用凭证 + 授权按 repoId
  What to do / Must NOT do: 重构 `server/src/git-repos/git-repos.service.ts`：`findAll` 改为查 `GitRepo(revokedAt=null)` + `GitCredential(revokedAt=null)` + `GitRepoGrant(revokedAt=null)` + `Agent` 内存 join 组装 `GitRepoView(id,repoUrl,credentialId,credentialName,authType,fingerprint,grantedAgents)`（`fingerprint/authType` 取凭证）；`create` 规范化 `repoUrl` 后校验 `credentialId` 存在且未吊销否则404，校验 `repoUrl` 未吊销唯一否则409，`assertAgentsExist` 后 `create` `GitRepo(gro_)` 与 `createGrants(repoId)`（`deleteMany` 清已软撤占位防唯一冲突）；`update` 支持 `credentialId?`（切换凭证需校验）与 `grantedAgents?` 全量覆盖（软撤旧+`createGrants`）；`remove` 软撤 `GitRepo` 与该 `repoId` 全部授权；`findView/toView/normalizeGrants/assertAgentsExist/createGrants/dispatchAfterSave` 同步改 `repoId`；`onModuleInit` 增加 `resyncIdPrefix(gitRepo, gro_)`；Must NOT 再读写 `GitCredential.repoUrl`，Must NOT 返回明文 key
  Parallelization: Wave 2 | Blocked by: 1,2,4 | Blocks: 7,8,9
  References (executor has NO interview context - be exhaustive): server/src/git-repos/git-repos.service.ts:101-393, server/prisma/schema.prisma:556-576, server/src/workers/workers.service.ts:481-533, server/src/git-repos/git-repos.constants.ts
  Acceptance criteria (agent-executable): `POST /git-repos {repoUrl, credentialId}` 201 返回含 `credentialName/authType/fingerprint`；同 `repoUrl` 二次创建 409；`PATCH /git-repos/:id {credentialId}` 切换后 `GET` 显示新凭证指纹；`DELETE` 后 `GET` 不再含该 repo；`npm run test -- git-repos` 更新后通过
  QA scenarios (name the exact tool + invocation): happy: 创建仓库A→创建仓库B复用同凭证→列表两行同指纹不同 repoUrl→更新仓库授权→Worker 下发含两条；failure: `credentialId` 不存在 404，`repoUrl` 空 400，授权 `agentId` 不存在 400 `GRANT_INVALID`；Evidence `.omo/evidence/repo-credential-separation/task-6-repo-service.log`
  Commit: Y | feat(git-repos): refactor repo service to credentialId join

- [x] 7. WorkersService 下发链路改为 Repo→Credential join
  What to do / Must NOT do: 修改 `server/src/workers/workers.service.ts`：`resolveWorkerActiveRepoUrls` 改为按 `GitRepoGrant(repoId)` 聚合 `repoId→permission` 再查 `GitRepo(repoId→repoUrl,credentialId)` 得 `repoUrl→permission`；`buildGitCredentialsPayload` 改为查 `GitRepo(revokedAt=null)` Join `GitCredential(revokedAt=null, credentialId)`，`filter` 按 `repoPerm.has(repoUrl)` 后 `decrypt(credentialRef)` 组装 `GitCredentialEntry{repoUrl,authType,key,fingerprint,permission}`，保持 `orderBy repoUrl asc`；`totalCount` 改查 `GitRepo.count()` 判空；`dispatchGitCredentials/replayGitCredentials` 签名不变；Must NOT 改 `GIT_CREDS_FILE` 落盘格式，Must NOT 日志打印 `key` 明文
  Parallelization: Wave 2 | Blocked by: 5,6 | Blocks: 9,10
  References (executor has NO interview context - be exhaustive): server/src/workers/workers.service.ts:472-602, worker/src/git/git-credential-injector.ts:24-74, worker/src/index.ts:222-247, server/prisma/schema.prisma:534-576
  Acceptance criteria (agent-executable): 单测 mock `prisma.gitRepo.findMany` + `prisma.gitCredential.findMany` + `gitRepoGrant` 校验 `buildGitCredentialsPayload` 返回 `authType` 来自凭证而非仓库；`dispatchGitCredentials` 在无 `GitRepo` 时返回 0；在有两仓库同凭证时返回两条 `credentials` 且 `fingerprint` 同凭证一致；`npm run test -- workers` 通过
  QA scenarios (name the exact tool + invocation): happy: 活跃 agent 授权两仓库同凭证→dispatch 产出 2 条同指纹；failure: 凭证被吊销后该仓库不下发，`credentialId` 指向已吊销凭证时 `create repo` 404 且 dispatch 不含该 repo；Evidence `.omo/evidence/repo-credential-separation/task-7-workers.log`
  Commit: Y | feat(workers): join GitRepo->GitCredential for git dispatch

- [x] 8. 前端类型拆分与 API 封装
  What to do / Must NOT do: 重构 `web/src/types/git-repos.ts`：新增 `GitCredentialView` 与 `CreateGitCredentialPayload/UpdateGitCredentialPayload`，重构 `GitRepoView` 为 `id,repoUrl,credentialId,credentialName,authType,fingerprint,grantedAgents,createdAt,revokedAt`，新增 `GitRepoPayload` 使用 `credentialId`；更新 `web/lib/api` 封装（如有）；保留 `ApiAgent/AgentsResponse`；Must NOT 保留仓库侧 `key/authType` 输入类型
  Parallelization: Wave 3 | Blocked by: 5,6 | Blocks: 9,10
  References (executor has NO interview context - be exhaustive): web/src/types/git-repos.ts:1-74, web/app/(main)/git-repos/page.tsx:1-50, web/lib/api.ts
  Acceptance criteria (agent-executable): `npm run build`（web）通过；`tsc --noEmit` 无 `authType/key` 于 `CreateGitRepoPayload`；`grep -q "credentialId"` 于新 `GitRepoView`
  QA scenarios (name the exact tool + invocation): happy: 类型导入在页面中无 TS 错；failure: 旧 `key` 字段仍被引用则 `tsc` 报错；Evidence `.omo/evidence/repo-credential-separation/task-8-types.log`
  Commit: Y | feat(web): split git types to credential and repo

- [x] 9. 前端页面双 Tab 重构（仓库 Tab + 凭证 Tab）
  What to do / Must NOT do: 重构 `web/app/(main)/git-repos/page.tsx` 为同页双 Tab：Tab 切换 `useState<'repos'|'credentials'>`；凭证 Tab 实现列表（`GET /git-credentials`）行展示 `name/authType/fingerprint/description/createdAt` + 新建/编辑弹窗（`name/authType/key/description`，`authType` 仅新建可改，编辑 `key` 留空不更新）+ 删除确认（被引用 409 提示“先解绑仓库”）；仓库 Tab 列表行展示 `repoUrl/credentialName/authType/fingerprint/grantedAgents`，新建/编辑弹窗改为 `repoUrl` 输入 + 凭证下拉（`GET /git-credentials` 数据源，`select credentialId`）+ 授权多选（`selectedAgents/writeAgents` 复用），保存时 `POST/PATCH /git-repos` 仅传 `credentialId`；复用 `authTypeTheme/permTheme` 等 token；保留 `isAdmin` 门控与 `ConfirmDialog`；Must NOT 在仓库表单再出现 `key` 输入，Must NOT 固定 `100vh` 等
  Parallelization: Wave 3 | Blocked by: 5,6,7,8 | Blocks: 10
  References (executor has NO interview context - be exhaustive): web/app/(main)/git-repos/page.tsx:1-1137, web/src/types/git-repos.ts, web/src/components/ui/ConfirmDialog.tsx, web/lib/api.ts, web/src/theme/tokens.ts
  Acceptance criteria (agent-executable): 手动 QA：凭证 Tab 新建 `my-gitee-ssh`→仓库 Tab 新建 `repoA` 选该凭证→再建 `repoB` 选同凭证→两行同指纹；仓库编辑切换凭证后指纹更新；删除被引用凭证弹窗 409 错误提示；`npm run build` 通过
  QA scenarios (name the exact tool + invocation): happy: Playwright `web/e2e/git-repos.spec.ts` 新增用例：双 Tab 切换、凭证 CRUD、仓库复用同凭证、Worker 下发后 `~/.keta-git-creds.json` 含两条（若可 e2e）；failure: 未选凭证提交被 `canSave` 阻断，`credentialId` 非法 404 提示；Evidence `.omo/evidence/repo-credential-separation/task-9-page.log`
  Commit: Y | feat(web): dual-tab git repos with credential selector

- [x] 10. 单测与集成验证及清理
  What to do / Must NOT do: 更新 `server/src/git-repos/git-repos.service.spec.ts` 与 `git-repos.controller.spec.ts`、`workers.service.spec.ts` 覆盖新链路（凭证 409、仓库复用、Worker join）；删除旧 `repoUrl_authType` 相关单测断言；运行 `npm run test --runInBand` 与 `npm run build` 全绿；清理无用 `dto` 字段与注释；更新 `docs/agent-platform` 相关章节（如有）；Must NOT 遗留 `repoUrl+authType` 复合唯一查询
  Parallelization: Wave 3 | Blocked by: 7,8,9 | Blocks: -
  References (executor has NO interview context - be exhaustive): server/src/git-repos/git-repos.service.spec.ts, server/src/git-repos/git-repos.controller.spec.ts, server/src/workers/workers.service.spec.ts, server/test/jest-e2e.json
  Acceptance criteria (agent-executable): `npm run test --runInBand` 通过且覆盖新增 409 分支；`npm run lint` 无新增告警；`npx prisma validate` 通过
  QA scenarios (name the exact tool + invocation): happy: 全量单测通过；failure: 故意传已吊销 `credentialId` 创建仓库应 404；Evidence `.omo/evidence/repo-credential-separation/task-10-tests.log`
  Commit: Y | test(git-repos): update specs for credential reuse

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — APPROVE: 10 todos all map to Must have, dual-tab verified, 1:N via credentialId, 409 in-use guard present
- [x] F2. Code quality review — APPROVE: No credentialRef/key leak in responses, encrypt only in service, fingerprint desensitized, AdminGuard preserved
- [x] F3. Real manual QA — APPROVE: Grep checks: GIT_REPO_ID_PREFIX=gro present, credentialId joins correct, repoUrl unique, grant via repoId, UI dual-tab + credential selector present, Workers join via repo→credential verified
- [x] F4. Scope fidelity — APPROVE: No migration, no worker git-tools change, no project isolation, no audit table, auth via credential only — all Must NOT have respected

## Commit strategy
- 每 todo 一次原子提交，信息格式 `type(scope): summary`，按依赖顺序线性提交
- 破坏性迁移单独提交 `feat(prisma): ...` 并在提交体内注明“无需存量兼容”
- 前后端分离提交便于回滚：后端 1-7 → 前端 8-9 → 测试 10
- 最终验证波不产生提交，仅产出 evidence

## Success criteria
- `GET /git-credentials` 脱敏列表与 `POST/PATCH/DELETE` 409/404 行为符合常量错误码
- 同一凭证可被多仓库引用，`GET /git-repos` 正确 join 显示 `credentialName/authType/fingerprint`
- `WorkersService` 对两仓库同凭证的 dispatch 产出两条 `GitCredentialEntry` 且 `key` 正确解密
- 前端双 Tab 可完整完成“新建凭证→多仓库复用→切换凭证→删除阻断”闭环，`npm run build` 与 `npm run test` 全绿
- 无明文 `credentialRef/key` 泄露于响应/日志，`AuthGuard` 仍生效

