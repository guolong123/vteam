import * as fs from 'fs';
import * as path from 'path';

/** 迁移契约：20261106190000_global_session（P3 全局会话底座）。 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261106190000_global_session',
  'migration.sql',
);
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');
const sql = () => fs.readFileSync(MIGRATION, 'utf8');
const schema = () => fs.readFileSync(SCHEMA, 'utf8');

describe('20261106190000_global_session migration contract', () => {
  it('sessions 补全局会话列（含 member_key/member_id/current_*）', () => {
    const ddl = sql();
    for (const col of [
      'member_id',
      'member_key',
      'seat_id',
      'current_team_id',
      'current_task_id',
      'current_channel_id',
      'turn_seq',
      'busy_state',
      'busy_since',
      'last_turn_outcome',
    ]) {
      expect(ddl).toContain(`ADD COLUMN \`${col}\``);
    }
    expect(ddl).toContain('CREATE UNIQUE INDEX `uk_sessions_member`');
    expect(ddl).toContain('CREATE INDEX `idx_sessions_member`');
  });

  it('schema 与迁移双向对齐（Session/SessionTurn）', () => {
    const s = schema();
    const ddl = sql();
    expect(s).toMatch(/model SessionTurn \{/);
    expect(s).toContain('memberKey');
    expect(s).toContain('uk_sessions_member');
    expect(s).toContain('uk_session_turns_running');
    expect(ddl).toContain('CREATE TABLE `session_turns`');
    expect(ddl).toContain('UNIQUE KEY `uk_session_turns_running`');
    expect(ddl).toContain('UNIQUE KEY `uk_session_turns_seq`');
    expect(ddl).toContain('KEY `idx_session_turns_pick`');
    expect(ddl).toContain('KEY `idx_session_turns_claim`');
    expect(ddl).toContain('KEY `idx_session_turns_team`');
  });

  it('session_turns 列齐全且带 session 级联', () => {
    const ddl = sql();
    for (const col of [
      'session_id',
      'seq',
      'member_id',
      'seat_id',
      'team_id',
      'channel_id',
      'task_id',
      'message_id',
      'source',
      'status',
      'running_key',
      'enqueued_at',
      'started_at',
      'ended_at',
      'error',
      'engine_message_id',
    ]) {
      expect(ddl).toContain(`\`${col}\``);
    }
    expect(ddl).toContain('ON DELETE CASCADE');
  });

  it('纯 expand：不回填/不删列', () => {
    const ddl = sql();
    // 只检查数据更新语句（FK 的 ON UPDATE RESTRICT 不算回填）
    expect(ddl).not.toMatch(/\bUPDATE\s+`\w+`/i);
    expect(ddl).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
