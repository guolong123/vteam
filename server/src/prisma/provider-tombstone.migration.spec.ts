import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract for migration `20261030050000_provider_tombstone`（Provider 删除意图表）。
 *
 * 存在理由：与 `model-usage.migration.spec.ts` 同源——本仓本机/CI 无 MySQL，
 * 手写 DDL 没有真跑机会，schema.prisma 与 migration.sql 一旦漂移只有生产 init job
 * 会炸（PR #36 教训：schema 声明了、迁移没建 → ERROR 1054）。本 spec 把
 * 「schema 里有的东西，迁移链里必须有对应 DDL」双向钉死。
 *
 * 语义背景（删除不复活）：DELETE /models/providers/:providerID 落一行 tombstone，
 * sync/快照上报/listProviders 据此忽略外部 worker 对同名 provider 的 live 上报；
 * 显式重新添加（保存凭据、新建模型）清除该行。表极小、纯意图记录——主键即
 * provider_id 本体（无 md_/us_ 前缀 id，不走 IdGeneratorService）。
 *
 * 校验五件事：
 * 1. schema 存在 `model ProviderTombstone` 且 @@map 到 provider_tombstones；
 * 2. DDL 列与 schema 列**双向平价**（provider_id/deleted_at）；
 * 3. 主键是 provider_id（单列 PK，无 DEFAULT——id 语义即 provider 本身）；
 * 4. 零回填、不建外键（删除意图不参与任何域的删除编排）；
 * 5. 只建这一张表：不 ALTER / DROP / RENAME 既有表。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261030050000_provider_tombstone',
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

const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const TABLE = 'provider_tombstones';
const EXPECTED_COLUMNS = ['provider_id', 'deleted_at'] as const;

const sql = () => fs.readFileSync(MIGRATION, 'utf8');
const baselineSql = () => fs.readFileSync(BASELINE_MIGRATION, 'utf8');
const schema = () => fs.readFileSync(SCHEMA, 'utf8');

/** 去掉 `--` 注释行与空行，只留可执行 DDL。 */
function statements(): string[] {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const createdTables = (): string[] =>
  [...sql().matchAll(/CREATE TABLE\s+`(\w+)`/g)].map((m) => m[1]);

/** 本迁移 `CREATE TABLE` 语句块的列名（列定义行；PRIMARY KEY/KEY 行不计）。 */
function createdColumns(table: string): Set<string> {
  const m = new RegExp(
    `CREATE TABLE \`${table}\` \\(([\\s\\S]*?)\\n\\) ENGINE=`,
  ).exec(sql());
  if (!m) throw new Error(`迁移未找到 ${table} 建表语句`);
  return new Set([...m[1].matchAll(/^\s*`(\w+)`\s+/gm)].map((x) => x[1]));
}

/** schema.prisma 里 `model ProviderTombstone` 的数据库列名（@map 优先）。 */
function schemaTombstoneColumns(): Set<string> {
  const m = /^model ProviderTombstone \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model ProviderTombstone');
  const cols = new Set<string>();
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
    const c = /^(\w+)\s+\w/.exec(t);
    if (!c) continue;
    const mapped = /@map\("(\w+)"\)/.exec(t);
    cols.add(mapped ? mapped[1] : c[1]);
  }
  return cols;
}

describe('migration 20261030050000_provider_tombstone', () => {
  it('schema.prisma 声明 model ProviderTombstone 且 @@map 到 provider_tombstones', () => {
    expect(schema()).toMatch(/model ProviderTombstone \{/);
    const m = /^model ProviderTombstone \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toContain('@@map("provider_tombstones")');
  });

  it('DDL → schema 正向平价：迁移建的列在 model ProviderTombstone 里都存在', () => {
    const cols = createdColumns(TABLE);
    expect(cols.size).toBeGreaterThan(0);
    for (const col of cols) {
      expect(schemaTombstoneColumns().has(col)).toBe(true);
    }
  });

  it('schema → DDL 反向平价：schema 声明的列都被本迁移建出来（漏建 → 运行时 P2022）', () => {
    const ddl = createdColumns(TABLE);
    for (const col of schemaTombstoneColumns()) {
      expect(ddl.has(col)).toBe(true);
    }
    // 契约列恰为 provider_id + deleted_at，无多余列。
    expect([...schemaTombstoneColumns()].sort()).toEqual(
      [...EXPECTED_COLUMNS].sort(),
    );
  });

  it('主键即 provider_id（单列 PK、无 DEFAULT；无 id 列、不走 IdGeneratorService）', () => {
    expect(sql()).toMatch(/`provider_id`\s+varchar\(191\)[^,\n]*NOT NULL/i);
    expect(sql()).not.toMatch(/`provider_id`[^,\n]*DEFAULT/i);
    expect(sql()).toMatch(/PRIMARY KEY \(`provider_id`\)/);
    // schema 侧：providerID 直接 @id（经 @map 落到 provider_id）。
    const m = /^model ProviderTombstone \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toMatch(/providerID\s+String\s+@id\s+@map\("provider_id"\)/);
    expect(createdColumns(TABLE).has('id')).toBe(false);
  });

  it('deleted_at NOT NULL DEFAULT CURRENT_TIMESTAMP(3)（删除意图必须有时刻）', () => {
    expect(sql()).toMatch(
      /`deleted_at`\s+datetime\(3\)\s+NOT NULL\s+DEFAULT CURRENT_TIMESTAMP\(3\)/i,
    );
    const m = /^model ProviderTombstone \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toMatch(/deletedAt\s+DateTime\s+@default\(now\(\)\)/);
  });

  it('零回填、不建外键（删除意图不参与任何域的删除编排）', () => {
    expect(sql()).not.toMatch(/\bUPDATE\b/i);
    expect(sql()).not.toMatch(/\bINSERT\b/i);
    expect(sql()).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql()).not.toMatch(/FOREIGN\s+KEY/i);
    expect(sql()).not.toMatch(/CONSTRAINT/i);
    const m = /^model ProviderTombstone \{([\s\S]*?)^\}/m.exec(schema());
    // 无 relations：字段仅 String/DateTime 标量（数组类型与 @relation 只会来自关联声明）。
    expect(m?.[1]).not.toMatch(/@relation/);
    expect(m?.[1]).not.toMatch(/\[\]/);
  });

  it('DDL 守卫：baseline 迁移里不含 provider_tombstones（否则重复建表 → ERROR 1057）', () => {
    expect(baselineSql()).not.toMatch(/provider_tombstones/);
  });

  it('只建这一张表：不 ALTER / DROP / RENAME 既有表', () => {
    expect(statements()).toHaveLength(1);
    expect(statements()[0]).toMatch(
      new RegExp(`^CREATE TABLE \`${TABLE}\``, 'i'),
    );
    expect(createdTables()).toEqual([TABLE]);

    expect(sql()).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql()).not.toMatch(/DROP\s+TABLE/i);
    expect(sql()).not.toMatch(/RENAME\s+/i);
    expect(sql()).not.toMatch(/\bTRUNCATE\b/i);
  });
});
