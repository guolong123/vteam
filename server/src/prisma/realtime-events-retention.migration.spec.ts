import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract for migration `20261015000000_realtime_events_retention`（realtime_events 保留策略）。
 *
 * 存在理由：与 `model-usage.migration.spec.ts` 同源——把「schema 里声明的东西，迁移链里
 * 必须有对应 DDL」这条不变量钉死。本迁移只做一件事：给既有列 `created_at` 建二级索引，
 * 支撑 RealtimeService.pruneExpiredEvents 的 `created_at < cutoff` 周期删除，防止事件表
 * 再次无界增长（26GB OOM 事故尾款）。本仓本机/CI 无 MySQL（`nc -z localhost 3306` 不通、
 * `jest.config.js` 无 globalSetup），故这是**手写 DDL**，**本 spec 是这份 DDL 的唯一护栏**，
 * 断言必须双向（既查 DDL→schema，也查 schema→DDL）。
 *
 * 校验七件事：
 * 1. `RealtimeEvent` 模型在 schema 里存在，`created_at` 列已声明（本迁移只建索引不加列）；
 * 2. baseline 迁移里**不**含 `idx_realtime_events_created_at`（否则重复建索引 → ERROR 1061）；
 * 3. 本迁移 `CREATE INDEX` 的索引名在 schema 的 `@@index` 里有声明（正向）；
 * 4. 反向：schema 声明的 `idx_realtime_events_created_at` 真被本迁移建出来（漏建 → 静默全表扫描）；
 * 5. 本迁移只建这一条索引，不重复建 baseline 已有的 `idx_realtime_events_scope_id`；
 * 6. 零回填：迁移无任何 UPDATE/INSERT/DELETE（删除归属服务层周期决策，且存量已运维 TRUNCATE）；
 * 7. 不改 schema 里已存在的列/表/既有索引：不 ALTER/DROP/RENAME/TRUNCATE，不加列。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261015000000_realtime_events_retention',
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

/** 去掉 `--` 注释行与空行，只留可执行 DDL。 */
function nonComment(): string {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

/** 去掉 `--` 注释与空行、按 `;` 拆成的可执行语句（用于「本迁移只做了 X」的断言）。 */
function statements(): string[] {
  return nonComment()
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 本迁移 `CREATE INDEX` 语句解析出的索引三元组（name/table/columns）。只扫非注释行。 */
function createdIndexes(): {
  name: string;
  table: string;
  columns: string[];
}[] {
  return [
    ...nonComment().matchAll(
      /CREATE INDEX\s+`(\w+)`\s+ON\s+`(\w+)`\s*\(([^)]+)\)/gi,
    ),
  ].map((m) => ({
    name: m[1],
    table: m[2],
    columns: m[3]
      .split(',')
      .map((c) => c.trim().replace(/`/g, ''))
      .filter((c) => c.length > 0),
  }));
}

/** schema.prisma 里 `model RealtimeEvent` 的文本块。 */
function realtimeModelBlock(): string {
  const m = /^model RealtimeEvent \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model RealtimeEvent');
  return m[1];
}

/** schema.prisma 里 `model RealtimeEvent` 的 `@@index(..., map: "...")` 索引名集合。 */
function schemaIndexes(): Set<string> {
  return new Set(
    [...realtimeModelBlock().matchAll(/@@index\([^)]*map:\s*"(\w+)"\)/g)].map(
      (x) => x[1],
    ),
  );
}

/** 本轮迁移唯一要建的索引。 */
const INDEX = 'idx_realtime_events_created_at';
const TABLE = 'realtime_events';
const COLUMN = 'created_at';

describe('migration 20261015000000_realtime_events_retention', () => {
  it('schema.prisma 声明 model RealtimeEvent 且 @@map 到 realtime_events', () => {
    expect(schema()).toMatch(/model RealtimeEvent \{/);
    expect(realtimeModelBlock()).toContain('@@map("realtime_events")');
  });

  it('被索引的 created_at 列已存在于 schema（本迁移只建索引不加列）', () => {
    // created_at 是既有列（baseline `created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`），
    // 迁移不 ADD COLUMN；断言 schema 侧 @map 出该 DB 列名，防止有人误加列 DDL。
    expect(realtimeModelBlock()).toMatch(
      /createdAt\s+DateTime[\s\S]*@map\("created_at"\)/,
    );
    expect(sql()).not.toMatch(/ADD\s+COLUMN/i);
  });

  it('DDL 守卫：baseline 迁移里不含 idx_realtime_events_created_at（否则重复建索引 → ERROR 1061）', () => {
    expect(baselineSql()).not.toMatch(new RegExp(INDEX));
  });

  it('本迁移 CREATE INDEX 的索引名在 schema.prisma 的 RealtimeEvent @@index 里有声明（正向平价）', () => {
    const created = createdIndexes();
    expect(created.length).toBe(1);

    const declared = schemaIndexes();
    for (const idx of created) {
      expect(declared.has(idx.name)).toBe(true);
    }
  });

  it('索引三元组正确：名字/表名/被索引列都锁死（idx ON realtime_events (created_at)）', () => {
    const created = createdIndexes();
    expect(created).toEqual([{ name: INDEX, table: TABLE, columns: [COLUMN] }]);
  });

  it('反向平价：schema.prisma 声明的 idx_realtime_events_created_at 真被本迁移建出来（漏建 → 静默全表扫描）', () => {
    // 正向断言（DDL→schema）无法阻止「schema 声明了但迁移漏建」——那正是离线手写 DDL 最危险的
    // 静默故障：既有 scope_id 索引仍能干补拉查询，唯独清理谓词全表扫描不报错。
    const createdNames = createdIndexes().map((i) => i.name);
    expect(createdNames).toContain(INDEX);
    // schema 侧的确用 @@index([createdAt], map: "...") 声明了它。
    expect(realtimeModelBlock()).toContain(
      `@@index([createdAt], map: "${INDEX}")`,
    );
    expect(schemaIndexes().has(INDEX)).toBe(true);
  });

  it('不重复建 baseline 已有的 idx_realtime_events_scope_id（同列族 → ERROR 1061）', () => {
    const createdNames = createdIndexes().map((i) => i.name);
    expect(createdNames).not.toContain('idx_realtime_events_scope_id');
    // baseline 里该索引已存在（补拉过滤主力，本迁移保持不动）。
    expect(baselineSql()).toMatch(/idx_realtime_events_scope_id/);
    // schema 侧两个索引都必须声明齐。
    expect(schemaIndexes()).toEqual(
      new Set(['idx_realtime_events_scope_id', INDEX]),
    );
  });

  it('零回填：迁移无任何 UPDATE / INSERT / DELETE（删除归服务层周期 + 存量已 TRUNCATE）', () => {
    // 只扫可执行 DDL（非注释）：注释里允许解释「为何不 DELETE」，可执行层不得出现。
    expect(nonComment()).not.toMatch(/\bUPDATE\b/i);
    expect(nonComment()).not.toMatch(/\bINSERT\b/i);
    expect(nonComment()).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('只建一条索引：comment-stripped 后恰一条 CREATE INDEX 语句，无其它杂项 DDL', () => {
    const stmts = statements();
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^CREATE INDEX/i);
    expect(stmts[0]).toContain(INDEX);
    expect(stmts[0]).toContain(TABLE);
    // 不碰任何既有结构（断言只在非注释的可执行层）：不加列、不建外键、不删/改/重命名/清空。
    expect(nonComment()).not.toMatch(/ADD\s+COLUMN/i);
    expect(nonComment()).not.toMatch(/ALTER\s+TABLE/i);
    expect(nonComment()).not.toMatch(/DROP\s+TABLE/i);
    expect(nonComment()).not.toMatch(/DROP\s+COLUMN/i);
    expect(nonComment()).not.toMatch(/DROP\s+INDEX/i);
    expect(nonComment()).not.toMatch(/RENAME\s+/i);
    expect(nonComment()).not.toMatch(/\bTRUNCATE\b/i);
    // 不建外键（realtime_events 纯追加事件流，软关联零耦合）。
    expect(nonComment()).not.toMatch(/FOREIGN\s+KEY/i);
    expect(nonComment()).not.toMatch(/CONSTRAINT/i);
    // 不写 IF EXISTS / IF NOT EXISTS（本仓手写 DDL 约定）。
    expect(nonComment()).not.toMatch(/IF\s+(NOT\s+)?EXISTS/i);
  });
});
