import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
  EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS,
} from '../common/constants/agent-role.constants';
import { isPlatformCapabilityKey } from '../common/constants/platform-capability.constants';

/**
 * Contract for migration `20260929000000_capability_git_web_tier` — **历史迁移**。
 *
 * ⚠️ 2026-09-30：本迁移写入的三个键（`git.repo.read` / `git.repo.write` /
 * `web.browse`）已由**后继**迁移 `20260930000000_capability_git_web_retire` 摘除，
 * 对应的岗位能力点亦整组退役（覆盖的 `git_*` / `browser` 是 worker 注入的本地工具，
 * 不经 platform-mcp ⇒ 服务端能力门结构上拦不到，从未生效过）。
 *
 * 因此本 spec 的职责从「校验三键回填值与 src 常量一致」**改为**「校验历史迁移的 SQL
 * 本身未被篡改」+「三键确已退役」。逐岗位回填值已无处可比（src 侧已无这三个键），
 * 那部分校验移交退役 spec 与 `platform-capability.coverage.spec`。
 *
 * 保留本 spec 的意义：历史迁移文件一旦被改写，升级链路的重放结果就会与已部署数据库
 * 不一致（本地已跑过、异地重放时值不同）——这是不可逆偏差，必须能在测试里发现。
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

const BASELINE_MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260925000000_squashed_baseline',
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
    it(`${key}：外部岗位零写入且出现在排除名单内（历史行为，不得回填为 false）`, () => {
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

  it('三键已从 src 侧彻底退役（后继迁移摘除，目录不再登记）', () => {
    for (const key of T11_KEYS) {
      expect(isPlatformCapabilityKey(key)).toBe(false);
    }
    for (const role of BUILTIN_KEYS) {
      for (const key of T11_KEYS) {
        expect(BUILTIN_ROLE_CAPABILITY_MAPS[role]).not.toHaveProperty(key);
      }
    }
    // 外部岗豁免名单随之清空：那三个键已不在目录，外部矩阵本就不发射它们。
    expect(EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS).toHaveLength(0);
    for (const key of T11_KEYS) {
      expect(EXTERNAL_AGENT_ROLE_CAPABILITIES).not.toHaveProperty(key);
    }
  });

  it('历史迁移仍写出三键（SQL 未被篡改，保证异地重放结果一致）', () => {
    // 本迁移文件一旦被改写，已部署库与异地重放会得到不同结果——不可逆偏差。
    for (const key of T11_KEYS) {
      expect(writtenFor(key)).toBeDefined();
      expect(parsed.some((a) => a.key === key)).toBe(true);
    }
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

  it('DDL 守卫：SET 到的列，要么建表时已存在，要么由本迁移 ADD COLUMN 补上', () => {
    const baseline = fs.readFileSync(BASELINE_MIGRATION, 'utf8');
    const createTable =
      /CREATE TABLE `agent_roles` \(([\s\S]*?)\n\) ENGINE=/.exec(baseline);
    expect(createTable).not.toBeNull();
    const baselineColumns = new Set(
      [...(createTable as RegExpExecArray)[1].matchAll(/^\s*`(\w+)`/gm)].map(
        (m) => m[1],
      ),
    );

    const sql = executableSql(fs.readFileSync(MIGRATION, 'utf8'));
    const setColumns = new Set(
      [...sql.matchAll(/UPDATE\s+`agent_roles`\s+SET\s+`(\w+)`/g)].map(
        (m) => m[1],
      ),
    );
    expect(setColumns.size).toBeGreaterThan(0);
    const addedHere = new Set(
      [...sql.matchAll(/ADD COLUMN\s+`(\w+)`/g)].map((m) => m[1]),
    );

    expect(
      [...setColumns].filter(
        (c) => !baselineColumns.has(c) && !addedHere.has(c),
      ),
    ).toEqual([]);
  });
});
