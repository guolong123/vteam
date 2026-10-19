import * as fs from 'fs';
import * as path from 'path';

/**
 * 迁移 `20261019000000_parallel_tasks`（并行任务退役 FIFO 队列，parallel-tasks 计划 §4.1）契约。
 *
 * 本流水线无任何数据库（jest 不跑 MySQL DDL；同 20261001000000 的守卫口径），手写 DDL
 * 的唯一护栏是本 spec：
 * 1. queued → pending 的存量数据收敛语句必须存在；
 * 2. team_queues 数据清空但表保留（DELETE 而非 DROP/CREATE）；
 * 3. teams 新增 max_concurrent_tasks 列（正向 / 反向 / baseline 不重复）；
 * 4. **负向断言：不得 UPDATE tasks.queue_position**——该列从未存在（baseline 无此列，
 *    schema 无此字段），写了就会在真库 ERROR 1054 炸掉迁移（任务计划 §4.1 模板的
 *    这条语句是错误的，此处钉死防止复原）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261019000000_parallel_tasks',
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

describe('migration 20261019000000_parallel_tasks', () => {
  it('存量 queued → pending 收敛语句必须存在', () => {
    expect(sql()).toMatch(
      /UPDATE\s+`tasks`\s+SET\s+`status`\s+=\s+'pending'\s+WHERE\s+`status`\s+=\s+'queued'/i,
    );
  });

  it('team_queues 数据清空但表保留（DELETE FROM，不 DROP）', () => {
    expect(sql()).toMatch(/DELETE FROM\s+`team_queues`/i);
    expect(sql()).not.toMatch(/DROP\s+TABLE/i);
  });

  it('正向平价：ADD COLUMN max_concurrent_tasks 的列在 schema.prisma 的 Team 里存在', () => {
    const added = [...sql().matchAll(/ADD COLUMN\s+`(\w+)`/g)].map(
      (m) => m[1],
    );
    expect(added).toEqual(['max_concurrent_tasks']);

    const m = /^model Team \{([\s\S]*?)^\}/m.exec(schema());
    expect(m).not.toBeNull();
    const mapped = [...m![1].matchAll(/@map\("(\w+)"\)/g)].map((x) => x[1]);
    expect(mapped).toContain('max_concurrent_tasks');
  });

  it('反向平价：schema 字面量 + 可空形态（NULL = 不限，零回填）', () => {
    expect(schema()).toMatch(
      /maxConcurrentTasks\s+Int\?\s+@map\("max_concurrent_tasks"\)/,
    );
    expect(sql()).toMatch(
      /ADD COLUMN\s+`max_concurrent_tasks`\s+int\s+NULL/i,
    );
  });

  it('ADD COLUMN 的列在 baseline 的 teams 建表里不存在（否则重复建列 → ERROR 1060）', () => {
    const m = /CREATE TABLE `teams` \(([\s\S]*?)\n\) ENGINE=/.exec(
      baselineSql(),
    );
    expect(m).not.toBeNull();
    const cols = new Set(
      [...m![1].matchAll(/^\s*`(\w+)`/gm)].map((x) => x[1]),
    );
    expect(cols.has('max_concurrent_tasks')).toBe(false);
  });

  it('负向守卫：不得 UPDATE tasks.queue_position（该列从未存在，写了必 1054）', () => {
    expect(sql().replace(/--[^\n]*/g, '')).not.toMatch(/queue_position/i);
  });
});
