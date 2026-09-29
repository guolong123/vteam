import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_KEYS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS,
} from '../common/constants/agent-role.constants';
import { isCapabilityGranted } from '../common/constants/platform-capability.constants';

/**
 * Contract for migration `20260929000000_capability_git_web_tier`.
 *
 * The three T11 keys are absent from every pre-existing `agent_roles.capabilities`
 * row (they were introduced together with the catalog), and seed only backfills
 * `capabilities IS NULL`. So after this migration runs, every row that does not
 * appear here gains the new keys **by default-allow** — the migration is the only
 * place that can pin them down. It therefore has to be exact in both directions:
 *
 * - the 7 builtin roles get the value derived from `ROLE_BOUNDARIES.toolAllows`
 *   (asserted here against the very constants the runtime uses, so the migration
 *   cannot silently drift from them);
 * - the 3 external roles must receive **nothing** — the user decided external
 *   assistants keep their own git/browser capability, and writing `false` would
 *   deny exactly what that decision preserved.
 */

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260929000000_capability_git_web_tier',
  'migration.sql',
);

const T11_KEYS = ['git.repo.read', 'git.repo.write', 'web.browse'] as const;

const BUILTIN_KEYS = BUILTIN_AGENT_ROLES.map((role) => role.key);

function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

type Assignment = {
  key: string;
  value: boolean;
  keys: string[];
  negated: boolean;
};

/**
 * Parse the migration into its per-key assignments.
 *
 * Stripping `--` lines first is load-bearing, not cosmetic: the migration keeps a
 * **commented-out** `WHERE \`key\` IN ('sisyphus', …)` on purpose, to record that a
 * blanket backfill was deliberately removed. It carries no semicolon, so a naive
 * parse fuses it onto the following statement and reports the external roles as
 * being written — the opposite of what the file does.
 */
function assignments(): Assignment[] {
  const sql = executableSql(fs.readFileSync(MIGRATION, 'utf8'));
  const jsonSet =
    /JSON_SET\(\s*`capabilities`\s*,\s*'([^']+)'\s*,\s*(true|false)\s*\)/g;
  const keyFilter = /`key`\s+(NOT\s+IN|IN)\s*\(([^)]*)\)/g;
  const parsed: Assignment[] = [];
  for (const stmt of sql.split(';')) {
    if (!stmt.includes('JSON_SET')) continue;
    const set = new RegExp(jsonSet.source).exec(stmt);
    const where = new RegExp(keyFilter.source).exec(stmt);
    if (!set || !where) continue;
    parsed.push({
      key: set[1].replace('$."', '').replace('"', ''),
      value: set[2] === 'true',
      keys: [...where[2].matchAll(/'([\w]+)'/g)].map((m) => m[1]),
      negated: where[1].toUpperCase().replace(/\s+/g, '') === 'NOTIN',
    });
  }
  return parsed;
}

describe('T11 三键存量回填迁移 20260929000000', () => {
  const parsed = assignments();

  /** 该键被写入的行 = 所有非 NOT IN 命中该键的语句里的岗位 */
  const writtenFor = (capabilityKey: string): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const a of parsed) {
      if (a.key !== capabilityKey || a.negated) continue;
      for (const k of a.keys) out[k] = a.value;
    }
    return out;
  };

  it('每条语句都写且仅写一个 T11 键；每个键都有一条 NOT IN 语句覆盖其余行', () => {
    // 显式岗位的条数随派生结果而变（read 2 条、write 2 条、browse 1 条——7 岗 browse 全 true），
    // 所以这里断言「结构」而非「固定条数」：每键必有 1 条 NOT IN，且 NOT IN 名单恒含全部 10 岗。
    for (const a of parsed) {
      expect(T11_KEYS).toContain(a.key as (typeof T11_KEYS)[number]);
    }
    for (const key of T11_KEYS) {
      const negated = parsed.filter((a) => a.key === key && a.negated);
      expect(negated).toHaveLength(1);
      expect(negated[0].keys).toEqual(
        expect.arrayContaining([...BUILTIN_KEYS, ...EXTERNAL_AGENT_ROLE_KEYS]),
      );
      expect(negated[0].keys).toHaveLength(
        BUILTIN_KEYS.length + EXTERNAL_AGENT_ROLE_KEYS.length,
      );
    }
  });

  for (const key of T11_KEYS) {
    it(`${key}：迁移写入值与 src 常量逐岗位一致（7 内置）`, () => {
      const written = writtenFor(key);
      for (const role of BUILTIN_KEYS) {
        const expected = BUILTIN_ROLE_CAPABILITY_MAPS[role][key];
        expect(typeof expected).toBe('boolean');
        expect(written[role]).toBe(expected);
      }
    });
  }

  for (const key of T11_KEYS) {
    it(`${key}：外部岗位零写入且出现在排除名单内（不得回填为 false）`, () => {
      const written = writtenFor(key);
      for (const role of EXTERNAL_AGENT_ROLE_KEYS) {
        expect(written[role]).toBeUndefined();
      }
      const excluded = parsed
        .filter((a) => a.negated && a.key === key)
        .flatMap((a) => a.keys);
      for (const role of EXTERNAL_AGENT_ROLE_KEYS) {
        expect(excluded).toContain(role);
      }
    });
  }

  it('外部岗位经本迁移后仍「缺失即允许」（用户决定：不纳入三档管控）', () => {
    for (const key of EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS) {
      expect(EXTERNAL_AGENT_ROLE_CAPABILITIES).not.toHaveProperty(key);
      expect(isCapabilityGranted(EXTERNAL_AGENT_ROLE_CAPABILITIES, key)).toBe(
        true,
      );
    }
  });

  it('其余行（ar_general + 历史自定义）走出厂值 read=T / write=F / browse=F', () => {
    // ar_general 不在任何 IN 名单里，它是靠 NOT IN 语句被覆盖的。
    const viaExclusion = (key: string): boolean | undefined => {
      const stmt = parsed.find((a) => a.negated && a.key === key);
      return stmt && !stmt.keys.includes('ar_general') ? stmt.value : undefined;
    };
    expect(viaExclusion('git.repo.read')).toBe(true);
    expect(viaExclusion('git.repo.write')).toBe(false);
    expect(viaExclusion('web.browse')).toBe(false);
  });

  it('只增不改：每条语句都以「该键缺失」为守卫（不覆盖运营者已显式的值）', () => {
    for (const stmt of executableSql(fs.readFileSync(MIGRATION, 'utf8')).split(
      ';',
    )) {
      if (!stmt.includes('JSON_SET')) continue;
      expect(stmt).toContain('JSON_CONTAINS_PATH');
      expect(stmt).toMatch(/JSON_CONTAINS_PATH\([^)]*'one'/);
      expect(stmt).toContain('capabilities` IS NOT NULL');
    }
  });

  it('非 NULL 矩阵行一律打戳（capabilities_configured_at）', () => {
    const sql = executableSql(fs.readFileSync(MIGRATION, 'utf8'));
    const stamp =
      /UPDATE\s+`agent_roles`\s+SET\s+`capabilities_configured_at`/i;
    expect(sql).toMatch(stamp);
    expect(sql).toMatch(
      /`capabilities` IS NOT NULL[\s\S]{0,80}`capabilities_configured_at` IS NULL/i,
    );
  });
});
