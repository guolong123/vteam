import * as fs from 'fs';
import * as path from 'path';
import {
  AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH,
  EXTERNAL_AGENT_ROLES,
} from '../common/constants/agent-role.constants';

/**
 * Current-schema contract for historical migration
 * `20260919000011_agent_role_external_agent`.
 *
 * The archived migration was an additive nullable column with no data DML.
 * The active baseline therefore keeps the column/index/FK shape, while the
 * current constants and schema carry the service-level slot invariant. The
 * archived migration deliberately chose VARCHAR(128), so the baseline retains
 * that deliberate native width even though Prisma's unannotated String default
 * would otherwise be VARCHAR(191); the DTO's matching 128-character validation
 * remains the write contract and is checked independently below.
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

describe('agent_roles external-agent slot current-schema contract (historical 20260919000011)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const roles = tableDefinition(executable, 'agent_roles');

  it('baseline records the single-baseline squash and archive provenance', () => {
    expect(sql).toContain('由原有 81 个 Prisma 迁移压缩而来');
    expect(sql).toContain('legacy-migrations/');
    expect(sql).toContain('完整数据库基线');
  });

  it('external slot remains a nullable column in the final agent_roles table', () => {
    expect(roles).toMatch(
      /`default_opencode_agent_name`\s+VARCHAR\(128\) NULL/,
    );
    expect(roles).toContain('`default_agent_id` VARCHAR(191) NULL');
  });

  it('baseline has no data migration or uniqueness rule for the service-level slot invariant', () => {
    expect(executable).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\s/m);
    expect(roles).not.toMatch(
      /UNIQUE[^\n]*default_(agent_id|opencode_agent_name)/,
    );
  });

  it('schema maps the external slot and documents the at-most-one invariant', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const roleModel =
      schema.match(/^model AgentRole \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(roleModel).toContain('defaultOpencodeAgentName String?');
    expect(roleModel).toContain('@map("default_opencode_agent_name")');
    expect(roleModel).toContain('互斥');
    expect(roleModel).toContain('AGENT_ROLE_DEFAULT_SLOT_CONFLICT');
  });

  it('all seeded external slot values obey the DTO length contract', () => {
    expect(AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH).toBe(128);
    expect(EXTERNAL_AGENT_ROLES).toHaveLength(3);
    for (const role of EXTERNAL_AGENT_ROLES) {
      expect(role.defaultOpencodeAgentName.length).toBeLessThanOrEqual(
        AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH,
      );
      expect(role.defaultOpencodeAgentName.length).toBeGreaterThan(0);
      expect(role.rolePrompt).toMatch(/^# 角色：/);
    }
  });

  it('the current schema keeps the internal FK and external display slot as distinct columns', () => {
    expect(roles).toMatch(/`default_agent_id`\s+VARCHAR\(191\) NULL/);
    expect(roles).toMatch(
      /`default_opencode_agent_name`\s+VARCHAR\(128\) NULL/,
    );
    expect(roles.indexOf('`default_agent_id`')).toBeLessThan(
      roles.indexOf('`default_opencode_agent_name`'),
    );
  });
});
