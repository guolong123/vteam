import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_KEYS,
} from '../common/constants/agent-role.constants';
import {
  PLATFORM_CAPABILITY_KEYS,
  buildFactoryCapabilityMatrix,
} from '../common/constants/platform-capability.constants';

/**
 * Current-schema contract for historical migration
 * `20260921000007_builtin_role_capabilities_factory_default`.
 *
 * That migration used a single data UPDATE to replace the seven builtin
 * capability matrices.  The active baseline is intentionally DDL-only, so the
 * durable equivalent is the current role matrix source: seven builtin keys,
 * the complete boolean capability catalog, and no accidental inclusion of the
 * three external roles or the general fallback role.
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

const BUILTIN_KEYS = BUILTIN_AGENT_ROLES.map((role) => role.key);
const FACTORY_MATRIX = buildFactoryCapabilityMatrix();

describe('agent_roles builtin capability current-schema contract (historical 20260921000007)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const roles = tableDefinition(executable, 'agent_roles');

  it('baseline records the squash provenance instead of pointing at a removed migration file', () => {
    expect(sql).toContain('由原有 81 个 Prisma 迁移压缩而来');
    expect(sql).toContain('legacy-migrations/');
    expect(sql).toContain('完整数据库基线');
  });

  it('current schema stores a nullable JSON capability matrix and the builtin discriminator', () => {
    expect(roles).toMatch(/`type`\s+VARCHAR\(191\) NOT NULL/);
    expect(roles).toMatch(/`capabilities`\s+JSON NULL/);
    expect(roles).toContain('UNIQUE INDEX `uk_agent_roles_key`(`key`)');
  });

  it('capability source covers exactly the seven builtin role keys with boolean values', () => {
    expect(Object.keys(BUILTIN_ROLE_CAPABILITY_MAPS)).toEqual(BUILTIN_KEYS);
    for (const key of BUILTIN_KEYS) {
      const matrix = BUILTIN_ROLE_CAPABILITY_MAPS[key];
      expect(Object.keys(matrix)).toEqual([...PLATFORM_CAPABILITY_KEYS]);
      expect(
        Object.values(matrix).every((value) => typeof value === 'boolean'),
      ).toBe(true);
    }
  });

  it('builtin scope does not absorb external or general fallback roles', () => {
    for (const key of [...EXTERNAL_AGENT_ROLE_KEYS, 'general']) {
      expect(BUILTIN_KEYS).not.toContain(key);
      expect(BUILTIN_ROLE_CAPABILITY_MAPS[key]).toBeUndefined();
    }
    expect(Object.keys(FACTORY_MATRIX)).toEqual([...PLATFORM_CAPABILITY_KEYS]);
  });

  it('baseline contains no historical capability UPDATE or JSON mutation to reapply', () => {
    // The baseline is the final DDL.  Reapplying the archived data migration
    // would be both unnecessary and unsafe after a fresh seed.
    expect(executable).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\s/m);
    expect(executable).not.toMatch(/JSON_(SET|REMOVE)\(/);
  });

  it('Prisma schema agrees with the baseline capability ownership boundary', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const roleModel =
      schema.match(/^model AgentRole \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(roleModel).toMatch(/capabilities Json\?\s+@map\("capabilities"\)/);
    expect(roleModel).not.toMatch(/^\s*policyId\s/m);
    expect(roleModel).toContain('@@map("agent_roles")');
  });
});
