import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract for migration `20261009010000_memory_refcount`（记忆引用计数指标）。
 *
 * 存在理由：与 `memory-role-inject.migration.spec.ts` 同源——PR #36 曾因
 * `ALTER TABLE ... ADD COLUMN` 缺失而在真实部署时 `ERROR 1054` 炸掉 init job
 * （schema 声明了列、迁移没建列）。本 spec 把「schema 里有的列，迁移链里必须有
 * 对应 DDL」这条不变量钉死，并额外守住本轮的两条边界：不得回填存量行（会污染
 * 重要度排序）、不得删死列 task_id（不可逆 DDL）。
 *
 * 校验五件事：
 * 1. `Memory` 模型声明的新列都在本迁移里 ADD COLUMN；
 * 2. 基线迁移里**不**含这些列（否则重复建列 → ERROR 1060）；
 * 3. 本迁移建的索引在 schema 里有对应 `@@index`（反向：schema 声明的必须真建出来）；
 * 4. 无任何回填 UPDATE（新列存量行一律靠 DEFAULT 兜底）；
 * 5. 不删 task_id 死列、不删任何索引。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261009010000_memory_refcount',
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

/** baseline 里 `memories` 建表语句的列名集合。 */
function baselineMemoryColumns(): Set<string> {
  const m = /CREATE TABLE `memories` \(([\s\S]*?)\n\) ENGINE=/.exec(
    baselineSql(),
  );
  if (!m) throw new Error('baseline 未找到 memories 建表语句');
  return new Set([...m[1].matchAll(/^\s*`(\w+)`/gm)].map((x) => x[1]));
}

/** schema.prisma 里 `model Memory` 的**数据库列名**集合（@map 优先，否则字段名）。 */
function schemaMemoryColumns(): Set<string> {
  const m = /^model Memory \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model Memory');
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

/** 本轮新增、必须由该迁移负责的三列。 */
const NEW_COLUMNS = ['ref_count', 'last_used_at', 'merged_into_id'] as const;

describe('migration 20261009010000_memory_refcount', () => {
  it('本迁移 ADD COLUMN 的列在 schema.prisma 的 Memory 里都存在', () => {
    const added = [...sql().matchAll(/ADD COLUMN\s+`(\w+)`/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(0);

    const cols = schemaMemoryColumns();
    for (const col of added) {
      expect(cols.has(col)).toBe(true);
    }
  });

  it('三个指标列都被 ADD COLUMN 覆盖（ref_count / last_used_at / merged_into_id）', () => {
    const added = new Set(
      [...sql().matchAll(/ADD COLUMN\s+`(\w+)`/g)].map((m) => m[1]),
    );
    for (const col of NEW_COLUMNS) {
      expect(added.has(col)).toBe(true);
    }
  });

  it('DDL 守卫：ADD COLUMN 的列在 baseline 里不存在（否则重复建列 → ERROR 1060）', () => {
    const baselineCols = baselineMemoryColumns();
    for (const col of [...sql().matchAll(/ADD COLUMN\s+`(\w+)`/g)].map(
      (m) => m[1],
    )) {
      expect(baselineCols.has(col)).toBe(false);
    }
  });

  it('本迁移 CREATE INDEX 的名字在 schema.prisma 的 Memory @@index 里有声明', () => {
    const created = [...sql().matchAll(/CREATE INDEX\s+`(\w+)`/g)].map(
      (m) => m[1],
    );
    expect(created.length).toBeGreaterThan(0);

    const m = /^model Memory \{([\s\S]*?)^\}/m.exec(schema());
    for (const idx of created) {
      expect(m?.[1]).toContain(`map: "${idx}"`);
    }
  });

  it('schema.prisma 声明 refCount 索引且列默认为 0（新建记忆未被引用过）', () => {
    const m = /^model Memory \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toMatch(
      /refCount\s+Int\s+@default\(0\)\s+@map\("ref_count"\)/,
    );
    expect(m?.[1]).toContain(
      '@@index([refCount], map: "idx_memories_ref_count")',
    );
  });

  it('存量行不回填：迁移无任何 UPDATE（ref_count=0 是「未被引用过」的诚实取值）', () => {
    // 回填 ref_count 会凭空造出引用次数，直接污染重要度排序——老行带着假分
    // 压过全新记忆。存量行必须由 DEFAULT 0 兜底。
    expect(sql()).not.toMatch(/\bUPDATE\b/i);
    // 列定义必须是 DEFAULT 0，且可空列必须 DEFAULT NULL。
    expect(sql()).toMatch(
      /ADD COLUMN\s+`ref_count`\s+int\s+NOT NULL DEFAULT 0/i,
    );
    expect(sql()).toMatch(
      /ADD COLUMN\s+`last_used_at`\s+datetime\(3\)\s+DEFAULT NULL/i,
    );
    expect(sql()).toMatch(
      /ADD COLUMN\s+`merged_into_id`\s+varchar\(191\)\s+DEFAULT NULL/i,
    );
  });

  it('不加 category / enabled 等新状态列（归档复用 deletedAt，分类复用 tags）', () => {
    const added = [...sql().matchAll(/ADD COLUMN\s+`(\w+)`/g)].map((m) => m[1]);
    for (const forbidden of ['category', 'enabled', 'status']) {
      expect(added).not.toContain(forbidden);
    }
  });

  it('不删 task_id 死列：task 级记忆虽已废弃，删列不可逆', () => {
    const s = sql();
    expect(s).not.toMatch(/DROP\s+COLUMN/i);
    expect(s).not.toMatch(/DROP\s+INDEX/i);
    expect(s).not.toMatch(/DROP\s+TABLE/i);
  });
});
