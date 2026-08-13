# git-repo-credentials - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST -->

**What you'll get:** 平台新增「仓库管理」功能：管理员在网页上录入 git 仓库地址 + 认证方式（SSH 私钥或 HTTPS token）+ 授权给指定 Agent，之后这些 Agent 在任务里就能直接 clone / pull / push 授权仓库，凭证全程加密存储、不进模型上下文、凭证面按 worker 隔离（按 worker 过滤下发），git_push 默认需成员确认。

**Why this approach:** 完整落地 `docs/agent-platform/17-仓库权限与凭证机制.md` 三层设计（凭证管理 → git 工具族 → 注入与清理），复用现有模型凭据的加密/下行命令/幂等落盘全链路模板，UI 配置驱动（不依赖 GIT_SSH_KEY_PATH 环境变量）。授权校验在 server 下发时完成（按 worker 过滤，凭证面最小），git 工具 execute 只读白名单文件——因为工具 ToolContext 拿不到平台 Agent id。

**What it will NOT do:** 不做 role/project 粒度授权（schema 预留字段）、不做 Agent 级隔离（凭证面=worker 级，同 worker 上所有 agent 共享已下发凭证）、不做 ssh-agent 长驻会话注入、不做 bash 裸 git 命令的凭证兜底覆盖（仅内置工具族注入面）、不做 OAuth 代持 / KMS。

**Effort:** Large
**Risk:** Medium - 凭证明文在 worker 落盘（600 权限保护，与模型凭据 auth.json 同模式），执行期凭证面控制依赖 server 打包正确性

**Decisions to sanity-check:** ① 授权仅 Agent 实例粒度（role/project 预留）；② SSH + HTTPS 都支持；③ 按 worker 授权过滤下发（凭证面=worker 级）；④ 凭证文件 `~/.keta-git-creds.json` 明文落盘 600 权限（仿 auth.json 模式）；⑤ 写操作权限用 AdminGuard（仿 models 模块），GET 成员只读；⑥ 活跃 agent 判定 = TaskAgent.removedAt=null 且任务未终态；⑦ 幂等对比按 repoUrl 排序；⑧ 容器装 git+openssh-client。

Your next move: approve, or run a high-accuracy review. Full execution detail follows below.

---

> TL;DR (machine): Large effort, Medium risk - 6 todos across 5 waves; schema/迁移 + server API + worker 命令 + git.ts 注入升级 + web 页 + 端到端；复用模型凭据链路模板。

## Scope

### Must have

1. **schema**：`GitCredential` + `GitRepoGrant` 两模型 + Prisma 迁移
   - GitCredential：id(`gc_`)、repoUrl、authType(`ssh_key`|`https_token`)、credentialRef(Text, AES-256-GCM 密文)、fingerprint、createdBy、createdAt、updatedAt、revokedAt；`@@unique([repoUrl, authType])`
   - GitRepoGrant：id(`gr_`)、agentId、repoUrl、permission(`read`|`write`)、effect(`allow`|`ask`)、grantedBy、grantedAt、revokedAt；`@@unique([agentId, repoUrl])`；`@@index([agentId])`、`@@index([repoUrl])`
   - 模型前缀对齐 `resyncIdPrefix` 模式（仿 `MODEL_CREDENTIAL_ID_PREFIX='mc'`）
2. **server git-repos 模块**：CRUD + 加密存储 + 授权维护 + 保存后按 worker 过滤下行
   - API：`GET /git-repos`、`POST /git-repos`、`PATCH /git-repos/:id`、`DELETE /git-repos/:id`（软撤销）
   - 加密复用 `CredentialCryptoService`（encrypt/decrypt/fingerprint）
   - 保存后调 `WorkersService.dispatchGitCredentials`（新方法）：按 worker 承载活跃 agent 的授权仓库打包 → enqueueCommand
   - worker offline→online 回放（仿 `replayModelCredentials`）
   - 权限：GET 成员只读；写操作（POST/PATCH/DELETE）挂 `AdminGuard`（仿 models 模块）
3. **worker 下行命令 + 落盘**：`git-credentials` 命令 → 幂等写 `~/.keta-git-creds.json`（600 权限，**不重启 serve**）
   - worker-protocol.ts 双写 `GIT_CREDENTIALS: 'git-credentials'` + `GitCredentialsPayload` + 类型
   - index.ts `onCommands` 加分支 → `handleGitCredentials`（内容对比幂等，仿 `handleModelCredentials` 但不重启）
4. **注入 git.ts 升级**：execute 读凭证文件 → 白名单 + write 授权校验 → SSH 走 GIT_SSH_COMMAND 临时 key / HTTPS 走 GIT_ASKPASS 临时脚本 → spawn git → try/finally 清理
   - `renderGitToolsFile` 内联凭证处理辅助函数（读文件/临时 key 写入/askpass 脚本/清理/URL 规范化）
   - repo_url 规范化：去 `.git` 后缀（17 篇 §3.1）
   - push 需 `permission=write`（凭证条目含 permission），clone/pull/fetch/status/diff/log 需 read
5. **web 仓库管理页**：nav 入口 + 页面（列表 + 配置弹窗 + 删除确认），风格照 models 页
   - nav-dock.tsx NAV_ITEMS 加 `{ key: "git-repos", label: "仓库管理", icon: "⌗" }`
   - 路由 `web/app/(main)/git-repos/page.tsx`
   - 列表行：repoUrl + authType 徽章（SSH=蓝/HTTPS=紫）+ fingerprint + 授权 agents 标签 + 状态徽章（已配置/已撤销）+ 操作（配置/删除）
   - 配置弹窗：repoUrl + authType 下拉（切换 SSH textarea / HTTPS password）+ 授权 agent 多选（checkbox 列表）+ 保存
   - 删除确认 ConfirmDialog
6. **端到端验证**：部署后 UI 配仓库（SSH 私钥 + 授权 a_tester）→ 任务 @测试 → git_clone 授权仓库成功；未授权仓库（未授权给任何 agent）调用被拒

### Must NOT have (guardrails, anti-slop, scope boundaries)

- **不做** role/project 授权主体（GitRepoGrant 仅 agentId 字段，subject_type 不引入；schema 注释预留）
- **不做** Agent 级隔离（凭证面=worker 级：server 按 worker 承载的活跃 agent 过滤下发，工具层只按 repoUrl 白名单校验；同 worker 上所有 agent 共享已下发凭证——opencode 单 serve 多 session 无法在工具层区分平台 agentId，agent 级隔离需架构扩展，属后续迭代）
- **不做** ssh-agent 进程长驻与 shell.env 注入（17 篇 §6.1 方式②）
- **不做** credential helper 全局 git config（bash 裸 git 命令的 HTTPS 兜底）——本版仅内置 git 工具族注入面（GIT_ASKPASS 单命令注入）
- **不做** GIT_SSH_KEY_PATH 环境变量接线（用户明确不依赖）
- **不修改** opencode 本体、不新增 worker 入站端点（凭证经既有心跳下行通道）
- **不引入** 新外部依赖（Dockerfile `apk add git openssh-client` 为系统包，非应用依赖）
- **不删除** 现有 git-tools 的 7 工具定义与默认 effect（push=ask 保持）
- **凭证明文**不写入日志/审计/响应（fingerprint 脱敏），模型上下文不见明文

## Verification strategy

> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after**（仓库现有模式：实现后补 spec）+ jest（server/worker）+ 端到端 API/容器实测
- Evidence: `.omo/evidence/git-repo-credentials/`（各 todo 的 QA 输出落此处）

## Execution strategy

### Parallel execution waves

- **Wave 1**：todo 1（schema + 迁移）—— 基础，阻塞其余
- **Wave 2**：todo 2（server git-repos 模块 + 下行命令封装）—— 依赖 1
- **Wave 3**：todo 3（worker 命令消费落盘）+ todo 4（git.ts 注入升级）—— 均依赖 2 的契约（凭证文件格式 + 下行 payload），3 与 4 可并行（3 写文件、4 读文件，契约在 todo 2 定义）
- **Wave 4**：todo 5（web 仓库管理页）—— 依赖 2 的 API
- **Wave 5**：todo 6（端到端验证）—— 依赖全部

### Dependency matrix

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. schema+迁移 | — | 2,3,4,5 | — |
| 2. server 模块 | 1 | 3,4,5 | — |
| 3. worker 命令落盘 | 2 | 6 | 4 |
| 4. git.ts 升级 | 2 | 6 | 3 |
| 5. web 页 | 2 | 6 | — |
| 6. 端到端 | 1-5 | — | — |

## Todos

- [x] 1. schema：GitCredential + GitRepoGrant 模型 + Prisma 迁移
  What to do / Must NOT do:
  - `server/prisma/schema.prisma` 追加两个 model（放在 ModelCredential 段附近）：
    - `GitCredential`：`id String @id`、`repoUrl String @map("repo_url")`、`authType String @map("auth_type")`、`credentialRef String @db.Text @map("credential_ref")`、`fingerprint String`、`createdBy String @map("created_by")`、`createdAt DateTime @default(now()) @map("created_at")`、`updatedAt DateTime @updatedAt @map("updated_at")`、`revokedAt DateTime? @map("revoked_at")`；`@@unique([repoUrl, authType], map: "uk_git_credentials_repo_auth")`；`@@map("git_credentials")`
    - `GitRepoGrant`：`id String @id`、`agentId String @map("agent_id")`、`repoUrl String @map("repo_url")`、`permission String`、`effect String`、`grantedBy String @map("granted_by")`、`grantedAt DateTime @default(now()) @map("granted_at")`、`revokedAt DateTime? @map("revoked_at")`；`@@unique([agentId, repoUrl], map: "uk_git_repo_grants_agent_repo")`；`@@index([agentId], map: "idx_git_repo_grants_agent")`；`@@index([repoUrl], map: "idx_git_repo_grants_repo")`；`@@map("git_repo_grants")`
  - 生成迁移：`npx prisma migrate dev --name git_repo_credentials`（server 目录）→ 迁移 SQL 含两表 CREATE + 唯一索引
  - 在 models.service.ts 同款 `onModuleInit` 加 `resyncIdPrefix(this.prisma.gitCredential, 'gc', this.idGen)` 与 `resyncIdPrefix(this.prisma.gitRepoGrant, 'gr', this.idGen)`（`resyncIdPrefix(model, prefix, idGen)` 是 `server/src/common/id-resync.ts` 的通用函数，**无注册表**，直接在 onModuleInit 调用即可，仿 models.service.ts:78-85）
  - Must NOT：不加 FK 关系（repoUrl 逻辑关联，仿 ModelCredential 无 FK 模式）、不加 subject_type 字段（role/project 预留仅注释）
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3,4,5
  References:
  - `server/prisma/schema.prisma:421-437`（ModelCredential 仿写模板）
  - `server/src/models/models.service.ts:77-85`（onModuleInit resyncIdPrefix 模式）
  - `server/src/common/id-resync.ts:26`（resyncIdPrefix 通用函数定义——无注册表，勿去找）
  - `server/prisma/migrations/20260811090000_credential_ref_text/migration.sql`（迁移文件格式参照）
  Acceptance criteria (agent-executable):
  - `cd server && npx prisma migrate dev --name git_repo_credentials` 成功；`npx prisma generate` 成功
  - `npx tsc --noEmit` 0 错误
  - 实际 DB 验证：`SHOW COLUMNS FROM aiagents.git_credentials` 含 9 列；`SHOW COLUMNS FROM aiagents.git_repo_grants` 含 8 列；`SHOW INDEX FROM git_credentials` 含 uk_git_credentials_repo_auth
  QA scenarios (name the exact tool + invocation):
  - happy: 迁移 + generate + typecheck 全过（Evidence `.omo/evidence/git-repo-credentials/task-1-migrate.txt`，记录三命令输出）
  - failure: `npx prisma validate` 通过（模型语法正确）；重复跑 migrate dev 无 pending（幂等）
  Commit: Y | `feat(git-repos): git 仓库凭证与授权模型`

- [x] 2. server git-repos 模块：CRUD + 加密存储 + 授权维护 + 按 worker 过滤下行
  What to do / Must NOT do:
  - 新建 `server/src/git-repos/` 目录：`git-repos.module.ts`、`git-repos.controller.ts`、`git-repos.service.ts`、`dto/create-git-repo.dto.ts`、`dto/update-git-repo.dto.ts`、`git-repos.constants.ts`（错误码 + id 前缀）
  - `GitReposController`（`@Controller('git-repos')`，全局前缀 `/api/v1`）：
    - `GET /git-repos`：**成员只读**（不挂守卫，与 models GET 一致）——列表 = 未吊销凭证 + 每条附 `grantedAgents: [{agentId, name, permission, effect}]`（join GitRepoGrant revokedAt=null + Agent.name）
    - `POST /git-repos`（**AdminGuard**，仿 models 写操作）：body `{repoUrl, authType, key, grantedAgents: [{agentId, permission, effect}]}` → 校验 authType ∈ {ssh_key, https_token}、repoUrl 规范化（去 .git、trim）→ `credentialCrypto.encrypt(key)` 存 GitCredential + fingerprint → 批量 upsert GitRepoGrant（同 agentId+repoUrl 覆盖 permission/effect；缺省 effect：read→allow、write→ask，对齐 16 篇）→ 保存后 `dispatchGitCredentials()` → 返回 View（脱敏）
    - `PATCH /git-repos/:id`（**AdminGuard**）：body `{key?, grantedAgents?}` → key 提供则重加密覆盖 credentialRef/fingerprint；grantedAgents 提供则全量覆盖授权（先软撤旧 → 写新）
    - `DELETE /git-repos/:id`（**AdminGuard**）：软撤销（revokedAt=now）+ 该 repoUrl 全部 grants 软撤销 → dispatchGitCredentials() 清下发
  - `GitReposService`：依赖 `PrismaService`、`IdGeneratorService`（来源：`GitReposModule` 须 `imports: [RealtimeModule, forwardRef(() => WorkersModule)]`——IdGeneratorService 由 RealtimeModule 导出，仿 models.module.ts）、`CredentialCryptoService`、`WorkersService`（forwardRef 仿 ModelsService）；`onModuleInit` resyncIdPrefix（若 todo 1 未做则此处做）；View 组装（绝不返回 credentialRef/key 明文，只有 fingerprint）
  - `WorkersService` 新增：
    - `dispatchGitCredentials(targetWorkerIds?)`：查未吊销 GitCredential + 授权 GitRepoGrant → 对每个在线 worker 查其**活跃 agent**（判定：`prisma.taskAgent.findMany({where:{agentId, removedAt:null}, select:{agentId:true}})` 且该 agent 关联的 task 未终态——或等价的 session 活跃过滤，见 todo 6 单测断言）→ 收集这些 agent 被授权且未吊销的 repoUrl → 对应凭证 → 解密明文打包 `GitCredentialsPayload` → enqueueCommand（type=`git-credentials`）→ 返回下发 worker 数。**查库时 `orderBy: [{ repoUrl: 'asc' }]` 保证幂等对比稳定**
    - `replayGitCredentials(workerId)`：offline→online 心跳时调用（仿 `replayModelCredentials` 在 workers.service.ts:312 处并排挂接）
    - 注意：凭证明文只在命令 payload 内存流转，不落日志
  - `server/src/app.module.ts` 注册 GitReposModule
  - **权限说明**：写操作挂 `AdminGuard`（判定 `permissions.all || permissions.users.manage`，仿 models 模块 models.controller.ts）；不扩展 PermissionGuard 权限矩阵（PERMISSION_RESOURCES 固定 8 资源，git-repos 不加入）
  - Must NOT：不在任何响应/日志中出现 key 明文；不删除模型凭据链路；git-credentials 命令 type 常量加在 server 侧 `WORKER_COMMAND_TYPES`（定义于 `server/src/workers/workers.service.ts:62-90`）
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 3,4,5
  References:
  - `server/src/models/models.service.ts`（CRUD + 加密 + View 脱敏全模板）
  - `server/src/models/models.controller.ts`（controller + DTO + **AdminGuard** 权限模式）
  - `server/src/models/models.module.ts`（imports RealtimeModule 提供 IdGeneratorService + forwardRef WorkersModule 模式）
  - `server/src/workers/workers.service.ts:332-416`（enqueueCommand / dispatchModelCredentials / replayModelCredentials 模板）+ `:62-90`（**WORKER_COMMAND_TYPES 双写点**——加 GIT_CREDENTIALS + GitCredentialsPayload 接口，非独立 constants 文件）
  - `server/src/common/credential-crypto.service.ts`（encrypt/decrypt/fingerprint；**git 凭证与模型凭据共享 MODEL_CREDENTIAL_KEY**——不新增 GIT_CREDENTIAL_KEY 配置）
  - `server/src/app.module.ts`（模块注册）
  - `server/src/common/guards/admin.guard.ts`（AdminGuard 判定逻辑）
  Acceptance criteria (agent-executable):
  - `npx tsc --noEmit` 0 错误
  - `npx jest --runInBand src/git-repos/` 新建 spec 全绿（service 单测：创建加密+指纹、授权 upsert、列表脱敏、吊销、dispatch 打包过滤；controller 单测：admin 权限 + DTO 校验 + 404/400）
  - 手动 API 冒烟（curl + admin token）：POST 创建 → GET 列表含 grantedAgents → PATCH 更新授权 → DELETE 软撤销 → 列表消失
  QA scenarios (name the exact tool + invocation):
  - happy: POST 创建后 `SELECT fingerprint FROM git_credentials` 为脱敏值；GET 响应无 key 字段（Evidence `.omo/evidence/git-repo-credentials/task-2-api.txt`）
  - failure: POST authType 非法 → 400；重复 POST 同 repoUrl+authType → 409 或覆盖（按实现选择，建议唯一约束冲突 409）；未授权 agent 打包时该仓库不出现在下发 payload
  Commit: Y | `feat(git-repos): 仓库凭证管理 API 与按 worker 过滤下发`

- [x] 3. worker git-credentials 命令消费 + 幂等落盘凭证文件
  What to do / Must NOT do:
  - `worker/src/protocol/worker-protocol.ts`：`WORKER_COMMAND_TYPES` 加 `GIT_CREDENTIALS: 'git-credentials'`；新增 `GitCredentialEntry {repoUrl, authType, key, fingerprint}` 与 `GitCredentialsPayload {credentials: GitCredentialEntry[]}` 接口（与 server 侧 payload 结构一致，contract.spec.ts 校验双写一致）
  - 新建 `worker/src/git/git-credential-injector.ts`（仿 model-credential-injector）：
    - `GIT_CREDS_FILE` 常量：`path.join(os.homedir(), '.keta-git-creds.json')`
    - `buildGitCredsFile(entries)`：**先按 repoUrl 升序排序**（幂等对比稳定）→ JSON `{version:1, updatedAt, credentials:[{repoUrl, authType, key, fingerprint}]}`（空条目跳过）
    - `writeGitCredsFile(entries)`：writeFileSync mode 600 + chmodSync 600（homedir 已存在无需 mkdir）
    - `readGitCredsFile(path)`：读文件 → JSON.parse；不存在/解析失败 → null
    - `cleanupGitCredsFile(path)`：rmSync force
  - `worker/src/index.ts`：`onCommands` 加 `GIT_CREDENTIALS` 分支 → `handleGitCredentials(payload.credentials, deps)`：
    - 读现有文件 → build 新内容（排序后）→ 内容一致则跳过（幂等，防重复下发重启循环——**本命令不重启 serve**，只写文件）
    - 不一致 → 写新文件（600）→ 日志 `[worker] git-credentials：凭证文件已更新（N 条）`
    - deps 注入面（单测 mock 文件 IO）：`readContent / writeContent / log / warn`
  - worker 单测 `git-credential-injector.spec.ts` + `index.spec.ts` 分支用例（幂等 / 更新 / 空负载跳过 / **乱序输入仍幂等**）
  - Must NOT：不触发 serve 重启（与 model-credentials 不同，git 工具每次执行读文件，无需重启）；不写日志明文 key；不引入新 env 配置
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: 6 | Can parallelize with: 4
  References:
  - `worker/src/credentials/model-credential-injector.ts`（写文件 600 + cleanup 模板）
  - `worker/src/index.ts:465-515`（onCommands 消费模板 + handleModelCredentials 幂等模式）
  - `worker/src/protocol/worker-protocol.ts:92-147`（WORKER_COMMAND_TYPES + WorkerCommand + payload 双写）
  - `worker/src/exec/artifact-extract.ts`（worker 侧新模块文件组织参照）
  Acceptance criteria (agent-executable):
  - `cd worker && npx tsc --noEmit` 0 错误；`npx jest --runInBand` 全绿（新增 spec 覆盖幂等/更新/空负载）
  - 手动：向 worker 心跳下发 git-credentials 命令（server 侧 enqueueCommand 触发）→ 容器内 `ls -la ~/.keta-git-creds.json` 权限 600 → 内容含 credentials 数组
  QA scenarios (name the exact tool + invocation):
  - happy: 写入后 `stat -c %a ~/.keta-git-creds.json` = 600（Evidence `.omo/evidence/git-repo-credentials/task-3-creds-file.txt`）
  - failure: 相同 payload 二次下发 → 文件 mtime 不变（幂等跳过）；空 credentials 数组 → 不写空文件
  Commit: Y | `feat(git-repos): worker 消费 git-credentials 下行命令并落盘`

- [x] 4. 注入 git.ts 升级：白名单校验 + SSH/HTTPS 注入 + 清理
  What to do / Must NOT do:
  - 修改 `worker/src/git/git-tools.ts` 的 `renderGitToolsFile`：
    - 生成的 git.ts 增加凭证读取/注入辅助函数（内联，**不 import worker 源码**——工具文件由 opencode 独立执行）：
      - `normalizeRepoUrl(u)`：trim + 去尾部 `.git` + 统一协议小写（对比用）
      - `loadCredential(repoUrl)`：读 `~/.keta-git-creds.json` → 找 `normalizeRepoUrl(entry.repoUrl) === normalizeRepoUrl(repoUrl)` 且 authType 匹配 → 返回 entry（含 permission）；文件缺失/无匹配 → throw `仓库未授权或凭证缺失: <repoUrl>`（错误信息**不含明文 key**）
      - `writeTempCred(key, kind)`：`os.tmpdir()/keta-git-<rand>`（SSH 私钥）或 `keta-askpass-<rand>`（HTTPS 脚本）；SSH 写 key 600；HTTPS 写 `#!/bin/sh\necho '<token>'` 600 + chmod 755——**token 转义：`'` → `'\''`**（防单引号破坏脚本/注入）
      - `cleanupTemp(path)`：rmSync force（finally 调用）
      - `buildGitEnv(entry)`：ssh_key → `{GIT_SSH_COMMAND: "ssh -i <tmpKey> -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"}`；https_token → `{GIT_ASKPASS: <tmpScript>, GIT_TERMINAL_PROMPT: '0'}`
    - `runGit(args, env)`：`spawnSync("git", args, {encoding:'utf8', env: {...process.env, ...env}})`，非 0 退出抛错（含 stderr）
    - 每个工具 execute 模板改为：`loadCredential(repo_url 或 cwd origin)` → push 额外校验 `entry.permission === 'write'`（clone/pull/fetch/status/diff/log 只需有凭证即可 read）→ buildGitEnv → spawn → finally cleanupTemp
    - 工具描述更新：git_clone 说明"需平台仓库授权"；git_push 说明"需 write 授权"
  - **`worker/Dockerfile` 加 `RUN apk add --no-cache git openssh-client`**（node:22-alpine 基础镜像不含 git/ssh，runGit/GIT_SSH_COMMAND 依赖容器内二进制；todo 6 前置 `git --version`/`ssh -V` 验证）
  - `git-tools.spec.ts` 更新：断言渲染内容含凭证读取逻辑（`keta-git-creds.json` / GIT_SSH_COMMAND / GIT_ASKPASS 关键字）；辅助函数单测（normalizeRepoUrl 去 .git、**含单引号 token 转义**）
  - Must NOT：不 import worker src（工具文件自包含）；不把凭证明文放进返回给模型的结果/错误信息；不改变 7 工具名与默认 effect；`installGitTools` 签名不变
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: 6 | Can parallelize with: 3
  References:
  - `worker/src/git/git-tools.ts`（renderGitToolsFile 现状 + GIT_TOOLS 定义）
  - `worker/src/git/git-tools.spec.ts`（测试更新点）
  - `worker/src/git/git-credentials.ts`（createTempKey 600 权限/cleanup 幂等逻辑——内联进渲染模板）
  - opencode ToolContext 事实：execute(args, ctx) 中 ctx 无平台 agentId，凭证面由 server 下发白名单控制（17 篇 §5.1 的"先授权后取凭证"落点）
  Acceptance criteria (agent-executable):
  - `cd worker && npx tsc --noEmit` 0 错误；`npx jest --runInBand src/git/git-tools.spec.ts` 全绿
  - 端到端预演（见 todo 6 正式）：容器内手工构造 `~/.keta-git-creds.json`（含测试仓库条目）→ `opencode` 内调 git_clone 该仓库 → 成功 clone；不存在的仓库 → 报"未授权"
  QA scenarios (name the exact tool + invocation):
  - happy: git.ts 渲染内容含 GIT_SSH_COMMAND 与 GIT_ASKPASS 分支 + 凭证文件路径（Evidence `.omo/evidence/git-repo-credentials/task-4-render.txt`）
  - failure: 凭证文件缺失 → execute 抛错且错误信息不含明文 key；HTTPS 分支 askpass 脚本 chmod 后 git 能认证
  Commit: Y | `feat(git-repos): 注入 git 工具凭证注入与授权校验`

- [x] 5. web 仓库管理页：nav 入口 + 列表/配置弹窗/删除
  What to do / Must NOT do:
  - `web/src/components/layout/nav-dock.tsx`：NAV_ITEMS 加 `{ key: "git-repos", label: "仓库管理", icon: "⌗" }`（放在 models 后）
  - **`web/src/components/layout/app-shell.tsx` 同步三处**（独立硬编码映射，不改则点击无跳转/不高亮/Cmd+K 无入口）：
    - `KEY_TO_PATH`（:101-110）加 `git-repos: "/git-repos"`
    - `CMDK_NAV_PATH`（:140-149）加 `仓库管理: "/git-repos"`
    - `NAV_VISIBLE`（:157-163）：仿 models 不加条目 = 始终显示（成员只读 + admin 操作）
  - 新建 `web/app/(main)/git-repos/page.tsx`（"use client"，风格照 models/page.tsx：flex:1 + 白卡容器 + 表头行 + 数据行 + 空态 + 底部说明）：
    - 数据源：`useQuery(["git-repos"], GET /git-repos)` + `useQuery(["agents"], GET /agents)`（授权多选数据源）
    - 列表行 `GitRepoRow`：repoUrl（mono）+ authType 徽章（SSH=蓝 `{label:"SSH", color:"#2563EB", bg:"#EFF6FF", border:"#BFDBFE"}` / HTTPS=紫 `{color:"#7C3AED", bg:"#F5F3FF", border:"#DDD6FE"}`）+ fingerprint（mono）+ 授权 agents（tag 列表：agent 名 + permission 徽章 read/write）+ 状态徽章（已配置绿/已撤销琥珀，仿 credentialTheme）+ 操作（配置/删除 admin 专属）
    - 配置弹窗 `GitRepoModal`（仿 ConfigureModal）：repoUrl 输入 + authType 下拉（切换 SSH textarea 私钥 / HTTPS password token）+ 授权 agents 多选（checkbox 列表，每项显示 agent 名）+ permission/effect 简化：read=allow 默认、write 复选框（勾选 = write+ask）；保存 → POST /git-repos（新建）或 PATCH（更新）
    - 删除：ConfirmDialog → DELETE /git-repos/:id → invalidate ["git-repos"]
    - 权限：isAdmin（roleName==='admin'）控制配置/删除，成员只读（后端守卫兜底）
  - `web/src/types/git-repos.ts`：`GitRepoView {id, repoUrl, authType, fingerprint, revokedAt, grantedAgents:[{agentId, name, permission, effect}], createdAt}` + `CreateGitRepoPayload` + `UpdateGitRepoPayload`
  - 铁律：无 fixed/100vh/100vw；root flex:1；token 引用 `@/src/theme/tokens`
  - Must NOT：不新装 UI 库（纯内联 style 与现有一致）；不改 models 页；不在页面展示明文 key
  Parallelization: Wave 4 | Blocked by: 2 | Blocks: 6
  References:
  - `web/app/(main)/models/page.tsx`（页面结构/徽章/白卡/搜索/空态全模板）
  - `web/app/(main)/models/providers-tab.tsx`（ConfigureModal/ConfirmDialog/worker 多选模式——agents 多选仿此）
  - `web/src/components/layout/nav-dock.tsx:35-44`（NAV_ITEMS 追加点）
  - **`web/src/components/layout/app-shell.tsx:101-110,140-149,157-163`（KEY_TO_PATH / CMDK_NAV_PATH / NAV_VISIBLE 三处同步）**
  - `web/src/types/models.ts`（类型定义模式）
  - `web/lib/api.ts`（api.get/post/patch/delete 用法）
  Acceptance criteria (agent-executable):
  - `cd web && npx tsc --noEmit` 0 错误；`npm run build` 通过（或 `next build`）
  - 浏览器/curl 验证：`:13001` 访问 `/git-repos` 路由渲染列表；nav 出现「仓库管理」；点击可跳转、路径高亮、Cmd+K 有入口
  QA scenarios (name the exact tool + invocation):
  - happy: UI 走通 创建（填 repoUrl+SSH 私钥+勾选 agent）→ 列表出现该仓库（指纹脱敏、agent tag）→ 删除 → 消失（Evidence `.omo/evidence/git-repo-credentials/task-5-web.txt`，附截图/响应）
  - failure: 成员（非 admin）看不到配置/删除按钮；authType 切换表单字段正确；nav 跳转/高亮/Cmd+K 三处均生效
  Commit: Y | `feat(git-repos): 仓库管理页面`

- [x] 6. 端到端验证（全链路）
  What to do / Must NOT do:
  - 部署：`docker-compose up -d --build`（server/worker/web 重建）→ 健康检查 → **前置检查：worker 容器内 `git --version` 与 `ssh -V` 非空**（验证 Dockerfile apk add 生效）
  - 场景 A（SSH 授权成功）：admin token 调 `POST /api/v1/git-repos` 配测试仓库（SSH 私钥 + 授权 a_tester）→ 任务 @测试 → agent 调 git_clone 授权仓库 → 验证 `git_credentials` 表有密文行 + 任务消息含 clone 成功输出
  - 场景 B（未授权拒绝）：配一个**未授权给任何 agent** 的仓库（或直接不配）→ @测试 让 agent 尝试 clone 该仓库 → 工具报"仓库未授权"（该仓库凭证未下发到 worker，git.ts 白名单无匹配）；**注意：凭证面=worker 级，若某仓库授权给了同 worker 的其他 agent，则同 worker 的 a_tester 也能用（预期行为，非 bug）——场景 B 只验证"未授权给任何 agent 的仓库"**
  - 场景 C（HTTPS token）：配 HTTPS 仓库 + token → git_clone 通过 GIT_ASKPASS 认证成功（best-effort，若测试环境无 HTTPS 仓库则跳过并记录原因）
  - 场景 D（吊销即时生效）：DELETE 仓库 → 心跳后 worker 凭证文件移除该条目 → agent 再 clone → 未授权
  - 场景 E（push 确认流）：确认测试环境无 `AgentToolEffect` 将 git_push 覆盖为 allow（schema.prisma:337 按 agent 覆盖 tool effect；若被覆盖则 ask 确认不触发）→ git_push 触发 opencode ask 确认（或记录被 effect 覆盖的实际行为）
  - 验证 `~/.keta-git-creds.json` 600 权限 + 无明文泄漏到 server 日志/消息
  - Must NOT：不把真实生产凭证用于测试（用一次性测试仓库/私钥）；测试后清理测试数据
  Parallelization: Wave 5 | Blocked by: 1-5 | Blocks: —
  References:
  - 端到端 API 脚本模式（本会话既有 curl + python 解析用法）
  - `docker-compose.yml`（部署）
  Acceptance criteria (agent-executable):
  - 前置检查：worker 容器 `git --version`、`ssh -V` 非空
  - 场景 A 通过（git_clone 成功 + 落库正确 + 消息输出）
  - 场景 B 通过（未授权给任何 agent 的仓库被拒，错误可见）
  - 场景 D 通过（吊销后不可用）
  - 场景 C best-effort（跳过需记录原因）；场景 E 记录实际行为
  QA scenarios (name the exact tool + invocation):
  - happy: 全场景日志 + 消息落库查询输出至 `.omo/evidence/git-repo-credentials/task-6-e2e.txt`
  - failure: 任一场景失败 → 定位并修复（回对应 todo）后重跑
  Commit: N（验证不提交，修复并入对应 todo 的 commit）

## Final verification wave

> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.

- [x] F1. Plan compliance audit（对照本计划逐项核对：schema/API/命令/git.ts/web/端到端全部落地，范围外未混入）
- [x] F2. Code quality review（typecheck + 全量测试 + 无明文泄漏 grep：`grep -rn "privateKey\|GIT_ASKPASS.*echo\|token" server/src/git-repos worker/src/git --include="*.ts"` 应只见变量名不见硬编码值；代码风格与现有文件一致）
- [x] F3. Real manual QA（真实 UI 走一遍创建→授权→agent clone→吊销，截图留档）
- [x] F4. Scope fidelity（确认 Must NOT have 未越界：无 role/project、无 ssh-agent、无 env 接线、无新依赖）

## Commit strategy

- 一个需求一个 commit（AGENTS.md 约定）：6 个实现 todo 各对应一个 commit，全部在功能分支 `feature/git-repo-credentials` 上，基于 `xishuhq/develop`（无 develop 则默认分支）checkout
- commit message 遵循 Conventional Commits：`feat(git-repos): <摘要>`（每个 todo 的 Commit 行已给出）
- 提交前 `git fetch xishuhq` 同步 base；完成后推 `ketabot` 远端，PR 指向 `xishuhq:develop`（head=`ketabot:feature/git-repo-credentials`）
- 本仓库为 TS/TSX，无 Java → 不触发 googleJavaFormat 前置

## Success criteria

1. 管理员可在 UI 配置 git 仓库（SSH 私钥 / HTTPS token）+ 授权 Agent，凭证加密存储、fingerprint 脱敏
2. 授权 Agent 在任务内可 clone/pull/fetch/push 授权仓库（push 需 write 授权 + opencode ask 确认，除非被 AgentToolEffect 覆盖）
3. 未授权给任何 agent 的仓库凭证不落盘，git 工具调用被拒（错误可见，凭证不泄漏）
4. 吊销/撤权后 worker 侧凭证即时清除，仓库立即不可用
5. 全部单测通过；端到端场景 A/B/D 通过，场景 C best-effort（跳过需记录原因）；无明文 key 出现在日志/审计/响应/模型上下文
