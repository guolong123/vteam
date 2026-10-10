import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract for migration `20261010020000_worker_code_version`（worker 代码版本列）。
 *
 * 存在理由：与 `memory-refcount.migration.spec.ts` / `model-usage.migration.spec.ts`
 * 同源——PR #36 曾因 `ALTER TABLE ... ADD COLUMN` 缺失而在真实部署时 `ERROR 1054`
 * 炸掉 init job（schema 声明了列、迁移没建列）。本 spec 把「schema 里有的列，
 * 迁移链里必须有对应 DDL」钉死，并守住本轮的三条边界。
 *
 * ⚠️ 本仓库本机/CI 无 MySQL（`nc -z localhost 3306` 不通），故本迁移是**手写 DDL**
 * （格式对齐 `20261009010000_memory_refcount`，列类型对齐 Prisma 自产的
 * `migrate diff` 输出）。真跑 SQL 的机会为零 ⇒ **本 spec 是这份 DDL 的唯一护栏**。
 *
 * 校验七件事：
 * 1. schema.prisma 的 Worker 声明了 code_version（可选列，@map 到 code_version）；
 * 2. 本迁移 ADD COLUMN 的列在 schema 里都存在（正向平价）；
 * 3. 反向平价：schema 新增的列都被本迁移建出来（漏建列 → 运行时 P2022）；
 * 4. DDL 守卫：baseline 迁移里**不**含 code_version（否则重复建列 → ERROR 1060）；
 * 5. 零回填：迁移无任何 UPDATE（存量 worker 的版本无从重建，回填等于凭空断言）；
 * 6. 可空 + 无索引（版本是「未知即 NULL」的诚实取值；workers 表行数个位数，
 *    版本不参与过滤/排序 → 索引只有写放大）；
 * 7. 不删任何东西（列/索引/表一律不许 DROP），且只 ALTER workers 一张表。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261010020000_worker_code_version',
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

const sql = () => fs.readFileSync(MIGRATION, 'utf8');
const baselineSql = () => fs.readFileSync(BASELINE_MIGRATION, 'utf8');
const schema = () => fs.readFileSync(SCHEMA, 'utf8');

/**
 * 只留可执行 DDL（去掉 `--` 注释行与空行）——所有结构性断言都必须在**语句**上做，
 * 不能在注释上做：文件头的说明文字本身就会含 `UPDATE`/`CREATE INDEX` 等词
 * （本文件标题里的 `worker-self-update` 就曾让 `/\bUPDATE\b/i` 假红）。
 */
function ddl(): string {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

/** 去掉注释后的 DDL 按 `;` 切句（用于「本迁移只做了 X」的断言）。 */
function statements(): string[] {
  return ddl()
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 本迁移 ADD COLUMN 的列名集合。 */
const addedColumns = (): string[] =>
  [...ddl().matchAll(/ADD COLUMN\s+`(\w+)`/g)].map((m) => m[1]);

/** 本迁移 ALTER 的表名集合。 */
const alteredTables = (): string[] =>
  [...ddl().matchAll(/ALTER TABLE\s+`(\w+)`/gi)].map((m) => m[1]);

/** schema.prisma 里 `model Worker` 的**数据库列名**集合（@map 优先，否则字段名）。 */
function schemaWorkerColumns(): Set<string> {
  const m = /^model Worker \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model Worker');
  const cols = new Set<string>();
  for (const line of m[1].split('\n')) {
    // 只取「字段声明」行：字段名在行首且不以注释开头。
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
    const c = /^(\w+)\s+\w/.exec(t);
    if (!c) continue;
    // Prisma 字段名多为 camelCase，DDL 里是 @map 的 snake_case——必须取 map 值，
    // 否则 camelCase 字段名与迁移里的列名永不相等（守卫会恒红或恒绿）。
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

/** 本轮必须由该迁移负责的唯一一列。 */
const NEW_COLUMN = 'code_version';

describe('migration 20261010020000_worker_code_version', () => {
  it('schema.prisma 的 Worker 声明可选 codeVersion（@map 到 code_version）', () => {
    const m = /^model Worker \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toMatch(/codeVersion\s+String\?\s+@map\("code_version"\)/);
  });

  it('本迁移 ADD COLUMN 的列在 schema.prisma 的 Worker 里都存在（正向平价）', () => {
    const added = addedColumns();
    expect(added.length).toBeGreaterThan(0);

    const cols = schemaWorkerColumns();
    for (const col of added) {
      expect(cols.has(col)).toBe(true);
    }
  });

  it('code_version 列确实由本迁移建出（漏建 → 运行时 P2022 列不存在）', () => {
    expect(addedColumns()).toEqual([NEW_COLUMN]);
    expect(alteredTables()).toEqual(['workers']);
    expect(statements()).toHaveLength(1);
    expect(statements()[0]).toMatch(/^ALTER TABLE `workers`/i);
  });

  it('DDL 守卫：ADD COLUMN 的列在 baseline 里不存在（否则重复建列 → ERROR 1060）', () => {
    const baselineCols = baselineWorkerColumns();
    for (const col of addedColumns()) {
      expect(baselineCols.has(col)).toBe(false);
    }
  });

  it('零回填：迁移无任何 UPDATE（存量 worker 的代码版本无从重建）', () => {
    // 本列诞生之前注册的 worker，其运行版本只能靠猜；回填成 server 的 CODE_VERSION
    // 等于凭空断言「它就跑的是这个版本」——那正是本列要消灭的谎言。NULL 才是诚实取值。
    expect(ddl()).not.toMatch(/\bUPDATE\b/i);
    expect(ddl()).not.toMatch(/\bINSERT\b/i);
    expect(ddl()).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('可空 varchar(191) DEFAULT NULL（NULL = 版本未知；191 = 本仓字符串列统一宽度）', () => {
    expect(ddl()).toMatch(
      /ADD COLUMN\s+`code_version`\s+varchar\(191\)\s+DEFAULT NULL/i,
    );
    // 不得 NOT NULL：旧 worker 不上报，NOT NULL 会让整个注册/心跳 500。
    expect(ddl()).not.toMatch(/`code_version`[^,]*NOT NULL/i);
  });

  it('不建索引（workers 行数个位数，版本不参与过滤/排序 → 索引只有写放大）', () => {
    expect(ddl()).not.toMatch(/CREATE\s+INDEX/i);
    expect(ddl()).not.toMatch(/ADD\s+(KEY|INDEX)/i);
    // schema 侧同步不得声明 codeVersion 索引（否则 Prisma 与本迁移口径分裂）。
    const m = /^model Worker \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).not.toMatch(/@@index\(\[[^\]]*codeVersion/i);
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
});