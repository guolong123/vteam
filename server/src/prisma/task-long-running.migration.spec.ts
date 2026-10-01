import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract for migration `20261001000000_task_long_running`（`tasks.long_running` 长期值班任务标识）。
 *
 * 存在理由：PR #36 曾因 `ALTER TABLE ... ADD COLUMN` 缺失而在真实部署时 `ERROR 1054`
 * 炸掉 init job（schema 声明了列、迁移没建列）。本 spec 把「schema 里有的列，迁移链里
 * 必须有对应 DDL」这条不变量钉死，避免同类缺口再次靠部署失败来发现。
 *
 * ⚠️ 本流水线**没有任何数据库**（`server/test.db` 不存在、`jest.config.js` 无
 * `globalSetup`、CI 无 MySQL service），MySQL 方言的 DDL 从不被真跑。全流程中真正触碰
 * 该列的只有 `prisma validate` / `prisma generate` / `tsc`——**本 spec 是这份手写 DDL 的
 * 唯一护栏**，故断言必须双向（既查 DDL→schema，也查 schema→DDL）。
 *
 * 校验五件事：
 * 1. DDL `ADD COLUMN` 的列在 `schema.prisma` 的 `Task` 里存在（正向）；
 * 2. **反向**：`model Task` 内确有 `longRunning Boolean @default(false) @map("long_running")`
 *    字面量——`@map` 拼错时正向仍会过，但运行时 Prisma client 与实际列名静默不一致；
 * 3. 该列在 baseline 里不存在（否则重复建列 → `ERROR 1060`）；
 * 4. 零回填（列定义 `DEFAULT false`，且无任何 `UPDATE ... tasks`）——常驻任务由运维逐个
 *    显式设置，迁移不得替运营追认，更不得用 `title LIKE` / `status` 启发式推断；
 * 5. 不删列、不建索引（删列不可逆；无查询路径需要索引）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261001000000_task_long_running',
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

/** baseline 里 `tasks` 建表语句的列名集合。 */
function baselineTaskColumns(): Set<string> {
  const m = /CREATE TABLE `tasks` \(([\s\S]*?)\n\) ENGINE=/.exec(baselineSql());
  if (!m) throw new Error('baseline 未找到 tasks 建表语句');
  return new Set([...m[1].matchAll(/^\s*`(\w+)`/gm)].map((x) => x[1]));
}

/** `schema.prisma` 里 `model Task` 的**数据库列名**集合（`@map` 优先，否则字段名）。 */
function schemaTaskColumns(): Set<string> {
  const m = /^model Task \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model Task');
  const cols = new Set<string>();
  for (const line of m[1].split('\n')) {
    // 只取「字段声明」行：字段名在行首且不以注释开头。
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('///') || t.startsWith('@@')) {
      continue;
    }
    const c = /^(\w+)\s+\w/.exec(t);
    if (!c) continue;
    // Prisma 字段名多为 camelCase，DDL 里是 @map 的 snake_case——必须取 map 值，
    // 否则 camelCase 字段名与迁移里的列名永不相等（守卫会恒红或恒绿）。
    const mapped = /@map\("(\w+)"\)/.exec(t);
    cols.add(mapped ? mapped[1] : c[1]);
  }
  return cols;
}

/** 本迁移 `ADD COLUMN` 的列名列表。 */
const addedColumns = (): string[] =>
  [...sql().matchAll(/ADD COLUMN\s+`(\w+)`/g)].map((m) => m[1]);

describe('migration 20261001000000_task_long_running', () => {
  it('本迁移 ADD COLUMN 的列在 schema.prisma 的 Task 里都存在（正向平价）', () => {
    const added = addedColumns();
    expect(added.length).toBeGreaterThan(0);

    const cols = schemaTaskColumns();
    for (const col of added) {
      expect(cols.has(col)).toBe(true);
    }
  });

  it('反向平价：schema.prisma 的 Task 里确有 longRunning + @map("long_running") 字面量', () => {
    // `@map` 拼错时正向断言仍会过（列名两边都取到同一个错字），但运行时 Prisma client
    // 读的是错列名 → 静默不一致。故必须钉住字面量本身。
    const m = /^model Task \{([\s\S]*?)^\}/m.exec(schema());
    expect(m?.[1]).toMatch(
      /longRunning\s+Boolean\s+@default\(false\)\s+@map\("long_running"\)/,
    );
  });

  it('DDL 守卫：ADD COLUMN 的列在 baseline 里不存在（否则重复建列 → ERROR 1060）', () => {
    const baselineCols = baselineTaskColumns();
    for (const col of addedColumns()) {
      expect(baselineCols.has(col)).toBe(false);
    }
  });

  it('零回填：列定义 DEFAULT false，且迁移内无任何 UPDATE tasks', () => {
    // 常驻值班任务由运维逐个显式设置（runbook 记录 id）；启发式回填会永久关掉真任务的
    // 停滞保护，而错标 true 不可逆。
    expect(sql()).toMatch(
      /ADD COLUMN\s+`long_running`\s+tinyint\(1\)\s+NOT NULL DEFAULT false/i,
    );
    expect(sql()).not.toMatch(/UPDATE\s+`?tasks`?/i);
  });

  it('单条 ALTER TABLE：无第二条语句、不建索引（无查询路径需要）', () => {
    expect(sql()).not.toMatch(/CREATE\s+INDEX/i);
    // 去掉 `--` 注释行后应只剩一条语句
    const statements = sql()
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^ALTER TABLE `tasks`/i);
  });

  it('不删列（删列不可逆，且本仓库无 down-migration 约定）', () => {
    const s = sql();
    expect(s).not.toMatch(/DROP\s+COLUMN/i);
    expect(s).not.toMatch(/DROP\s+INDEX/i);
    expect(s).not.toMatch(/\bTRUNCATE\b/i);
    expect(s).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
