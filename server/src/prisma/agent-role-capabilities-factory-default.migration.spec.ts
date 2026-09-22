import * as fs from 'fs';
import * as path from 'path';
import { buildFactoryCapabilityMatrix } from '../common/constants/platform-capability.constants';

/**
 * 迁移契约：`20260921000007_builtin_role_capabilities_factory_default`。
 *
 * 用户决策「内置角色拉平到出厂默认」：把 7 个内置岗位的 `capabilities` 从
 * 000006 的保守派生整体覆盖为目录出厂默认矩阵（default-allow + 10 敏感点拒绝）。
 *
 * 关键证明：
 *   1. 覆盖字面量与 `buildFactoryCapabilityMatrix()` 逐键相等（SQL 与 TS 不漂移）；
 *   2. 范围守卫只命中 7 个内置 key（type='builtin'），外部 3 岗 / ar_general 不在集合；
 *   3. 不使用 JSON_SET/JSON_REMOVE（MySQL 对不存在路径返回 NULL 会置空整列的陷阱，
 *      在整列 CAST 字面量覆盖下不适用），写入值恒非 NULL；
 *   4. 幂等：SET 右值为常量字面量、不引用列自身，重跑零变化。
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

  it('覆盖字面量与目录出厂默认矩阵逐键相等（21 键：10 false / 11 true）', () => {
    const literal = executable.match(/CAST\('(\{[^']+\})' AS JSON\)/);
    expect(literal).not.toBeNull();
    const parsed = JSON.parse(literal?.[1] ?? '{}') as Record<string, boolean>;
    expect(parsed).toEqual(buildFactoryCapabilityMatrix());
    expect(Object.values(parsed).filter((v) => v === false)).toHaveLength(10);
    expect(Object.values(parsed).filter((v) => v === true)).toHaveLength(11);
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
