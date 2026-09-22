import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
} from '../common/constants/agent-role.constants';
import {
  buildFactoryCapabilityMatrix,
  PLATFORM_CAPABILITY_KEYS,
} from '../common/constants/platform-capability.constants';

/**
 * 迁移契约：`20260921000009_split_grouped_capabilities`（组能力点拆分，选项 (b)）。
 *
 * 背景：能力目录 21 → 27 点——`issue.manage` 拆 5 点、`memory.manage` 拆 3 点，
 * 消除「全部成员工具放行才 true」派生在岗位只放行组内部分工具时的组塌缩
 * （architect/tester × issue、plan/librarian × memory 共 4 格）。`hook.manage`
 * 保持成组（27 点覆盖 28 工具，恰一项覆盖 2 工具）。
 *
 * 关键证明（与 000007/000008 契约同形状，逐字面量锁 TS 常量）：
 *   1. 恰 11 条 UPDATE = 7 内置岗 + 外部 3 岗 + ar_general，每字面量恰 27 键
 *      且不含 `issue.manage`/`memory.manage`；
 *   2. 7 内置岗字面量逐键 ≡ `BUILTIN_ROLE_CAPABILITY_MAPS`（SQL↔TS 单一来源防漂移）；
 *   3. 外部 3 岗字面量逐键 ≡ `EXTERNAL_AGENT_ROLE_CAPABILITIES`（8 true / 19 false，
 *      最小权限不放宽）；`ar_general` 字面量 ≡ `buildFactoryCapabilityMatrix()`
 *      （13 allow / 14 deny）；
 *   4. `project_manager` 字面量 = 全 27 点 true（显式覆盖，不按边界派生）；
 *   5. 四个原组塌缩格在字面量中已打开：architect issue.create/get/list=true、
 *      tester issue.create/get/list/transition=true、plan/librarian memory.search=true，
 *      且写侧兄弟格（issue.update/transition、memory.save/update）保持按边界 false；
 *   6. 范围守卫：内置行 type='builtin' AND key=单值；外部/general 行 key=单值
 *      （key 全表唯一）；无 `key` IN ( 批量守卫；
 *   7. 不使用 JSON_SET/JSON_REMOVE/JSON_OBJECT（不存在路径返回 NULL 置空整列的陷阱
 *      在整列 CAST 字面量覆盖下不适用），写入值恒非 NULL；
 *   8. 幂等：SET 右值为常量字面量、不引用列自身，重跑零变化。
 * 真库 fresh/upgrade 双路径演练记录在 notepad（scratch DB 证明）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260921000009_split_grouped_capabilities',
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

const RETIRED_KEYS = ['issue.manage', 'memory.manage'] as const;

interface UpdateRow {
  literal: Record<string, boolean>;
  /** WHERE 子句原文（守卫断言用）。 */
  where: string;
}

/** 逐条提取「整列 CAST 字面量 + WHERE 守卫」（11 条：7 内置 + 3 外部 + general）。 */
function extractUpdates(sql: string): UpdateRow[] {
  const re =
    /SET `capabilities` = CAST\('(\{[^']+\})' AS JSON\)\s+WHERE([^;]+);/g;
  const out: UpdateRow[] = [];
  for (const m of sql.matchAll(re)) {
    out.push({ literal: JSON.parse(m[1] as string), where: (m[2] as string).trim() });
  }
  return out;
}

function builtinWhere(key: string): string {
  return `\`type\` = 'builtin'\n   AND \`key\` = '${key}'`;
}

describe('20260921000009 拆分组能力点（迁移契约）', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const executable = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  const rows = extractUpdates(executable);

  it('头注释声明 拆分/组塌缩/27 点/hook.manage 成组/JSON_SET 陷阱/外部岗最小矩阵/单向迁移/单一来源常量', () => {
    for (const marker of [
      '拆分',
      '组塌缩',
      '27',
      'hook.manage',
      'JSON_SET',
      '外部 3 岗',
      '单向迁移',
      'BUILTIN_ROLE_CAPABILITY_MAPS',
      'EXTERNAL_AGENT_ROLE_CAPABILITIES',
    ]) {
      expect(sql).toContain(marker);
    }
  });

  it('恰 11 条 UPDATE；右值为 CAST 字面量（不引用列自身 ⇒ 幂等）；无 JSON_SET/JSON_REMOVE/JSON_OBJECT', () => {
    expect(executable.match(/SET `capabilities` =/g) ?? []).toHaveLength(11);
    expect(executable).not.toMatch(/JSON_SET|JSON_REMOVE|JSON_OBJECT/);
    expect(rows).toHaveLength(11);
  });

  it('每条字面量恰 27 键（= 目录键全集），且不含已拆分的组键 issue.manage/memory.manage', () => {
    expect(PLATFORM_CAPABILITY_KEYS).toHaveLength(27);
    for (const { literal } of rows) {
      expect(Object.keys(literal)).toEqual([...PLATFORM_CAPABILITY_KEYS]);
      for (const retired of RETIRED_KEYS) {
        expect(Object.keys(literal)).not.toContain(retired);
      }
      for (const value of Object.values(literal)) {
        expect(typeof value).toBe('boolean');
      }
    }
  });

  it('7 内置岗字面量逐键 ≡ BUILTIN_ROLE_CAPABILITY_MAPS（键序 = 目录序，SQL↔TS 单一来源防漂移）', () => {
    const builtins = rows.filter((r) => r.where.includes(`\`type\` = 'builtin'`));
    expect(builtins).toHaveLength(7);
    const keys = builtins.map((r) => {
      const m = r.where.match(/AND `key` = '([a-z_]+)'/);
      expect(m).not.toBeNull();
      return m?.[1] as string;
    });
    expect(keys).toEqual([...BUILTIN_KEYS]);
    for (const key of keys) {
      expect(rows.find((r) => r.where.includes(`'${key}'`))?.literal).toEqual(
        BUILTIN_ROLE_CAPABILITY_MAPS[key],
      );
    }
  });

  it('project_manager 字面量 = 全 27 点 true（显式覆盖，不按边界派生）', () => {
    const pm = rows.find((r) => r.where.includes(`'project_manager'`));
    expect(pm).toBeDefined();
    expect(Object.keys(pm!.literal)).toHaveLength(27);
    expect(Object.values(pm!.literal).every((v) => v === true)).toBe(true);
  });

  it('外部 3 岗字面量逐键 ≡ EXTERNAL_AGENT_ROLE_CAPABILITIES（8 true / 19 false，最小权限不放宽）', () => {
    expect(Object.values(EXTERNAL_AGENT_ROLE_CAPABILITIES).filter((v) => v === true)).toHaveLength(8);
    expect(Object.values(EXTERNAL_AGENT_ROLE_CAPABILITIES).filter((v) => v === false)).toHaveLength(19);
    for (const key of EXTERNAL_AGENT_ROLE_KEYS) {
      const row = rows.find((r) => r.where.includes(`\`key\` = '${key}'`));
      expect(row).toBeDefined();
      expect(row!.literal).toEqual(EXTERNAL_AGENT_ROLE_CAPABILITIES);
      expect(row!.where).not.toContain('type');
    }
  });

  it('ar_general 字面量 ≡ 出厂矩阵（13 allow / 14 deny）', () => {
    const factory = buildFactoryCapabilityMatrix();
    expect(Object.values(factory).filter((v) => v === true)).toHaveLength(13);
    expect(Object.values(factory).filter((v) => v === false)).toHaveLength(14);
    const general = rows.find((r) => r.where.includes(`\`key\` = 'general'`));
    expect(general).toBeDefined();
    expect(general!.literal).toEqual(factory);
  });

  it('四个原组塌缩格已打开，且写侧兄弟格保持按边界 false', () => {
    const literalOf = (key: string): Record<string, boolean> => {
      const row = rows.find((r) => r.where.includes(`'${key}'`));
      expect(row).toBeDefined();
      return row!.literal;
    };
    const architect = literalOf('architect');
    for (const k of ['issue.create', 'issue.get', 'issue.list']) {
      expect(`${k}=${architect[k]}`).toBe(`${k}=true`);
    }
    for (const k of ['issue.update', 'issue.transition']) {
      expect(`${k}=${architect[k]}`).toBe(`${k}=false`);
    }
    const tester = literalOf('tester');
    for (const k of ['issue.create', 'issue.get', 'issue.list', 'issue.transition']) {
      expect(`${k}=${tester[k]}`).toBe(`${k}=true`);
    }
    expect(`issue.update=${tester['issue.update']}`).toBe('issue.update=false');
    for (const roleKey of ['plan', 'librarian']) {
      const role = literalOf(roleKey);
      expect(`memory.search=${role['memory.search']}`).toBe('memory.search=true');
      expect(`memory.save=${role['memory.save']}`).toBe('memory.save=false');
      expect(`memory.update=${role['memory.update']}`).toBe('memory.update=false');
    }
  });

  it('范围守卫：内置行 type=builtin AND key=单值；外部/general 行 key=单值；无 key IN ( 批量守卫', () => {
    for (const key of BUILTIN_KEYS) {
      expect(executable).toContain(builtinWhere(key));
    }
    for (const key of [...EXTERNAL_AGENT_ROLE_KEYS, 'general']) {
      expect(executable).toContain(`WHERE \`key\` = '${key}';`);
    }
    expect(executable).not.toContain('`key` IN (');
    // 外部/general 守卫不含 type 条件（key 全表唯一即可单行命中）。
    const nonBuiltins = rows.filter((r) => !r.where.includes('type'));
    expect(nonBuiltins).toHaveLength(4);
    expect(rows.filter((r) => r.where.includes('type'))).toHaveLength(7);
  });
});
