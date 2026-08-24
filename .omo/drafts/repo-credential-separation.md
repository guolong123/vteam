---
slug: repo-credential-separation
status: awaiting-approval
intent: clear
review_required: false
pending-action: write .omo/plans/repo-credential-separation.md
approach: 凭证池独立(name唯一)+仓库表通过credentialId引用+授权按仓库粒度+双Tab前端+Worker按Repo->Credential join下发 无存量迁移
---

# Draft: repo-credential-separation

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
| id | outcome | status | evidence path |
|---|---|---|---|
| credential-domain | 新凭证域 CRUD+加密/脱敏独立管理 | active | server/src/git-repos/git-repos.service.ts:76, server/prisma/schema.prisma:534, server/src/common/credential-crypto.service.ts |
| repo-domain | 仓库域仅存 repoUrl+credentialId+授权 不再含key | active | server/src/git-repos/git-repos.service.ts:130, server/prisma/schema.prisma:556 |
| migration | 1:1存量数据拆分为 1:N 新模型 零丢失可回滚 | active | server/prisma/schema.prisma:536-576, server/prisma/migrations |
| worker-pipeline | dispatch/replay 按 Repo->Credential 解析后下发 | active | server/src/workers/workers.service.ts:481, worker/src/git/git-credential-injector.ts:24 |
| frontend | 仓库创建选凭证下拉 凭证管理独立页/Tab | active | web/app/(main)/git-repos/page.tsx:1, web/src/types/git-repos.ts:1 |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| 凭证命名 | 凭证增加 name(唯一业务名)+description 可选 | 复用时需人类可识别 同 host 多 key 场景可区分 | 是(改列可空) |
| 凭证 ID 前缀 | 保留 gc_ 给 Credential Pool 新 Repo 用 grpo_ 或 repo_ 避免与 GitRepoGrant gr_ 重叠 | 现有 gc_/gr_ 已被 IdGenerator resync 占用 需新前缀 | 是(前缀常量可改) |
| 授权归属 | 授权仍归仓库 (GitRepoGrant.repoUrl -> 新 GitRepo.id) 不归凭证 | 需求"凭证拉多仓库"且授权按仓库粒度最小权限 工更贴近 "仓库×Agent" 维度 | 否(需用户确认) |
| Repo authType 来源 | 以凭证 authType 为准 Repo 不再存 authType 展示时 join 凭证 | 同一凭证 authType 唯一 Repo 引用后无需冗余 避免不一致 | 是(可冗余校验) |
| 删除语义 | 删除凭证时若仍被仓库引用则 409 阻断 需先解绑/迁移 | 防孤儿引用导致 worker 下发取不到 key | 是 |

## Findings (cited - path:lines)
- 现仓库凭证强耦合：GitCredential 同表存 repoUrl+authType+credentialRef+fingerprint 唯一键 uk_git_credentials_repo_auth (server/prisma/schema.prisma:552) 每次建仓库必填 key (server/src/git-repos/dto/create-git-repo.dto.ts:54-76) 前后端 DTO 强制 1:1 (server/src/git-repos/git-repos.controller.ts:48-55, web/src/types/git-repos.ts:48-53, web/app/(main)/git-repos/page.tsx:386-503)
- 授权表按 repoUrl 关联：GitRepoGrant 仅存 repoUrl+agentId 唯一键 uk_git_repo_grants_agent_repo (server/prisma/schema.prisma:572) service 按 repoUrl 聚合授权 (server/src/git-repos/git-repos.service.ts:111-118, 324-341) Worker 过滤也按 repoUrl (server/src/workers/workers.service.ts:542-569)
- Worker 下发链路：resolveWorkerActiveRepoUrls 收集活跃 agent 的 repoUrl -> buildGitCredentialsPayload 按 repoUrl 过滤 GitCredential 解密打包 (server/src/workers/workers.service.ts:542-602) dispatchGitCredentials/replayGitCredentials 是唯一出口 (server/src/git-repos/git-repos.service.ts:276-284)
- 加密与脱敏：CredentialCryptoService.encrypt/fingerprint (server/src/git-repos/git-repos.service.ts:158-159) 600 权限落盘 ~/.keta-git-creds.json (worker/src/git/git-credential-injector.ts:18-22)
- 前端强耦合表单：GitRepoModal 新建强制 repoUrl+authType+key (web/app/(main)/git-repos/page.tsx:628-657) 编辑 key 留空=不更新 (web/app/(main)/git-repos/page.tsx:558-560) 列表行展示 repoUrl/authType/fingerprint/grantedAgents (web/app/(main)/git-repos/page.tsx:261-371)

## Decisions (with rationale)
- 新模型拆分: GitCredential 重塑为凭证池(凭证池保留 gc_ 前缀 新增 name 唯一) + 新 GitRepo 表(前缀 gpr_/gro_ 待定) 凭证 1:N 仓库 复用 CredentialCryptoService 加密 不改动 worker 落盘格式 (worker/src/git/git-credential-injector.ts:24-33 保持 repoUrl+authType+key)
- 复用现有 CredentialCryptoService/IdGenerator/Realtime/worker 下发 降低改动面
- 前端双 Tab (用户已拍板 Q3): /git-repos 同页双 Tab - 仓库 Tab + 凭证 Tab 仓库创建下拉选已有凭证+新建快捷入口
- 无存量兼容(用户已拍板 Q2): Prisma 采用破坏性迁移 允许删表重建 不提供回填脚本 简化实现
- 授权按仓库粒度(Q4 已确认) GitRepoGrant 改为 repoId 关联 删除凭证被引用时 409 阻断(Q5 默认)

## Scope IN
- Prisma 新模型 + 迁移 + resyncIdPrefix
- 凭证域独立 CRUD (POST/GET/PATCH/DELETE /git-credentials + AdminGuard)
- 仓库域重构为 repoUrl+credentialId(+可选 name/description) 选择已有凭证或新建时联动
- GitRepoGrant 关联键从 repoUrl 迁移到 repoId(或保留 repoUrl+新增 credentialId 兼容 需定案) 并更新 service/workers 查询
- WorkersService dispatch/replay 链路改为 Repo -> Credential join 解密
- 前端类型/页面/API 适配 + 空态/冲突/校验提示
- 迁移脚本/seed 兼容 + 单测/集成验证

## Scope OUT (Must NOT have)
- 不改动 SSH key 格式归一/临时文件落盘逻辑 (worker/src/git/git-tools.ts:132-354)
- 不改动 ModelCredential 域
- 不引入按组织/项目粒度的凭证隔离 (当前全局凭证池)
- 不做凭证版本历史/审计日志新表 (沿用 revokedAt 软删轨迹)
- 不改动 auth/RBAC 模型 (复用 AdminGuard)

## Open questions (resolved 2026-08-22)
- Q1 凭证命名: 需要 name ✅ 采用 name 唯一键 @@unique([name]) 允许同 fingerprint 多凭证
- Q2 存量兼容: 不需要兼容 ✅ 破坏性迁移 不提供回填/回滚
- Q3 前端形态: 双 Tab ✅ 同页 /git-repos 双 Tab (仓库|凭证) 仓库创建下拉选凭证+新建快捷入口
- Q4 授权粒度: 仓库粒度 ✅ 保持 GitRepoGrant 按 repoId
- Q5 删除阻断: 默认 409 阻断 ✅ 被引用凭证删除 409 CREDENTIAL_IN_USE

## Approval gate
status: approved
approved_by: user 2026-08-22 (Q1:需要name Q2:无需兼容 Q3:双tab Q4:仓库粒度 Q5:默认409)
next: plan written .omo/plans/repo-credential-separation.md awaiting execution

## Plan file
path: .omo/plans/repo-credential-separation.md
todos: 10 implementation + 4 final verification
created: 2026-08-22
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
