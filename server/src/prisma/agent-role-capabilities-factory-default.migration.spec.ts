import * as fs from 'fs';
import * as path from 'path';

/**
 * 迁移契约：`20260921000007_builtin_role_capabilities_factory_default`。
 *
 * 用户决策「内置角色拉平到出厂默认」：把 7 个内置岗位的 `capabilities` 从
 * 000006 的保守派生整体覆盖为目录出厂默认矩阵。
 *
 * 注（2026-09-22 组能力点拆分）：本迁移 SQL 由 checksum ledger 冻结（21 点时代字面量），
 * 不再与已演进为 27 点的 `buildFactoryCapabilityMatrix()` 做逐键相等断言；**当前**出厂
 * 矩阵（13 allow / 14 deny）与 TS 常量的锁定由 `agent-role-capabilities-split-grouped.
 * migration.spec.ts`（000009，ar_general 行）承担。本 spec 只保留 000007 的结构契约：
 *
 *   1. 恰一条 UPDATE；右值为整列 CAST 字面量（不引用列自身 ⇒ 幂等）；
 *   2. 范围守卫只命中 7 个内置 key（type='builtin'），外部 3 岗 / ar_general 不在集合；
 *   3. 不使用 JSON_SET/JSON_REMOVE（MySQL 对不存在路径返回 NULL 会置空整列的陷阱，
 *      在整列 CAST 字面量覆盖下不适用），写入值恒非 NULL。
 * 真库 fresh/upgrade 双路径演练记录在 notepad（scratch DB 证明）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260921000007_builtin_role_capabilities_factory_default',
  'migration.sql',
);

const BUILTIN_KEYS = [
  'product',
  'project_manager',
  'architect',
  'developer',
  'tester',
  'plan',
  'librarian',
] as const;

const EXTERNAL_KEYS = ['sisyphus', 'prometheus', 'atlas'] as const;

describe('20260921000007 内置岗位拉平到出厂默认（迁移契约）', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const executable = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

  it('头注释声明 出厂默认 / JSON_SET 陷阱 / 外部岗不触碰 / 单向迁移', () => {
    for (const marker of [
      '出厂默认',
      'JSON_SET',
      'JSON_CONTAINS_PATH',
      '外部 3 岗',
      '单向迁移',
    ]) {
      expect(sql).toContain(marker);
    }
  });

  it('恰一条 UPDATE 覆盖 capabilities；右值为 CAST 字面量（不引用列自身 ⇒ 幂等）', () => {
    const updates = executable.match(/SET `capabilities` =/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(executable).toMatch(
      /SET `capabilities` = CAST\('\{[^']+\}' AS JSON\)/,
    );
    expect(executable).not.toMatch(/JSON_SET|JSON_REMOVE/);
  });

  it('覆盖字面量为合法布尔对象（内容为拆分前历史快照，当前出厂锁定见 000009 契约 spec）', () => {
    const literal = executable.match(/CAST\('(\{[^']+\})' AS JSON\)/);
    expect(literal).not.toBeNull();
    const parsed = JSON.parse(literal?.[1] ?? '{}') as Record<string, boolean>;
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    for (const value of Object.values(parsed)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('范围守卫：type=builtin 且 key IN 恰 7 内置 key；外部岗 / general 不可命中', () => {
    expect(executable).toMatch(/WHERE `type` = 'builtin'/);
    const inList = executable.match(/AND `key` IN \(([^)]+)\)/);
    expect(inList).not.toBeNull();
    const keys = (inList?.[1] ?? '')
      .split(',')
      .map((k) => k.trim().replace(/^'|'$/g, ''));
    expect(keys).toEqual([...BUILTIN_KEYS]);
    for (const external of EXTERNAL_KEYS) {
      expect(keys).not.toContain(external);
      expect(executable).not.toContain(`'${external}'`);
    }
    expect(keys).not.toContain('general');
  });
});
