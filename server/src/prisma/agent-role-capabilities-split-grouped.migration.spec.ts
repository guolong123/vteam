import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
  EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS,
} from '../common/constants/agent-role.constants';
import {
  buildFactoryCapabilityMatrix,
  isCapabilityGranted,
  PLATFORM_CAPABILITY_KEYS,
} from '../common/constants/platform-capability.constants';

/**
 * Current-schema contract for historical migration
 * `20260921000009_split_grouped_capabilities`.
 *
 * The archived migration carried eleven literal UPDATEs.  A squashed baseline
 * cannot retain those one-off statements, but it must retain the resulting
 * schema and the current matrix source must retain the post-split semantics.
 * These tests therefore assert the final 29-key matrices, including the cells
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
const SECRET_CAPABILITY_UPGRADE = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260926000000_secret_command_capability',
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

function expectBooleanCatalogMissing(
  matrix: Readonly<Record<string, boolean>>,
  unmanagedKeys: readonly string[],
): void {
  expect(Object.keys(matrix)).toEqual(
    PLATFORM_CAPABILITY_KEYS.filter((key) => !unmanagedKeys.includes(key)),
  );
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

  it('the current capability catalog is the complete 29-key post-retirement catalog', () => {
    // v2.3 T11 曾加到 32（+git.repo.read/write/web.browse），2026-09-30 三键退役 ⇒ 29。
    expect(PLATFORM_CAPABILITY_KEYS).toHaveLength(29);
    expect(new Set(PLATFORM_CAPABILITY_KEYS).size).toBe(29);
    for (const retired of RETIRED_KEYS) {
      expect(PLATFORM_CAPABILITY_KEYS).not.toContain(retired);
    }
  });

  it('all seven builtin matrices have the complete catalog and boolean values', () => {
    expect(Object.keys(BUILTIN_ROLE_CAPABILITY_MAPS)).toEqual(BUILTIN_KEYS);
    for (const key of BUILTIN_KEYS) {
      expectBooleanCatalog(BUILTIN_ROLE_CAPABILITY_MAPS[key]);
      expect(BUILTIN_ROLE_CAPABILITY_MAPS[key]['secret.command']).toBe(true);
    }
  });

  it('project_manager remains explicitly fully authorized', () => {
    const matrix = BUILTIN_ROLE_CAPABILITY_MAPS.project_manager;
    expect(Object.keys(matrix)).toHaveLength(29); // T11 三键退役后
    expect(Object.values(matrix).every((value) => value === true)).toBe(true);
  });

  it('external roles do NOT emit the T11 keys (default-allow => they retain git/browse)', () => {
    expect(
      Object.values(EXTERNAL_AGENT_ROLE_CAPABILITIES).filter((value) => value),
    ).toHaveLength(9);
    expect(
      Object.values(EXTERNAL_AGENT_ROLE_CAPABILITIES).filter(
        (value) => value === false,
      ),
    ).toHaveLength(20);
    expect(EXTERNAL_AGENT_ROLE_CAPABILITIES['secret.command']).toBe(true);
    expectBooleanCatalogMissing(
      EXTERNAL_AGENT_ROLE_CAPABILITIES,
      EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS,
    );
    // 用户决定（2026-09-29）：外部助手不纳入 git.repo.read / git.repo.write /
    // web.browse 三档开关。三键必须【不存在】而非 false —— default-allow 下
    // 缺失即允许，写 false 恰好会拒绝外部助手，与决定相反。
    for (const key of EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS) {
      expect(EXTERNAL_AGENT_ROLE_CAPABILITIES).not.toHaveProperty(key);
      expect(isCapabilityGranted(EXTERNAL_AGENT_ROLE_CAPABILITIES, key)).toBe(
        true,
      );
    }
    expect(EXTERNAL_AGENT_ROLE_KEYS).toEqual([
      'sisyphus',
      'prometheus',
      'atlas',
    ]);
    for (const key of EXTERNAL_AGENT_ROLE_KEYS) {
      expect(BUILTIN_ROLE_CAPABILITY_MAPS[key]).toBeUndefined();
    }
  });

  it('ar_general-equivalent factory matrix has 15 allow and 14 deny', () => {
    const factory = buildFactoryCapabilityMatrix();
    // T11 三键（+1 allow / +2 deny）已于 2026-09-30 退役 ⇒ 15 allow / 14 deny。
    expect(
      Object.values(factory).filter((value) => value === true),
    ).toHaveLength(15);
    expect(
      Object.values(factory).filter((value) => value === false),
    ).toHaveLength(14);
    expect(factory['secret.command']).toBe(true);
    for (const retired of ['git.repo.read', 'git.repo.write', 'web.browse']) {
      expect(factory).not.toHaveProperty(retired);
    }
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

describe('secret.command upgrade migration (post-baseline 20260926000000)', () => {
  const sql = fs.readFileSync(SECRET_CAPABILITY_UPGRADE, 'utf8');
  const executable = executableSql(sql);

  it('存量 agent_roles 矩阵显式回填 secret.command=true（升级路径不依赖「缺失键=允许」）', () => {
    expect(executable).toMatch(/UPDATE\s+`agent_roles`/i);
    expect(executable).toContain('JSON_SET');
    expect(executable).toContain('secret.command');
    expect(executable).toContain('JSON_CONTAINS_PATH');
    expect(executable).toMatch(/\$\."secret\.command"/);
    expect(executable).toMatch(/WHERE/i);
  });

  it('只补新键：不改写其他能力点、不建 secret 表或列（无 DDL、无 JSON_REMOVE）', () => {
    expect(executable).not.toMatch(
      /CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE/i,
    );
    expect(executable).not.toMatch(/JSON_(REMOVE|OBJECT|MERGE)\(/i);
    expect(executable).not.toMatch(/^\s*(INSERT|DELETE)\s/im);
    expect(executable.match(/UPDATE\s+`agent_roles`/gi)).toHaveLength(1);
  });
});
