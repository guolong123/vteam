#!/usr/bin/env python3
"""把 prisma migrate diff 的差量改写成可在「已有数据」的库上安全执行的 expand 迁移。

用法：python3 build-workspace-migration.py /tmp/ws-delta.sql <输出目录>
"""
import re
import sys

delta_path = sys.argv[1]
out_dir = sys.argv[2]
delta = open(delta_path, encoding='utf-8').read()

MODELS_SCOPED = [
    # (table, 回填目标表达式)
    ('agent_roles', "'ws_system'"),
    ('agents', "IF(`type` = 'template', 'ws_system', 'ws_default')"),
    ('artifacts', "'ws_default'"),
    ('chat_channels', "'ws_default'"),
    ('execution_policies', "'ws_system'"),
    ('external_users', "'ws_default'"),
    ('git_credentials', "'ws_default'"),
    ('git_repo_grants', "'ws_default'"),
    ('git_repos', "'ws_default'"),
    ('hooks', "'ws_default'"),
    ('issues', "'ws_default'"),
    ('mcp_servers', "IF(`name` IN ('vteam','vteam-api'), 'ws_system', 'ws_default')"),
    ('member_notification_channels', "'ws_default'"),
    ('members', "'ws_default'"),
    ('message_channels', "'ws_default'"),
    ('message_receipts', "'ws_default'"),
    ('messages', "'ws_default'"),
    ('model_credentials', "'ws_default'"),
    ('model_usages', "'ws_default'"),
    ('models', "'ws_default'"),
    ('notification_channels', "'ws_default'"),
    ('plans', "'ws_default'"),
    ('provider_tombstones', "'ws_default'"),
    ('realtime_events', "'ws_default'"),
    ('sessions', "'ws_default'"),
    ('skills', "'ws_system'"),
    ('task_group_instances', "'ws_default'"),
    ('tasks', "'ws_default'"),
    ('teams', "'ws_default'"),
    ('tools', "'ws_system'"),
    ('triggers', "'ws_default'"),
    ('workers', "'ws_default'"),
]

# 与本次改造无关的 schema drift 语句：不迁移（避免误删索引/重复外键）
UNRELATED_DROPS = {
    'idx_artifacts_task_category',
    'idx_memories_session',
    'idx_memories_source_instance',
}
UNRELATED_DROP_FK = {
    'artifacts_task_id_fkey',
}
# 注意：member_notification_channels 的 FK 依赖 uk_member_notif_channel 索引，
# 必须先删 FK 再删索引，回填后重建复合唯一索引，最后把 FK 加回来（差量里本来就有这对语句）。

# 1) 拆成「注释 + 语句」块
blocks = re.findall(r'(?:-- [^\n]+\n)?(?:[^;]+;)', delta)
blocks = [b for b in blocks if b.strip()]
kept = []
for b in blocks:
    first = b.strip().split('\n')[0]
    if first.startswith('-- DropIndex'):
        name = re.search(r'DROP INDEX `([^`]+)`', b)
        if name and name.group(1) in UNRELATED_DROPS:
            continue
    if first.startswith('-- DropForeignKey'):
        name = re.search(r'DROP FOREIGN KEY `([^`]+)`', b)
        if name and name.group(1) in UNRELATED_DROP_FK:
            continue
    if first.startswith('-- AddForeignKey'):
        name = re.search(r'ADD CONSTRAINT `([^`]+)`', b)
        if name and name.group(1) in UNRELATED_DROP_FK:
            continue
    if first.startswith('-- CreateIndex'):
        name = re.search(r'INDEX `([^`]+)`', b)
        if name and name.group(1) in UNRELATED_DROPS:
            continue
    kept.append(b)

# 2) 分类
create_tables, drop_indexes, drop_fks, add_cols, create_indexes, add_fks, other = [], [], [], [], [], [], []
for b in kept:
    if 'CREATE TABLE' in b:
        create_tables.append(b)
    elif 'DROP INDEX' in b:
        drop_indexes.append(b)
    elif 'DROP FOREIGN KEY' in b:
        drop_fks.append(b)
    elif 'ADD COLUMN `workspace_id`' in b:
        add_cols.append(b)
    elif 'ADD COLUMN `last_workspace_id`' in b:
        other.append(b)
    elif 'CREATE INDEX' in b or 'CREATE UNIQUE INDEX' in b:
        create_indexes.append(b)
    elif 'ADD CONSTRAINT' in b:
        name = re.search(r'ADD CONSTRAINT `([^`]+)`', b).group(1)
        # 只保留：workspace 归属外键、workspace_members/workspaces 自身外键、
        # 以及本次被显式删除后需要加回的 member_notification_channels FK。
        if (name.endswith('_workspace_id_fkey')
                or name.startswith('workspace_members_')
                or name.startswith('workspaces_owner_')
                or name == 'member_notification_channels_notification_channel_id_fkey'):
            add_fks.append(b)
    elif 'DROP PRIMARY KEY' in b:
        other.append(b)  # provider_tombstones 的 PK 重建，单独处理
    elif 'MODIFY' in b:
        other.append(b)  # 与本次无关的列类型对齐（保留，随所在 ALTER 一起）
    else:
        other.append(b)

# 3) ADD COLUMN workspace_id：NOT NULL → NULL（先可空，回填后再收紧）
add_cols_final = []
for b in add_cols:
    # provider_tombstones 的 ALTER 里还有 ADD PRIMARY KEY，先摘出来（回填后再加）
    b = re.sub(r',\s*ADD PRIMARY KEY \(`workspace_id`, `provider_id`\)', '', b)
    add_cols_final.append(b)

# 4) 回填语句
base_spaces = ["""INSERT INTO `workspaces` (`id`, `name`, `slug`, `is_system`, `status`, `owner_user_id`, `created_at`, `updated_at`)
VALUES
  ('ws_system', '平台空间', 'system', TRUE, 'active', NULL, NOW(3), NOW(3)),
  ('ws_default', '默认空间', 'default', FALSE, 'active',
   (SELECT `id` FROM `users` WHERE `username` = 'admin' LIMIT 1), NOW(3), NOW(3));"""]
backfill = []
backfill.append("""-- 3) 存量用户挂到默认空间；last_workspace_id 指向默认空间
UPDATE `users` SET `last_workspace_id` = 'ws_default';
INSERT INTO `workspace_members` (`workspace_id`, `user_id`, `role`, `joined_at`)
SELECT 'ws_default', `id`, IF(`username` = 'admin', 'owner', 'member'), NOW(3) FROM `users`;""")
for table, expr in MODELS_SCOPED:
    backfill.append(f"UPDATE `{table}` SET `workspace_id` = {expr};")

# 5) 重建 provider_tombstones 复合主键（列已是 NOT NULL DEFAULT）
not_null = ["ALTER TABLE `provider_tombstones` ADD PRIMARY KEY (`workspace_id`, `provider_id`);"]

# 6) 组装
heads = {
    'create_tables': '-- ============ 1) 新建工作空间表 ============',
    'base_spaces': '-- ============ 1.5) 基础空间：系统空间（平台内置资源，全员隐式可读）+ 默认空间（存量数据） ============',
    'drops': '-- ============ 2) 拆除旧的全局唯一索引（随后在回填后重建为含 workspace_id 的复合索引） ============',
    'adds': '-- ============ 3) 各资源表加 workspace_id（NOT NULL DEFAULT ws_default，随后回填平台资源到 ws_system） ============',
    'backfill': '-- ============ 4) 回填：系统空间承载平台资源，其余归默认空间 ============',
    'notnull': '-- ============ 5) 重建 provider_tombstones 复合主键 ============',
    'indexes': '-- ============ 6) 复合唯一索引 + workspace_id 索引 ============',
    'fks': '-- ============ 7) 外键 ============',
}
parts = [
    '-- 多工作空间（租户）改造 · expand 阶段。\n'
    '-- 由 prisma migrate diff 差量脚本生成后人工重排：先建表 → 加可空列 → 回填 → 收紧 NOT NULL → 索引 → 外键。\n'
    '-- 本仓无 down-migration 约定；回滚按「重建库」口径（生产先 mysqldump）。\n',
    heads['create_tables'], *create_tables,
    heads['base_spaces'], *base_spaces,
    heads['drops'], *drop_fks, *drop_indexes, *[b for b in other if 'DROP PRIMARY KEY' in b],
    heads['adds'], *add_cols_final, *[b for b in other if 'ADD COLUMN `last_workspace_id`' in b],
    heads['backfill'], *backfill,
    heads['notnull'], *not_null, *[b for b in other if 'MODIFY' in b and 'workspace_id' not in b and 'PRIMARY KEY' not in b],
    heads['indexes'], *create_indexes,
    heads['fks'], *add_fks,
    # 收尾：索引重建会连带删除依赖它的外键，这里补回；同时补齐 schema 声明的 sessions.member_id 外键
    # （原库缺该 FK 属于历史漂移，数据已验证无孤儿）。
    '-- ============ 8) 补回外键（索引重建/历史漂移） ============',
    'ALTER TABLE `member_notification_channels` ADD CONSTRAINT `member_notification_channels_notification_channel_id_fkey` '
    'FOREIGN KEY (`notification_channel_id`) REFERENCES `notification_channels`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;',
    'ALTER TABLE `sessions` ADD CONSTRAINT `sessions_member_id_fkey` '
    'FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;',
]
sql = '\n\n'.join(p.strip() for p in parts if p.strip()) + '\n'

import os
os.makedirs(out_dir, exist_ok=True)
open(os.path.join(out_dir, 'migration.sql'), 'w', encoding='utf-8').write(sql)
print(f'written: {out_dir}/migration.sql, {len(sql.splitlines())} lines')
