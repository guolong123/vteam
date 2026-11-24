#!/usr/bin/env python3
"""一次性脚本：给 Prisma schema 增加 Workspace 租户模型与 workspaceId 字段。
仅用于本次改造，执行后 schema 由 prisma format 规整；脚本本身不提交（可留档在 .design/scripts）。
"""
import re, sys

PATH = 'prisma/schema.prisma'
src = open(PATH, encoding='utf-8').read()

# ── 1. 目标模型（加 workspaceId）与 Workspace 反向关系字段名 ─────────────────
SCOPED = {
    'Team': 'teams',
    'Member': 'members',
    'MemberNotificationChannel': 'memberNotificationChannels',
    'Task': 'tasks',
    'Session': 'sessions',
    'ChatChannel': 'chatChannels',
    'Message': 'messages',
    'MessageReceipt': 'messageReceipts',
    'Issue': 'issues',
    'Artifact': 'artifacts',
    'Plan': 'plans',
    'Agent': 'agents',
    'AgentRole': 'agentRoles',
    'Skill': 'skills',
    'Tool': 'tools',
    'ExecutionPolicy': 'executionPolicies',
    'Model': 'models',
    'ModelCredential': 'modelCredentials',
    'ProviderTombstone': 'providerTombstones',
    'GitCredential': 'gitCredentials',
    'GitRepo': 'gitRepos',
    'GitRepoGrant': 'gitRepoGrants',
    'McpServer': 'mcpServers',
    'Worker': 'workers',
    'TaskGroupInstance': 'taskGroupInstances',
    'RealtimeEvent': 'realtimeEvents',
    'Trigger': 'triggers',
    'Hook': 'hooks',
    'MessageChannel': 'messageChannels',
    'NotificationChannel': 'notificationChannels',
    'ExternalUser': 'externalUsers',
    'ModelUsage': 'modelUsages',
}

# ── 2. 唯一键改造：字段级去 @unique（在对应 model 块内）──────────────────────
FIELD_UNIQUE = {
    'Team': ['name'],
    'AgentRole': ['key'],
    'Member': ['name'],
    'MemberNotificationChannel': ['notificationChannelId'],
    'Session': ['memberKey'],
    'ExternalUser': ['externalId'],
    'MessageReceipt': ['dedupKey'],
    'Trigger': ['dedupKey'],
    'Hook': ['dedupKey'],
    'Agent': ['agentKey'],
    'Skill': ['name'],
    'Tool': ['action'],
    'GitCredential': ['name'],
    'GitRepo': ['repoUrl'],
    'McpServer': ['name'],
}

# 复合唯一键替换（原文本 → 新文本），在 model 块内替换
COMPOUND_UNIQUE = {
    'Model': [('@@unique([providerID, modelID], map: "uk_models_provider_model")',
               '@@unique([workspaceId, providerID, modelID], map: "uk_models_workspace_provider_model")')],
    'ModelCredential': [('@@unique([providerID], map: "uk_model_credentials_provider")',
                         '@@unique([workspaceId, providerID], map: "uk_model_credentials_workspace_provider")')],
    'GitRepoGrant': [('@@unique([agentId, repoId], map: "uk_git_repo_grants_agent_repo")',
                      '@@unique([workspaceId, agentId, repoId], map: "uk_git_repo_grants_workspace_agent_repo")')],
}

# 新增复合唯一键：model → 唯一键表达式
NEW_COMPOUND_UNIQUE = {
    'Team': '@@unique([workspaceId, name], map: "uk_teams_workspace_name")',
    'AgentRole': '@@unique([workspaceId, key], map: "uk_agent_roles_workspace_key")',
    'Member': '@@unique([workspaceId, name], map: "uk_members_workspace_name")',
    'MemberNotificationChannel': '@@unique([workspaceId, notificationChannelId], map: "uk_member_notif_workspace_channel")',
    'Session': '@@unique([workspaceId, memberKey], map: "uk_sessions_member")',
    'ExternalUser': '@@unique([workspaceId, externalId], map: "uk_external_users_workspace_external")',
    'MessageReceipt': '@@unique([workspaceId, dedupKey], map: "uk_message_receipts_workspace_dedup")',
    'Trigger': '@@unique([workspaceId, dedupKey], map: "uk_triggers_workspace_dedup")',
    'Hook': '@@unique([workspaceId, dedupKey], map: "uk_hooks_workspace_dedup")',
    'Agent': '@@unique([workspaceId, agentKey], map: "uk_agents_workspace_key")',
    'Skill': '@@unique([workspaceId, name], map: "uk_skills_workspace_name")',
    'Tool': '@@unique([workspaceId, action], map: "uk_tools_workspace_action")',
    'GitCredential': '@@unique([workspaceId, name], map: "uk_git_credentials_workspace_name")',
    'GitRepo': '@@unique([workspaceId, repoUrl], map: "uk_git_repos_workspace_repo_url")',
    'McpServer': '@@unique([workspaceId, name], map: "uk_mcp_servers_workspace_name")',
}

def block_span(text, model):
    start = text.index(f'model {model} {{')
    end = text.index('\n}', start)
    return start, end + 2  # 含 "\n}"

def table_of(body, model):
    m = re.search(r'@@map\("([^"]+)"\)', body)
    if m:
        return m.group(1)
    return re.sub(r'(?<!^)(?=[A-Z])', '_', model).lower() + 's'

def edit_block(text, model, fn):
    start, end = block_span(text, model)
    body = text[start:end]
    new = fn(body)
    return text[:start] + new + text[end:]

# ── 3. 插入 Workspace / WorkspaceMember（放在 Role 模型之后）──────────────────
rev_lines = '\n'.join(f'  {field} {m}[]' for m, field in SCOPED.items())
workspace_models = f'''
// ==================================================================
// 工作空间（租户）域
//
// 空间 = 租户边界：所有用户态资源带 workspaceId；平台内置资源归属
// ws_system（isSystem=true，所有人隐式可读、普通用户只读）。
// 用户与空间为 M:N（WorkspaceMember），当前空间由 JWT 的 wid 表达。
// ==================================================================

model Workspace {{
  id          String   @id
  name        String
  slug        String?  @unique
  isSystem    Boolean  @default(false) @map("is_system")
  status      String   @default("active") @db.VarChar(16)
  ownerUserId String?  @map("owner_user_id")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  owner   User?             @relation("WorkspaceOwner", fields: [ownerUserId], references: [id], onDelete: Restrict, onUpdate: Restrict)
  members WorkspaceMember[]
{rev_lines}

  @@index([ownerUserId], map: "idx_workspaces_owner")
  @@index([isSystem], map: "idx_workspaces_is_system")
  @@map("workspaces")
}}

/// 用户 × 空间成员关系（空间内角色：owner / admin / member）。
model WorkspaceMember {{
  workspaceId String   @map("workspace_id")
  userId      String   @map("user_id")
  role        String   @default("member") @db.VarChar(16)
  joinedAt    DateTime @default(now()) @map("joined_at")

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade, onUpdate: Restrict)
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade, onUpdate: Restrict)

  @@id([workspaceId, userId])
  @@index([userId], map: "idx_workspace_members_user")
  @@map("workspace_members")
}}
'''
role_end = src.index('@@map("roles")')
insert_at = src.index('\n}', role_end) + 2
src = src[:insert_at] + workspace_models + src[insert_at:]

# ── 4. User 增加 lastWorkspaceId 与反向关系 ─────────────────────────────────
src = src.replace(
    '  resetTokenExpires DateTime? @map("reset_token_expires")',
    '  resetTokenExpires DateTime? @map("reset_token_expires")\n'
    '  /// 最近一次使用的空间（登录/切换空间时写入，作为默认当前空间）\n'
    '  lastWorkspaceId   String?   @map("last_workspace_id")',
    1,
)
src = src.replace(
    '  teamUserMembers TeamUserMember[]',
    '  teamUserMembers TeamUserMember[]\n'
    '  ownedWorkspaces Workspace[]       @relation("WorkspaceOwner")\n'
    '  workspaceMembers WorkspaceMember[]',
    1,
)

# ── 5. 逐模型：加 workspaceId 字段 + 索引 + 唯一键调整 ────────────────────────
for model in SCOPED:
    def fn(body, model=model):
        table = table_of(body, model)
        # 5.1 字段：插在 model 行后
        first_nl = body.index('\n')
        body = body[:first_nl+1] + \
               '  workspaceId String    @map("workspace_id")\n' + \
               '  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Restrict, onUpdate: Restrict)\n' + \
               body[first_nl+1:]
        # 5.2 字段级去 @unique
        for field in FIELD_UNIQUE.get(model, []):
            pat = re.compile(rf'^(\s*{field}\s+String\??[^\n]*?)\s+@unique(?:\(map: "[^"]+"\))?', re.M)
            body, n = pat.subn(r'\1', body)
            if n != 1:
                raise SystemExit(f'{model}.{field}: 去 @unique 命中 {n} 次（期望 1）')
        # 5.3 复合唯一键替换
        for old, new in COMPOUND_UNIQUE.get(model, []):
            if old not in body:
                raise SystemExit(f'{model}: 找不到复合唯一键原文 {old}')
            body = body.replace(old, new)
        # 5.4 ProviderTombstone 主键改造
        if model == 'ProviderTombstone':
            body = body.replace('providerID String   @id @map("provider_id")',
                                'providerID String   @map("provider_id")', 1)
            body = body.replace('  @@map("provider_tombstones")',
                                '  @@id([workspaceId, providerID])\n  @@map("provider_tombstones")', 1)
        # 5.5 新增唯一键 + workspaceId 索引（插在 @@map 前）
        attrs = []
        if model in NEW_COMPOUND_UNIQUE:
            attrs.append('  ' + NEW_COMPOUND_UNIQUE[model])
        attrs.append(f'  @@index([workspaceId], map: "idx_{table}_workspace")')
        map_line = re.search(r'^  @@map\("[^"]+"\)$', body, re.M)
        if not map_line:
            raise SystemExit(f'{model}: 缺 @@map')
        body = body[:map_line.start()] + '\n'.join(attrs) + '\n' + body[map_line.start():]
        return body
    src = edit_block(src, model, fn)

open(PATH, 'w', encoding='utf-8').write(src)
print('schema 改写完成')
