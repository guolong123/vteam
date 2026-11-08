import * as fs from 'fs';
import * as path from 'path';

/**
 * 迁移契约：20261106170000_members（成员库 P0）。
 *
 * 守住「schema 声明的表/列/索引/外键，迁移链里必须有对应 DDL」这条不变量
 * （同源事故：PR #36 schema 有列、迁移缺列导致部署 ERROR 1054）。
 * 本机无 MySQL，故只做静态双向断言。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261106170000_members',
  'migration.sql',
);
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const sql = () => fs.readFileSync(MIGRATION, 'utf8');
const schema = () => fs.readFileSync(SCHEMA, 'utf8');

describe('20261106170000_members migration contract', () => {
  it('schema 声明 Member / MemberNotificationChannel 且挂到 TeamMember/ChatChannel', () => {
    const s = schema();
    expect(s).toMatch(/model Member \{/);
    expect(s).toMatch(/model MemberNotificationChannel \{/);
    expect(s).toContain('memberId       String?  @map("member_id")');
    expect(s).toContain('uk_member_notif_channel');
  });

  it('迁移建 members 表，列与 schema 对齐', () => {
    const ddl = sql();
    expect(ddl).toContain('CREATE TABLE `members`');
    for (const col of [
      'id',
      'name',
      'default_role_id',
      'agent_id',
      'default_model_id',
      'preferred_worker_id',
      'private_work_dir',
      'status',
      'description',
      'origin_team_member_id',
      'created_by',
      'created_at',
      'updated_at',
    ]) {
      expect(ddl).toContain(`\`${col}\``);
    }
    expect(ddl).toContain('UNIQUE KEY `members_name_key`');
    expect(ddl).toContain('UNIQUE KEY `members_origin_team_member_id_key`');
  });

  it('迁移建 member_notification_channels（复合 PK + 渠道唯一）', () => {
    const ddl = sql();
    expect(ddl).toContain('CREATE TABLE `member_notification_channels`');
    expect(ddl).toContain(
      'PRIMARY KEY (`member_id`,`notification_channel_id`)',
    );
    expect(ddl).toContain('UNIQUE KEY `uk_member_notif_channel`');
  });

  it('团队席位 / 私聊频道补 member_id 指针与索引、外键', () => {
    const ddl = sql();
    expect(ddl).toContain('ALTER TABLE `team_members` ADD COLUMN `member_id`');
    expect(ddl).toContain('CREATE INDEX `idx_team_members_member`');
    expect(ddl).toContain(
      'FOREIGN KEY (`member_id`) REFERENCES `members` (`id`)',
    );
    expect(ddl).toContain('ALTER TABLE `chat_channels` ADD COLUMN `member_id`');
    expect(ddl).toContain('CREATE INDEX `idx_chat_channels_member`');
  });

  it('纯 expand：不回填、不改旧列', () => {
    const ddl = sql();
    expect(ddl).not.toMatch(/UPDATE\s+`(team_members|chat_channels)`/i);
    expect(ddl).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
