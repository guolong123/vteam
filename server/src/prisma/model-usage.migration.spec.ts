import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract for migration `20261010010000_model_usage`（成员×模型用量与费用表）。
 *
 * 存在理由：与 `memory-refcount.migration.spec.ts` 同源——PR #36 曾因
 * `ALTER TABLE ... ADD COLUMN` 缺失而在真实部署时 `ERROR 1054` 炸掉 init job
 * （schema 声明了列、迁移没建列）。本 spec 把「schema 里有的东西，迁移链里必须有
 * 对应 DDL」这条不变量钉死，并额外守住本轮的三条边界。
 *
 * ⚠️ 本仓库本机/CI 无 MySQL（`nc -z localhost 3306` 不通、`jest.config.js` 无
 * `globalSetup`），故本迁移是**手写 DDL**（格式对齐
 * `20261009010000_memory_refcount/migration.sql`，列/索引类型对齐 Prisma 自产的
 * `migrate diff` 输出）。真跑 SQL 的机会为零 ⇒ **本 spec 是这份 DDL 的唯一护栏**，
 * 断言必须双向（既查 DDL→schema，也查 schema→DDL）。
 *
 * 校验七件事：
 * 1. `ModelUsage` 模型在 schema 里存在，且列与迁移 DDL **双向平价**；
 * 2. baseline 迁移里**不**含 `model_usages`（否则重复建表 → `ERROR 1057`）；
 * 3. 迁移建的三个索引在 schema 的 `@@index` 里有对应声明（**反向**：schema 声明的
 *    必须真建出来——漏建索引在本仓是静默故障，只有全表扫描不会报错）；
 * 4. 零回填：迁移无任何 `UPDATE`（历史用量不可诚实重建，见迁移文件头）；
 * 5. 不建外键：软关联（跨域耦合会让删会话/删成员的 RESTRICT 路径被统计表卡死）；
 * 6. 不加 price/单价列（本仓无权威价目表，重算等于凭空造口径）；
 * 7. 只建这一张表：不 ALTER / DROP 任何既有表（`Model`/`Message`/`Session` 等
 *    一律不许被顺带动到）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261010010000_model_usage',
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

/** 去掉 `--` 注释行与空行，只留可执行 DDL（用于「本迁移只做了 X」的断言）。 */
function statements(): string[] {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 本迁移 `CREATE TABLE` 的表名集合。 */
const createdTables = (): string[] =>
  [...sql().matchAll(/CREATE TABLE\s+`(\w+)`/g)].map((m) => m[1]);

/** 本迁移 `CREATE TABLE` 语句块的全部列名（`PRIMARY KEY`/`KEY` 行不计）。 */
function createdColumns(table: string): Set<string> {
  const m = new RegExp(`CREATE TABLE \`${table}\` \\(([\\s\\S]*?)\\n\\) ENGINE=`).exec(
    sql(),
  );
  if (!m) throw new Error(`迁移未找到 ${table} 建表语句`);
  return new Set(
    [...m[1].matchAll(/^\s*`(\w+)`\s+/gm)].map((x) => x[1]),
  );
}

/** 本迁移建的索引名集合（CREATE TABLE 内的 `KEY \`name\` (...)` 行）。 */
function createdIndexes(table: string): Set<string> {
  const m = new RegExp(`CREATE TABLE \`${table}\` \\(([\\s\\S]*?)\\n\\) ENGINE=`).exec(
    sql(),
  );
  if (!m) throw new Error(`迁移未找到 ${table} 建表语句`);
  return new Set(
    [...m[1].matchAll(/^\s*KEY `(\w+)`\s*\(/gm)].map((x) => x[1]),
  );
}

/** schema.prisma 里 `model ModelUsage` 的**数据库列名**集合（@map 优先，否则字段名）。 */
function schemaUsageColumns(): Set<string> {
  const m = /^model ModelUsage \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model ModelUsage');
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

/** schema.prisma 里 `model ModelUsage` 的 `@@index(..., map: "...")` 索引名集合。 */
function schemaUsageIndexes(): Set<string> {
  const m = /^model ModelUsage \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model ModelUsage');
  return new Set(
    [...m[1].matchAll(/@@index\([^)]*map:\s*"(\w+)"\)/g)].map((x) => x[1]),
  );
}

/** 本轮迁移必须建立的表与索引（与计划 Todo 2 逐字对齐）。 */
const TABLE = 'model_usages';
const EXPECTED_COLUMNS = [
  'id',
  'team_id',
  'team_member_id',
  'session_id',
  'channel_id',
  'agent_id',
  'task_id',
  'model',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'total_tokens',
  'cost',
  'created_at',
] as const;

const EXPECTED_INDEXES = [
  'idx_usage_team_member',
  'idx_usage_team_model',
  'idx_usage_created',
] as const;

describe('migration 20261010010000_model_usage', () => {
  it('schema.prisma 声明 model ModelUsage 且 @@map 到 model_usages', () => {
    expect(schema()).toMatch(/model ModelUsage \{/);
    const m = /^model ModelUsage \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toContain('@@map("model_usages")');
  });

  it('本迁移 CREATE TABLE 的列在 schema.prisma 的 ModelUsage 里都存在（正向平价）', () => {
    const cols = createdColumns(TABLE);
    expect(cols.size).toBeGreaterThan(0);

    const schemaCols = schemaUsageColumns();
    for (const col of cols) {
      expect(schemaCols.has(col)).toBe(true);
    }
  });

  it('反向平价：schema.prisma 的 ModelUsage 列都被本迁移建出来（漏建列 → 运行时 P2022）', () => {
    // `@map` 拼错时正向断言仍会过（两边都取到同一个错字），但运行时 Prisma client
    // 读的是错列名 → 静默不一致。故必须钉住 schema→DDL 这条反向边。
    const ddl = createdColumns(TABLE);
    for (const col of schemaUsageColumns()) {
      expect(ddl.has(col)).toBe(true);
    }
  });

  it('十六个契约列一个不少不多（id/归属六维/model/六计数/cost/created_at）', () => {
    const ddl = createdColumns(TABLE);
    for (const col of EXPECTED_COLUMNS) {
      expect(ddl.has(col)).toBe(true);
    }
    // 无多余列：schema 声明的列集合与契约列集合相等（防止悄悄加 price 等列）。
    const schemaCols = schemaUsageColumns();
    expect([...schemaCols].sort()).toEqual([...EXPECTED_COLUMNS].sort());
  });

  it('DDL 守卫：baseline 迁移里不含 model_usages（否则重复建表 → ERROR 1057）', () => {
    expect(baselineSql()).not.toMatch(/model_usages/);
    expect(baselineSql()).not.toMatch(/idx_usage_/);
  });

  it('本迁移建的索引名在 schema.prisma 的 ModelUsage @@index 里有声明（正向）', () => {
    const created = createdIndexes(TABLE);
    expect(created.size).toBeGreaterThan(0);

    const declared = schemaUsageIndexes();
    for (const idx of created) {
      expect(declared.has(idx)).toBe(true);
    }
  });

  it('反向：schema.prisma 声明的三个 @@index 都被本迁移真建出来（漏建 → 静默全表扫描）', () => {
    const created = createdIndexes(TABLE);
    expect([...created].sort()).toEqual([...EXPECTED_INDEXES].sort());

    const m = /^model ModelUsage \{([\s\S]*?)^\}/m.exec(schema());
    for (const idx of EXPECTED_INDEXES) {
      expect(m?.[1]).toContain(`map: "${idx}"`);
    }
  });

  it('零回填：迁移无任何 UPDATE / INSERT / DELETE（历史用量不可诚实重建）', () => {
    // 回填的唯一来源是 `messages.content.parts` 的残留结构——best-effort 二次解析，
    // 缺字段就少算。臆造的历史用量会直接污染统计口径且无法事后甄别。
    expect(sql()).not.toMatch(/\bUPDATE\b/i);
    expect(sql()).not.toMatch(/\bINSERT\b/i);
    expect(sql()).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('六个 token 计数列 NOT NULL DEFAULT 0（脏数据归零不断链，不靠 NULL 兜底）', () => {
    for (const col of EXPECTED_COLUMNS.filter((c) => c.endsWith('_tokens'))) {
      expect(sql()).toMatch(
        new RegExp(`\`${col}\`\\s+int\\s+NOT NULL DEFAULT 0`, 'i'),
      );
    }
    // cost 反之：NULL = 上游未给（未知），与 0 = 免费语义不同，不得 DEFAULT 0。
    expect(sql()).toMatch(/`cost`\s+double\s+DEFAULT NULL/i);
  });

  it('不建外键（软关联）：迁移与 schema 均无 FK/CONSTRAINT/relations', () => {
    expect(sql()).not.toMatch(/FOREIGN\s+KEY/i);
    expect(sql()).not.toMatch(/CONSTRAINT/i);

    // schema 侧：ModelUsage 无 relations 字段（否则 Prisma 会要求被引用模型反向声明）。
    const m = /^model ModelUsage \{([\s\S]*?)^\}/m.exec(schema());
    for (const rel of ['Team', 'Session', 'ChatChannel', 'TeamMember', 'Task', 'Agent']) {
      expect(m?.[1]).not.toMatch(new RegExp(`\\b${rel}\\s+${rel}`));
    }
  });

  it('不加 price/单价/币种列（本仓无权威价目表，cost 存上游原值）', () => {
    const cols = createdColumns(TABLE);
    for (const forbidden of [
      'price',
      'unit_price',
      'unitPrice',
      'currency',
      'rate',
      'usd_per_token',
    ]) {
      expect(cols.has(forbidden)).toBe(false);
    }
  });

  it('只建这一张表：不 ALTER / DROP / RENAME 任何既有表', () => {
    // 单条语句（CREATE TABLE），且建的是唯一的新表——Model/Message/Session 等既有模型
    // 一律不许被顺带动到（会牵连无关的漂移 DDL）。
    expect(statements()).toHaveLength(1);
    expect(statements()[0]).toMatch(
      new RegExp(`^CREATE TABLE \`${TABLE}\``, 'i'),
    );
    expect(createdTables()).toEqual([TABLE]);

    expect(sql()).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql()).not.toMatch(/DROP\s+TABLE/i);
    expect(sql()).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql()).not.toMatch(/DROP\s+INDEX/i);
    expect(sql()).not.toMatch(/RENAME\s+/i);
    expect(sql()).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('us_ 前缀主键 + 无 DEFAULT：id 永远由服务层 IdGeneratorService 显式写入', () => {
    const m = /^model ModelUsage \{([\s\S]*?)^\}/m.exec(schema());
    // 主键列不得有 DEFAULT：库侧永不代造 us_ id（造了就与 IdGeneratorService 的
    // 计数器脱钩，续号失效 → 重启撞 P2002）。
    expect(m?.[1]).toMatch(/id\s+String\s+@id/);
    expect(sql()).toMatch(/`id`\s+varchar\(191\)[^,]*NOT NULL/);
    expect(sql()).not.toMatch(/`id`\s+varchar\(191\)[^,]*DEFAULT/i);
    // 续号责任落在消费侧（usage-sink），此处固化「必须在 onModuleInit resync」的口径。
    expect(schema()).toMatch(/resyncIdPrefix\(this\.prisma\.modelUsage, 'us'/);
  });
});