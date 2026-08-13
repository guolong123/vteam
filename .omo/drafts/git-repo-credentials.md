# git-repo-credentials - Draft

## Request state

- **intent**: clear
- **review_required**: false
- **status**: exploring
- **slug**: git-repo-credentials
- **user request**: 完整实现 17 篇《仓库权限与凭证机制》（B 方案），UI 配置驱动（不依赖环境变量 GIT_SSH_KEY_PATH），界面风格保持现有（models 页双 Tab + 白卡 + ConfigureModal + 徽章范式）。
- **classification**: Architecture（server schema+API / worker 注入与命令 / web UI / 端到端，5+ 模块）

## Exploration findings (evidence)

### 17 篇设计文档
- `docs/agent-platform/17-仓库权限与凭证机制.md`（445 行）：三层架构 = 凭证管理（credentials + repo_grants 两表，AES-256-GCM 加密、fingerprint 脱敏、软撤销）→ git 工具族（worker 注入 .opencode/tools/git.ts，7 工具，工具名即权限 action，push 默认 ask）→ 注入与清理（GIT_SSH_COMMAND 临时 key / SSH_AUTH_SOCK / credential helper 三种；execute 六步：取凭证→注入→执行→try/finally 清理→返回→审计）。
- 设计意图：凭证与授权分离（credentials=凭证本体，repo_grants=谁可用）；多会话/多任务并发安全；临时凭证短时效。

### 已实现部分（复用基座）
- `worker/src/git/git-tools.ts`：`GIT_TOOLS` 7 工具定义 + `installGitTools()`（worker 启动注入 git.ts）+ `renderGitToolsFile()`。注入的 git.ts 是**最小实现**：`spawnSync("git", args)` 裸调用，无凭证注入、无授权校验。execute 已用 `args`（clone 必填 repo_url）。
- `worker/src/git/git-credentials.ts`：`GitCredential`/`resolveGitEnv`（构造 GIT_SSH_COMMAND env）/`createTempKey`（随机路径+600 权限）/`cleanup`。**能力函数齐全但无调用方**（无接线）。
- `worker/src/git/git-op-reporter.ts`：git.op 审计（按 callID 去重上报）。
- `worker/src/config.ts:30-31`：`gitSshKeyPath`（GIT_SSH_KEY_PATH）——用户明确不依赖它。

### 模型凭据全链路模板（对照实现 git 凭证）
- `server/src/common/credential-crypto.service.ts`：AES-256-GCM 加解密 + fingerprint（前4****后4）；KEY 来自 env `MODEL_CREDENTIAL_KEY`，生产缺失抛错、开发用显式 DEV 密钥。**git 凭证加密可复用此服务**。
- `server/prisma/schema.prisma:421` `model ModelCredential`：id/providerID/credentialRef(Text)/fingerprint/revokedAt/createdAt/updatedAt，`@@unique([providerID])`。git 凭证表可仿此。
- `server/src/models/models.service.ts`：凭据保存（加密存储）→ `WorkersService.dispatchModelCredentials` → 下行命令；View 脱敏（configured/fingerprint/revokedAt）。
- `server/src/workers/workers.service.ts`：`enqueueCommand`（pendingCommands Map，心跳取出即清空）+ `dispatchModelCredentials`（定向/广播）+ `replayModelCredentials`（offline→online 回放）。`heartbeat()` 返回 `{commands}`。
- `worker/src/index.ts:465-509`：`onCommands` 回调消费——RELOAD_CONFIG / MODEL_CREDENTIALS（handleModelCredentials 写 auth.json 600 权限，幂等内容对比防重启循环）。
- `worker/src/protocol/worker-protocol.ts`：`WORKER_COMMAND_TYPES` + `WorkerCommand{type, resourceVersion, payload}`。**新增 git-credentials 命令 type 需双写（worker-protocol + server constants）**。
- `server/src/platform-mcp/`：MCP 工具 handler 模式（selfAgentId 校验 = 当前活跃执行 agent，session 反查）。

### UI 风格参照（必须保持一致）
- `web/app/(main)/models/page.tsx`（748 行）：双 Tab（catalog/providers）+ 白卡列表 + 表头行 + `CredentialBadge`（绿/灰/琥珀）+ `EnabledBadge` + ActionButton + ConfigureModal + 搜索框 + 空态 + 底部说明。行 hover scoped css。token 引用 `@/src/theme/tokens`。
- `web/app/(main)/models/providers-tab.tsx`（1038 行）：Provider 列表行（providerID + modelCount + 徽章 + fingerprint）+ ConfigureModal（key 输入 password + 同步节点 worker 多选 + 保存）+ 删除确认（ConfirmDialog）。API：GET /models/providers、POST /models/:id/credentials、DELETE /models/providers/:providerID/credentials。
- `web/src/components/layout/nav-dock.tsx`：NAV_ITEMS 8 项（project/agents/workers/models/skills/messages/users/roles）——**新增仓库管理入口需加 NAV_ITEMS 项 + 路由**。

### opencode 工具 execute 上下文（关键事实）
- ToolContext 字段（v1.18.16，官方 docs + GitHub 源码）：`{sessionID, messageID, agent, directory, worktree, abort, metadata(), ask()}`。
- `agent` 是 opencode agent 名（如 "build"），**不是平台 Agent id（a_xxx）**——工具内无法直接知道平台 agent 身份。
- 自定义工具 execute 可 spawn 子进程并注入**任意 env**（17 篇 §2.1 事实 ④：ToolContext 无 env 字段但 execute 内可自建子进程注入 env）——GIT_SSH_COMMAND 注入可行。

### 平台身份到 worker 的桥（授权校验关键）
- worker exec-server `/execute` 请求体带 `agentId`（worker 侧知道当前执行 agent）——但注入的 git.ts 工具由 opencode serve 调用，**不经 worker exec-server**。
- 桥接方案：server 下发 git 凭证命令时**只下发该 worker 有授权关系的仓库凭证**（replay/调度时按 worker 过滤？worker 是多任务的，同一 worker 服务多 agent）——需要决策。

## Open questions (owner-decisions)

**已确认（用户回答 2026-08-12）：**
1. 授权主体粒度 = **仅 Agent 实例**（subject_type=agent，schema 预留字段，role/project 后续扩展）
2. 认证类型 = **SSH + HTTPS 都做**（UI 下拉选 auth_type；SSH 走 GIT_SSH_COMMAND 临时 key；HTTPS 走 GIT_ASKPASS 临时脚本注入）
3. 凭证下发 = **按 worker 授权过滤下发**（server 打包「该 worker 承载任务涉及的已授权 Agent 的仓库凭证」下发；worker 落盘白名单凭证文件；git.ts execute 校验 repo_url 在其中）

## Components ledger

| id | 组件 | 一句话结局 | 状态 | 证据路径 |
|----|------|-----------|------|---------|
| C1 | server schema + 迁移 | credentials + repo_grants 表 + 索引 | exploring | schema.prisma:421 仿 ModelCredential |
| C2 | server 凭证 API + 服务 | CRUD + 加密存储 + fingerprint + 授权关系 + 下行命令 | exploring | models.service.ts / workers.service.ts 模板 |
| C3 | worker 命令消费 + 落盘 | git-credentials 命令 → 凭证文件（600）幂等写 | exploring | index.ts:465-509 模板 |
| C4 | 注入 git.ts 升级 | execute 读凭证文件 → GIT_SSH_COMMAND env → spawn → 清理 → 审计 | exploring | git-tools.ts / git-credentials.ts 现状 |
| C5 | web 仓库管理页 | nav 入口 + 页面（列表/配置弹窗/授权 agent 多选/删除） | exploring | models/page.tsx 风格 |
| C6 | 端到端 + 测试 | 单测/集成 + 实测 clone | exploring | 各 spec 模板 |

## Next action

**状态：awaiting-approval**。向用户呈现审批简报，获批后写 `.omo/plans/git-repo-credentials.md`。

### 待规划方案（审批简报）

**目标**：完整落地 17 篇《仓库权限与凭证机制》——平台维护 git 仓库凭证 + 授权（credentials/repo_grants 两表），UI 配置驱动，worker 注入 git 工具族按授权下发凭证，Agent 可在任务内 clone/pull/push 授权仓库。

**模块（6 组件）**：
- C1 schema：`GitCredential`（仿 ModelCredential：id/credentialRef Text/fingerprint/revokedAt + repoUrl/authType/owner 粒度字段）+ `GitRepoGrant`（agentId/repoUrl/permission/effect，唯一约束 agentId+repoUrl）
- C2 server：`git-repos` 模块——CRUD API（管理员录入仓库+凭证，加密存储复用 CredentialCryptoService，fingerprint 脱敏）+ 授权关系维护 + 保存后 dispatchGitCredentials（按 worker 承载的已授权 agent 过滤打包）
- C3 worker：新增 `git-credentials` 下行命令 → 幂等写凭证文件（`~/.keta-git-creds.json` 600 权限，仿 auth.json 模式但**不重启 serve**——git.ts 每次执行读文件）
- C4 注入 git.ts 升级：execute 读凭证文件 → 校验 repo_url 白名单 → SSH：GIT_SSH_COMMAND 临时 key（createTempKey + cleanup）；HTTPS：GIT_ASKPASS 临时脚本 → spawn git → 审计（git-op-reporter）
- C5 web：nav 加「仓库管理」入口 + 页面（列表/配置弹窗含 auth_type 下拉 + 授权 agent 多选/删除确认），风格照 models 页双 Tab + 白卡 + ConfigureModal + 徽章
- C6 测试与端到端：单测（schema/API/命令/工具注入各 spec）+ 实测（UI 配仓库 → agent clone）

**范围外**：role/project 授权（schema 预留）、ssh-agent 长驻会话注入、credential helper 的 bash 裸 git 覆盖（本版 git 工具族注入面）、OAuth 代持、KMS。
