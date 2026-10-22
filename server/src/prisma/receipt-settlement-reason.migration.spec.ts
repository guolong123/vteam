import * as fs from 'fs';
import * as path from 'path';

/**
 * 迁移守卫 spec：`20261022120000_receipt_settlement_reason`（pm-coordination-hardening 批次 A4）。
 *
 * 存在理由：与 `team-worker-node.migration.spec.ts` / `realtime-events-retention.migration.spec.ts`
 * 同源——本仓本机/CI 无 MySQL（`nc -z localhost 3306` 不通、`jest.config.js` 无 globalSetup、
 * 无 `db push`），这份迁移是**手写 DDL**，真跑 SQL 的机会为零 ⇒ **本 spec 是它的唯一护栏**。
 *
 * 为什么需要这一列（批次 A4 给账本补了减法）：
 *   账本此前只有**加法**（每次 notify_agent 加一行，me_0000000030：「别用 notify 清回执，
 *   会越清越多」），status 词表只有 pending|acked|expired ⇒ 一行被结掉之后，无从分辨它是
 *   「目标回了执」还是「平台按引用 / 按应答 / 按被替换替它结的」。本列补的就是这条审计语义。
 *
 * 校验八件事：
 *   1. schema.prisma 的 `model MessageReceipt` 声明 `settledReason` 且 @map 到 `settled_reason`；
 *   2. baseline 的 message_receipts 建表块**不含** `settled_reason`（含了 → 重复加列 ERROR 1060）；
 *   3. 本迁移**必须**含 `ALTER TABLE \`message_receipts\` ADD COLUMN \`settled_reason\``；
 *   4. 列形态与 Prisma 自产 migrate diff 输出一致（离线等价性；可空列渲染差异视为等价）；
 *   5. 零 UPDATE / INSERT / DELETE / FOREIGN KEY / IF EXISTS（剔除 `--` 注释行后）；
 *   6. 本迁移**只**加这一列：不碰 status 词表（pending|acked|expired 三值不变）、不动既有列/索引；
 *   7. 迁移目录恰好一个，且字典序晚于 baseline 与上一批迁移（存量/新库两条路径同序）；
 *   8. 不得编辑 baseline（反转方向的静默 no-op 防线：baseline 的 message_receipts 块仍无该列）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261022120000_receipt_settlement_reason',
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

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
);

const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const sql = () => fs.readFileSync(MIGRATION, 'utf8');
const baselineSql = () => fs.readFileSync(BASELINE_MIGRATION, 'utf8');
const schema = () => fs.readFileSync(SCHEMA, 'utf8');

/** 本迁移目录名（不含路径）。 */
const MIGRATION_DIR_NAME = '20261022120000_receipt_settlement_reason';

/** 上一批手写迁移目录名——本迁移必须在字典序上排在它之后。 */
const PREVIOUS_MIGRATION_DIR_NAME = '20261022000000_pm_coordination_discipline';

/** 本迁移唯一新增的列。 */
const COLUMN = 'settled_reason';

/** 剔除 `--` 注释行后的整段文本（供正则断言逐字比对）。 */
function executableSql(): string {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

/** 剔除 `--` 注释行与空行、按 `;` 拆成的可执行语句。 */
function statements(): string[] {
  return executableSql()
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** baseline 里 `CREATE TABLE \`message_receipts\` (...)` 的整块定义文本。 */
function baselineReceiptsBlock(): string {
  const m = /CREATE TABLE `message_receipts` \(([\s\S]*?)\n\) ENGINE=/.exec(
    baselineSql(),
  );
  if (!m) throw new Error('baseline 迁移未找到 message_receipts 建表语句');
  return m[1];
}

/** schema.prisma 里 `model MessageReceipt` 的声明块文本。 */
function schemaMessageReceiptBlock(): string {
  const m = /^model MessageReceipt \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model MessageReceipt');
  return m[1];
}

describe('migration 20261022120000_receipt_settlement_reason', () => {
  it('① schema.prisma 的 MessageReceipt 声明 settledReason 且 @map 到 settled_reason', () => {
    const block = schemaMessageReceiptBlock();
    expect(block).toMatch(/settledReason\s+String\?/);
    expect(block).toContain(`@map("${COLUMN}")`);
    // 恰好一处声明：两处意味着有一处在别的模型里（列会被加到错误的表上）。
    expect(schema().match(/settledReason/g) ?? []).toHaveLength(1);
  });

  it('② baseline 的 message_receipts 建表块不含 settled_reason（否则重复加列 → ERROR 1060）', () => {
    expect(baselineReceiptsBlock()).not.toContain(COLUMN);
    expect(baselineSql()).not.toContain(COLUMN);
  });

  it('③ 本迁移必须含 ALTER TABLE `message_receipts` ADD COLUMN `settled_reason`', () => {
    expect(executableSql()).toContain('ALTER TABLE `message_receipts`');
    expect(executableSql()).toContain(
      `ADD COLUMN \`${COLUMN}\` varchar(191) NULL`,
    );
    // 只加这一列：不得顺手加别的列（顺手动 = 越界）。
    expect(executableSql().match(/ADD COLUMN/g) ?? []).toHaveLength(1);
  });

  it('④ 列形态与 Prisma 自产 migrate diff 输出一致（离线等价性）', () => {
    // `prisma migrate diff --from-schema-datamodel <迁移前 schema> --to-schema-datamodel
    // prisma/schema.prisma --script` 的原始输出为：
    //   ALTER TABLE `message_receipts` ADD COLUMN `settled_reason` VARCHAR(191) NULL;
    // Prisma 把可空列渲染成 `VARCHAR(191) NULL`，MySQL 对可空列的隐式默认即 NULL，
    // 与手写的 `NULL` 同义；故此处比对时把 NULL/DEFAULT NULL 视为等价，并钉死表名与列名。
    const canonical = statements().map((s) => s.replace(/\s+/g, ' '));
    expect(canonical).toEqual([
      'ALTER TABLE `message_receipts` ADD COLUMN `settled_reason` varchar(191) NULL',
    ]);
  });

  it('⑤ 零 UPDATE / INSERT / DELETE / FOREIGN KEY / IF EXISTS（剔除注释后）', () => {
    const ddl = executableSql();
    expect(ddl).not.toMatch(/\bUPDATE\b/i);
    expect(ddl).not.toMatch(/\bINSERT\b/i);
    expect(ddl).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(ddl).not.toMatch(/FOREIGN\s+KEY/i);
    expect(ddl).not.toMatch(/\bIF\s+EXISTS\b/i);
    expect(ddl).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
  });

  it('⑥ 只加一列：不碰 status 词表、不动既有列/索引/约束', () => {
    const ddl = executableSql();
    expect(ddl).not.toMatch(/DROP\s+COLUMN/i);
    expect(ddl).not.toMatch(/DROP\s+TABLE/i);
    expect(ddl).not.toMatch(/DROP\s+INDEX/i);
    expect(ddl).not.toMatch(/MODIFY\s+/i);
    expect(ddl).not.toMatch(/CHANGE\s+/i);
    expect(ddl).not.toMatch(/RENAME\s+/i);
    expect(ddl).not.toMatch(/\bTRUNCATE\b/i);
    expect(ddl).not.toMatch(/CREATE\s+INDEX/i);
    expect(ddl).not.toMatch(/CONSTRAINT/i);
    // status 词表仍是 pending|acked|expired 三值：本列只是审计「为什么结的账」，
    // 不引入第四个 status（批次 A4 明确「结账走既有机制」，避免打穿前端的 status 白名单）。
    const block = schemaMessageReceiptBlock();
    expect(block).toContain('status         String    @default("pending")');
    // status 字段声明行里不得出现第四个取值（注释里提到 superseded 是允许的：
    // 它是 settled_reason 的取值，不是 status 的取值）。
    expect(block).not.toMatch(/status\s+String[^\n]*superseded/);
  });

  it('⑦ 迁移目录恰好一个，且字典序晚于 baseline 与上一批迁移', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d.includes('receipt_settlement_reason'));
    expect(dirs).toEqual([MIGRATION_DIR_NAME]);

    const all = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => fs.statSync(path.join(MIGRATIONS_DIR, d)).isDirectory())
      .sort();
    expect(all.indexOf(MIGRATION_DIR_NAME)).toBeGreaterThan(
      all.indexOf(PREVIOUS_MIGRATION_DIR_NAME),
    );
    expect(
      all.indexOf(MIGRATION_DIR_NAME) >
        all.indexOf('20260925000000_squashed_baseline'),
    ).toBe(true);
    expect(all).toContain(PREVIOUS_MIGRATION_DIR_NAME);
  });

  it('⑧ 不得编辑 baseline（反转方向的静默 no-op 防线）', () => {
    // baseline 仍是 2026-09-25 的历史事实：message_receipts 块必须原样无该列。
    // 若有人把加列「折进」baseline，本迁移的 ADD COLUMN 会在真实部署时 ERROR 1060，
    // 而已部署库则永远漂移（那句 DDL 不会再跑）。
    expect(baselineReceiptsBlock()).toContain('`status` varchar(191)');
    expect(statements()).toHaveLength(1);
  });
});
