import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  FALLBACK_AGENT_ROLE,
} from '../common/constants/agent-role.constants';

/**
 * Current-schema contract for historical migration
 * `20260919000010_drop_agents_role`.
 *
 * The archived migration performed a one-time backfill and then dropped
 * `agents.role`.  That historical UPDATE/DROP sequence is intentionally not
 * replayed by the single baseline.  The equivalent final-state contract is
 * that role ownership lives on `team_members.role_id`/`agent_roles`, while
 * `agents` retains its independent `agent_key` and execution `policy_id`.
 */

const BASELINE = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260925000000_squashed_baseline',
  'migration.sql',
);
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\s+CHARACTER SET\s+\S+\s+COLLATE\s+\S+/gi, '')
    .replace(/\bDEFAULT NULL\b/gi, 'NULL')
    .replace(/\bUNIQUE KEY\b/gi, 'UNIQUE INDEX')
    .replace(/^(\s*)KEY\s+/gim, '$1INDEX ')
    .replace(/(INDEX\s+`[^`]+`)\s+\(/g, '$1(')
    .replace(/REFERENCES\s+(`[^`]+`)\s+\(/g, 'REFERENCES $1(')
    .replace(/\b(varchar|text|json|datetime|tinyint|int|bigint)\b/gi, (type) =>
      type.toUpperCase(),
    );
}

function tableDefinition(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE \`${table}\``);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n) ', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('agents.role removal current-schema contract (historical 20260919000010)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const agents = tableDefinition(executable, 'agents');
  const teamMembers = tableDefinition(executable, 'team_members');
  const roles = tableDefinition(executable, 'agent_roles');

  it('baseline retains the squash audit header and final schema as the migration source', () => {
    expect(sql).toContain('由原有 81 个 Prisma 迁移压缩而来');
    expect(sql).toContain('legacy-migrations/');
    expect(sql).toContain('完整数据库基线');
  });

  it('agents has the replacement identity fields and no legacy role column', () => {
    expect(agents).toMatch(/`agent_key`\s+VARCHAR\(63\) NULL/);
    expect(agents).toMatch(/`policy_id`\s+VARCHAR\(191\) NULL/);
    expect(agents).not.toMatch(/`role`\s+VARCHAR/);
  });

  it('team_members carries the nullable role relationship and its index', () => {
    expect(teamMembers).toMatch(/`role_id`\s+VARCHAR\(191\) NULL/);
    expect(teamMembers).toContain('INDEX `idx_team_members_role`(`role_id`)');
    expect(executable).toMatch(
      /team_members_role_id_fkey` FOREIGN KEY \(`role_id`\) REFERENCES `agent_roles`\(`id`\) ON DELETE RESTRICT/,
    );
  });

  it('the role table keeps default-agent ownership separate from the agent row', () => {
    expect(roles).toMatch(/`default_agent_id`\s+VARCHAR\(191\) NULL/);
    expect(executable).toMatch(
      /agent_roles_default_agent_id_fkey` FOREIGN KEY \(`default_agent_id`\) REFERENCES `agents`\(`id`\) ON DELETE SET NULL/,
    );
    expect(roles).not.toMatch(/`policy_id`\s/);
  });

  it('the final schema exposes exactly one agent-role model and no second RBAC model', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    expect((schema.match(/^model AgentRole /gm) ?? []).length).toBe(1);
    expect((schema.match(/^model Role /gm) ?? []).length).toBe(1);
    expect(schema).toMatch(/model AgentRole \{[\s\S]*?@@map\("agent_roles"\)/);
    expect(schema).toMatch(/model Role \{[\s\S]*?@@map\("roles"\)/);
  });

  it('builtin and fallback role identifiers still provide a non-null resolution target', () => {
    expect(BUILTIN_AGENT_ROLES).toHaveLength(7);
    expect(FALLBACK_AGENT_ROLE.id).toBe('ar_general');
    expect(FALLBACK_AGENT_ROLE.key).toBe('general');
    for (const role of BUILTIN_AGENT_ROLES) {
      expect(role.id).toMatch(/^ar_[a-z_]+$/);
      expect(role.defaultAgentId).toMatch(/^a_[a-z_]+$/);
    }
  });

  it('baseline does not reintroduce the removed role column through executable DDL', () => {
    expect(executable).not.toMatch(/ALTER TABLE `agents`[^\n]*`role`/);
    expect(executable).not.toMatch(/UPDATE `agents`[^\n]*`role`/);
    expect(executable).not.toMatch(/INSERT INTO `agents`[^\n]*`role`/);
  });
});
