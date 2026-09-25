import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
} from '../common/constants/agent-role.constants';
import {
  buildFactoryCapabilityMatrix,
  PLATFORM_CAPABILITY_KEYS,
} from '../common/constants/platform-capability.constants';

/**
 * Current-schema contract for historical migration
 * `20260921000009_split_grouped_capabilities`.
 *
 * The archived migration carried eleven literal UPDATEs.  A squashed baseline
 * cannot retain those one-off statements, but it must retain the resulting
 * schema and the current matrix source must retain the post-split semantics.
 * These tests therefore assert the final 28-key matrices, including the cells
 * that the old grouped keys used to collapse.
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

const BUILTIN_KEYS = BUILTIN_AGENT_ROLES.map((role) => role.key);
const RETIRED_KEYS = ['issue.manage', 'memory.manage'] as const;

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

function expectBooleanCatalog(matrix: Readonly<Record<string, boolean>>): void {
  expect(Object.keys(matrix)).toEqual([...PLATFORM_CAPABILITY_KEYS]);
  for (const retired of RETIRED_KEYS) {
    expect(Object.keys(matrix)).not.toContain(retired);
  }
  expect(
    Object.values(matrix).every((value) => typeof value === 'boolean'),
  ).toBe(true);
}

describe('agent capability split current-schema contract (historical 20260921000009)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const roles = tableDefinition(executable, 'agent_roles');

  it('baseline retains the split-era schema and squash audit header', () => {
    expect(sql).toContain('由原有 81 个 Prisma 迁移压缩而来');
    expect(sql).toContain('legacy-migrations/');
    expect(roles).toMatch(/`capabilities`\s+JSON NULL/);
  });

  it('the current capability catalog is the complete 28-key post-split catalog', () => {
    expect(PLATFORM_CAPABILITY_KEYS).toHaveLength(28);
    expect(new Set(PLATFORM_CAPABILITY_KEYS).size).toBe(28);
    for (const retired of RETIRED_KEYS) {
      expect(PLATFORM_CAPABILITY_KEYS).not.toContain(retired);
    }
  });

  it('all seven builtin matrices have the complete catalog and boolean values', () => {
    expect(Object.keys(BUILTIN_ROLE_CAPABILITY_MAPS)).toEqual(BUILTIN_KEYS);
    for (const key of BUILTIN_KEYS) {
      expectBooleanCatalog(BUILTIN_ROLE_CAPABILITY_MAPS[key]);
    }
  });

  it('project_manager remains explicitly fully authorized', () => {
    const matrix = BUILTIN_ROLE_CAPABILITY_MAPS.project_manager;
    expect(Object.keys(matrix)).toHaveLength(28);
    expect(Object.values(matrix).every((value) => value === true)).toBe(true);
  });

  it('external roles retain the explicit least-privilege matrix', () => {
    expect(
      Object.values(EXTERNAL_AGENT_ROLE_CAPABILITIES).filter((value) => value),
    ).toHaveLength(8);
    expect(
      Object.values(EXTERNAL_AGENT_ROLE_CAPABILITIES).filter(
        (value) => value === false,
      ),
    ).toHaveLength(20);
    expectBooleanCatalog(EXTERNAL_AGENT_ROLE_CAPABILITIES);
    expect(EXTERNAL_AGENT_ROLE_KEYS).toEqual([
      'sisyphus',
      'prometheus',
      'atlas',
    ]);
    for (const key of EXTERNAL_AGENT_ROLE_KEYS) {
      expect(BUILTIN_ROLE_CAPABILITY_MAPS[key]).toBeUndefined();
    }
  });

  it('ar_general-equivalent factory matrix remains balanced at 14 allow and 14 deny', () => {
    const factory = buildFactoryCapabilityMatrix();
    expect(
      Object.values(factory).filter((value) => value === true),
    ).toHaveLength(14);
    expect(
      Object.values(factory).filter((value) => value === false),
    ).toHaveLength(14);
    expectBooleanCatalog(factory);
  });

  it('the four formerly collapsed issue/memory cells are open with write-side siblings still denied', () => {
    const architect = BUILTIN_ROLE_CAPABILITY_MAPS.architect;
    for (const key of ['issue.create', 'issue.get', 'issue.list']) {
      expect(architect[key]).toBe(true);
    }
    for (const key of ['issue.update', 'issue.transition']) {
      expect(architect[key]).toBe(false);
    }

    const tester = BUILTIN_ROLE_CAPABILITY_MAPS.tester;
    for (const key of [
      'issue.create',
      'issue.get',
      'issue.list',
      'issue.transition',
    ]) {
      expect(tester[key]).toBe(true);
    }
    expect(tester['issue.update']).toBe(false);

    for (const roleKey of ['plan', 'librarian']) {
      const role = BUILTIN_ROLE_CAPABILITY_MAPS[roleKey];
      expect(role['memory.search']).toBe(true);
      expect(role['memory.save']).toBe(false);
      expect(role['memory.update']).toBe(false);
    }
  });

  it('baseline has no retired grouped-key literals or one-off capability DML', () => {
    expect(executable).not.toMatch(/issue\.manage|memory\.manage/);
    expect(executable).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\s/m);
    expect(executable).not.toMatch(/JSON_(SET|REMOVE|OBJECT)\(/);
  });
});
