import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract for migration `20260930010000_memory_role_inject`（角色级记忆 + 自动注入开关）。
 *
 * 存在理由：PR #36 曾因 `ALTER TABLE ... ADD COLUMN` 缺失而在真实部署时 `ERROR 1054`
 * 炸掉 init job（schema 声明了列、迁移没建列）。本 spec 把「schema 里有的列，迁移链
 * 里必须有对应 DDL」这条不变量钉死，避免同类缺口再次靠部署失败来发现。
 *
 * 校验三件事：
 * 1. `Memory` 模型声明的新列都在本迁移里 ADD COLUMN（且 baseline 里不存在 → 不会重复建）；
 * 2. 本迁移建的索引在 schema 里有对应 `@@index`（反向：schema 声明的索引必须真的建出来）；
 * 3. 存量行不回填为 `auto_inject=1`——建记忆时由 agent 自行决定，迁移不得替运营追认。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260930010000_memory_role_inject',
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

describe('migration 20260930010000_memory_role_inject', () => {
  it('本迁移 ADD COLUMN 的列在 schema.prisma 的 Memory 里都存在', () => {
    const added = [...sql().matchAll(/ADD COLUMN\s+`(\w+)`/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(0);

    const cols = schemaMemoryColumns();
    for (const col of added) {
      expect(cols.has(col)).toBe(true);
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

  it('schema.prisma 的 Memory 里 auto_inject 默认 false（新建记忆不自动进 prompt）', () => {
    const m = /^model Memory \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toMatch(
      /autoInject\s+Boolean\s+@default\(false\)\s+@map\("auto_inject"\)/,
    );
  });

  it('存量行不追认为自动注入：迁移无 UPDATE memories ... auto_inject', () => {
    // 回填 true 等于替运营做「这条记忆该每轮注入」的决策，而这些行写于开关存在之前。
    expect(sql()).not.toMatch(
      /UPDATE\s+`?memories`?\s+SET[\s\S]{0,120}?auto_inject/i,
    );
    // 列定义必须是 DEFAULT false 而非 DEFAULT true
    expect(sql()).toMatch(
      /ADD COLUMN\s+`auto_inject`\s+tinyint\(1\)\s+NOT NULL DEFAULT false/i,
    );
  });

  it('不删 task_id 死列：task 级记忆虽已废弃，删列不可逆', () => {
    const s = sql();
    expect(s).not.toMatch(/DROP\s+COLUMN/i);
    expect(s).not.toMatch(/DROP\s+INDEX/i);
  });
});
