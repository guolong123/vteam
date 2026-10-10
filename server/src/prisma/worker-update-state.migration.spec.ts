import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract for migration `20261010030000_worker_update_state`（自更新状态 + 回滚标志）。
 *
 * 与 `worker-code-version.migration.spec.ts`（Wave 1）同源同结构：PR #36 曾因
 * `ALTER TABLE ... ADD COLUMN` 缺失而在真实部署时 `ERROR 1054` 炸掉 init job
 * （schema 声明了列、迁移没建列）。本 spec 把「schema 里有的列，迁移链里必须有
 * 对应 DDL」钉死，并额外把「手写 DDL == Prisma 自产 DDL」这条等价性也钉住。
 *
 * ⚠️ 本仓库本机/CI 无 MySQL（`nc -z localhost 3306` 不通），故本迁移是**手写 DDL**。
 * 真跑 SQL 的机会为零 ⇒ **本 spec 是这份 DDL 的唯一护栏**。
 *
 * 校验：
 * 1. schema.prisma 的 Worker 声明 updateState/rolledBack（@map 到 update_state/rolled_back）；
 * 2. 本迁移 ADD COLUMN 的列在 schema 里都存在（正向平价）；
 * 3. 反向平价：这两列都由本迁移建出（漏建列 → 运行时 P2022）；
 * 4. DDL 守卫：两列在 baseline 与**前序迁移**里都不存在（否则重复建列 → ERROR 1060）；
 * 5. 零回填：迁移无任何 UPDATE/INSERT/DELETE（存量 worker 的更新状态无从重建）；
 * 6. 列语义：update_state 可空 varchar（NULL=从未上报）；rolled_back NOT NULL DEFAULT false
 *    （二态，UI 不用处理 null）；
 * 7. 不删任何东西，只 ALTER workers 一张表，不建索引；
 * 8. 与 Prisma 自产 DDL 等价（列名/类型/默认值逐字，忽略大小写与 NULL 写法）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261010030000_worker_update_state',
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

/** 前序迁移（Wave 1 的 code_version）：本迁移不得重复建它建过的列。 */
const PREV_MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261010020000_worker_code_version',
  'migration.sql',
);

const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const sql = () => fs.readFileSync(MIGRATION, 'utf8');
const baselineSql = () => fs.readFileSync(BASELINE_MIGRATION, 'utf8');
const prevSql = () => fs.readFileSync(PREV_MIGRATION, 'utf8');
const schema = () => fs.readFileSync(SCHEMA, 'utf8');

/**
 * 只留可执行 DDL（去掉 `--` 注释行与空行）——结构性断言必须在**语句**上做，
 * 不能在注释上做（文件头的说明文字本身就会含 `UPDATE`/`DEFAULT` 等词）。
 */
function ddl(): string {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

function statements(): string[] {
  return ddl()
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 本迁移 ADD COLUMN 的列名集合。 */
const addedColumns = (): string[] =>
  [...ddl().matchAll(/ADD COLUMN\s+`(\w+)`/gi)].map((m) => m[1]);

/** 本迁移 ALTER 的表名集合。 */
const alteredTables = (): string[] =>
  [...ddl().matchAll(/ALTER TABLE\s+`(\w+)`/gi)].map((m) => m[1]);

/** schema.prisma 里 `model Worker` 的数据库列名集合（@map 优先）。 */
function schemaWorkerColumns(): Set<string> {
  const m = /^model Worker \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model Worker');
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

/** baseline 里 `workers` 建表语句的列名集合。 */
function baselineWorkerColumns(): Set<string> {
  const m = /CREATE TABLE `workers` \(([\s\S]*?)\n\) ENGINE=/.exec(
    baselineSql(),
  );
  if (!m) throw new Error('baseline 未找到 workers 建表语句');
  return new Set([...m[1].matchAll(/^\s*`(\w+)`/gm)].map((x) => x[1]));
}

/** 本迁移负责的两列。 */
const NEW_COLUMNS = ['update_state', 'rolled_back'];

/**
 * Prisma 自产 DDL（离线 `prisma migrate diff --from-schema-datamodel <迁移前 schema>
 * --to-schema-datamodel prisma/schema.prisma --script` 的输出）。
 * 保留在此作为等价性判据：手写 DDL 改了而这里没改，spec 即红。
 */
const PRISMA_GENERATED_DDL = `ALTER TABLE \`workers\` ADD COLUMN \`rolled_back\` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN \`update_state\` VARCHAR(191) NULL;`;

/**
 * 归一化列定义：去反引号、压空白、转小写，并把 `NULL` 与 `DEFAULT NULL` 视作同一语义
 * （二者都是「可空、无默认值」，MySQL 接受且行为一致；Prisma 自产前者、本仓手写后者，
 * 差异纯属写法而非 DDL 语义）。NOT NULL / DEFAULT false 不会被这条规则碰到——
 * 它们一旦出现就会原样留在归一化结果里，spec 立即红。
 */
function normalizeColumnSpecs(sqlText: string): string[] {
  return [...sqlText.matchAll(/ADD COLUMN\s+`?(\w+)`?\s+([^,;]+)/gi)].map(
    ([, col, spec]) =>
      `${col.toLowerCase()}:${spec
        .trim()
        .toLowerCase()
        .replace(/\s+default\s+null\b/, ' null')}`,
  );
}

describe('migration 20261010030000_worker_update_state', () => {
  it('schema.prisma 的 Worker 声明 updateState（@map update_state）', () => {
    const m = /^model Worker \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toMatch(/updateState\s+String\?\s+@map\("update_state"\)/);
  });

  it('schema.prisma 的 Worker 声明 rolledBack（@map rolled_back，默认 false）', () => {
    const m = /^model Worker \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toMatch(
      /rolledBack\s+Boolean\s+@default\(false\)\s+@map\("rolled_back"\)/,
    );
  });

  it('本迁移 ADD COLUMN 的列在 schema.prisma 的 Worker 里都存在（正向平价）', () => {
    const added = addedColumns();
    expect(added.length).toBeGreaterThan(0);

    const cols = schemaWorkerColumns();
    for (const col of added) {
      expect(cols.has(col)).toBe(true);
    }
  });

  it('两列确实由本迁移建出，且只 ALTER workers 一张表（漏建 → 运行时 P2022）', () => {
    expect(addedColumns().sort()).toEqual([...NEW_COLUMNS].sort());
    expect(alteredTables()).toEqual(['workers']);
    expect(statements()).toHaveLength(1);
    expect(statements()[0]).toMatch(/^ALTER TABLE `workers`/i);
  });

  it('DDL 守卫：两列在 baseline 与前序迁移里都不存在（否则重复建列 → ERROR 1060）', () => {
    const baselineCols = baselineWorkerColumns();
    for (const col of addedColumns()) {
      expect(baselineCols.has(col)).toBe(false);
    }
    const prevDdl = prevSql()
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    for (const col of addedColumns()) {
      expect(prevDdl).not.toMatch(
        new RegExp(`ADD COLUMN\\s+\`?${col}\`?`, 'i'),
      );
    }
    // 前序迁移自己建的 code_version 不被本迁移重建
    expect(addedColumns()).not.toContain('code_version');
  });

  it('零回填：迁移无任何 UPDATE/INSERT/DELETE（存量 worker 的更新状态无从重建）', () => {
    expect(ddl()).not.toMatch(/\bUPDATE\b/i);
    expect(ddl()).not.toMatch(/\bINSERT\b/i);
    expect(ddl()).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('update_state 可空 varchar（NULL = 从未上报；191 = 本仓字符串列统一宽度）', () => {
    expect(ddl()).toMatch(
      /ADD COLUMN\s+`update_state`\s+varchar\(191\)\s+DEFAULT NULL/i,
    );
    expect(ddl()).not.toMatch(/`update_state`[^,]*NOT NULL/i);
  });

  it('rolled_back NOT NULL DEFAULT false（二态：UI 不必处理 null）', () => {
    expect(ddl()).toMatch(
      /ADD COLUMN\s+`rolled_back`\s+boolean\s+NOT NULL\s+DEFAULT false/i,
    );
    expect(ddl()).not.toMatch(/`rolled_back`[^,]*DEFAULT NULL/i);
  });

  it('不建索引（workers 行数个位数，两列只整行读回 → 索引只有写放大）', () => {
    expect(ddl()).not.toMatch(/CREATE\s+INDEX/i);
    expect(ddl()).not.toMatch(/ADD\s+(KEY|INDEX)/i);
    const m = /^model Worker \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).not.toMatch(/@@index\(\[[^\]]*(updateState|rolledBack)/i);
  });

  it('不删列/索引/表，且不动 workers 以外的表（不可逆 DDL + 无关漂移）', () => {
    expect(ddl()).not.toMatch(/DROP\s+COLUMN/i);
    expect(ddl()).not.toMatch(/DROP\s+INDEX/i);
    expect(ddl()).not.toMatch(/DROP\s+TABLE/i);
    expect(ddl()).not.toMatch(/RENAME\s+/i);
    expect(ddl()).not.toMatch(/\bTRUNCATE\b/i);
    expect(ddl()).not.toMatch(/CREATE\s+TABLE/i);
    expect(alteredTables().every((t) => t === 'workers')).toBe(true);
  });

  it('手写 DDL 与 Prisma 自产 DDL 等价（列名/类型/默认值逐字）', () => {
    const mine = normalizeColumnSpecs(ddl()).sort();
    const prisma = normalizeColumnSpecs(PRISMA_GENERATED_DDL).sort();
    expect(mine).toHaveLength(prisma.length);
    expect(mine).toEqual(prisma);
    // 显式锁住两列的最终语义：可空（无 DEFAULT NULL 变体混入）+ 二态布尔
    expect(mine.join('|')).toContain('update_state:varchar(191) null');
    expect(mine.join('|')).toContain(
      'rolled_back:boolean not null default false',
    );
  });
});
