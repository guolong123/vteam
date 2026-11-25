import * as fs from 'fs';
import * as path from 'path';

/**
 * 迁移守卫 spec：`20261112120000_workspaces_expand`（多工作空间 expand）。
 *
 * ## 为什么必须存在这一份
 *
 * 2026-11-25 生产 v1.7.0 升级失败并回滚，根因就是这份迁移：
 *
 *   Migration name: 20261112120000_workspaces_expand
 *   Database error code: 1054
 *   Database error: Unknown column 'default_opencode_agent_name' in 'agent_roles'
 *
 * 该迁移时间戳（11-12）**早于** `20261121220000_drop_external_agent_columns`（11-21），
 * 但文件是后写的：它对三列做了 `MODIFY`，其中 `default_opencode_agent_name` 已被
 * 11-21 那次迁移删除。于是 `migrate deploy` 在任何**已应用删列**的库上必然失败
 * （本地/CI 全新库能过，只有真实存量库会炸 —— 所以当时 CI 全绿仍然出事）。
 *
 * 本 spec 守两件事：
 *   1. **不得 MODIFY / 引用本仓 schema 里已不存在的列**（把「时间戳顺序 vs 文件内容」
 *      这类漂移钉死在静态检查里，不依赖有没有 MySQL）；
 *   2. expand 迁移的形态不变（只 ADD COLUMN + 回填 + 建索引，无 DROP TABLE/COLUMN）。
 */

const MIGRATION_DIR_NAME = '20261112120000_workspaces_expand';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.resolve(
  REPO_ROOT,
  'server',
  'prisma',
  'migrations',
);
const MIGRATION = path.resolve(
  MIGRATIONS_DIR,
  MIGRATION_DIR_NAME,
  'migration.sql',
);
const SCHEMA = path.resolve(REPO_ROOT, 'server', 'prisma', 'schema.prisma');

/** 整份迁移（含注释，供"注释里解释了为什么不再 MODIFY"的断言用）。 */
const sql = (): string => fs.readFileSync(MIGRATION, 'utf8');

/** 去掉 `--` 注释行后的可执行 SQL。 */
function executable(): string {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

/**
 * 本仓 schema 里已**不存在**、但历史上真实存在过的列名。
 *
 * 这些是「被后序迁移删掉」的列 —— 任何排在它们之前的迁移都**不得**再引用，
 * 否则就是本次事故的同款：时间戳在前、内容在后、列已不在。
 */
const RETIRED_COLUMNS = [
  // 20261121220000_drop_external_agent_columns
  'default_opencode_agent_name',
  'opencode_agent_name',
];

describe(`migration ${MIGRATION_DIR_NAME}`, () => {
  it('目录存在且只有一个 migration.sql', () => {
    expect(fs.existsSync(MIGRATION)).toBe(true);
    const files = fs
      .readdirSync(path.resolve(MIGRATIONS_DIR, MIGRATION_DIR_NAME))
      .filter((f) => f.endsWith('.sql'));
    expect(files).toEqual(['migration.sql']);
  });

  it('回归：不得 MODIFY 已被后序迁移删除的列（v1.7.0 事故根因）', () => {
    const body = executable();
    for (const col of RETIRED_COLUMNS) {
      // 只检查可执行 SQL：注释里出现该列名（解释原因）是允许且期望的。
      const modifyRef = new RegExp(`MODIFY\\s+\`${col}\``, 'i');
      expect({ col, referenced: modifyRef.test(body) }).toEqual({
        col,
        referenced: false,
      });
      // 也不得在其它 DDL 里引用（ADD/DROP/CHANGE/UPDATE ... SET）
      const anyRef = new RegExp(`\`${col}\``, 'g');
      expect({ col, count: (body.match(anyRef) ?? []).length }).toEqual({
        col,
        count: 0,
      });
    }
  });

  it('回归：schema 里确实已无这些列（防止「列被加回来但守卫还按老样子写」）', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    for (const col of RETIRED_COLUMNS) {
      const camel = col.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      expect({ col, inSchema: schema.includes(`@map("${col}")`) }).toEqual({
        col,
        inSchema: false,
      });
      expect({ col, camelInSchema: schema.includes(camel) }).toEqual({
        col,
        camelInSchema: false,
      });
    }
  });

  it('expand 形态：只 ADD COLUMN / 回填 / 建索引，不删表删列', () => {
    const body = executable();
    expect(body).not.toMatch(/DROP\s+TABLE/i);
    expect(body).not.toMatch(/DROP\s+COLUMN/i);
    // 允许的破坏性动作只有「先拆旧全局唯一索引、再建成含 workspace_id 的复合索引」
    const drops = body.match(/DROP\s+INDEX/gi) ?? [];
    const creates = body.match(/CREATE\s+(UNIQUE\s+)?INDEX/gi) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    expect(creates.length).toBeGreaterThan(drops.length);
  });

  it('两个基础空间都建出来（ws_system 承载平台资源，ws_default 承载存量业务数据）', () => {
    const body = executable();
    expect(body).toContain("'ws_system'");
    expect(body).toContain("'ws_default'");
    expect(body).toMatch(/INSERT INTO `workspaces`/i);
  });

  it('平台资源回填到 ws_system、业务资源回填到 ws_default', () => {
    const body = executable();
    // 岗位/执行策略/模板 Agent 是平台内置 → ws_system
    expect(body).toMatch(
      /UPDATE `agent_roles` SET `workspace_id` = 'ws_system'/i,
    );
    expect(body).toMatch(
      /UPDATE `execution_policies` SET `workspace_id` = 'ws_system'/i,
    );
    expect(body).toMatch(
      /IF\(`type` = 'template', 'ws_system', 'ws_default'\)/i,
    );
    // 存量业务数据 → ws_default
    expect(body).toMatch(
      /UPDATE `chat_channels` SET `workspace_id` = 'ws_default'/i,
    );
    expect(body).toMatch(
      /UPDATE `users` SET `last_workspace_id` = 'ws_default'/i,
    );
  });

  it('users 回填 workspace_members（每用户一行，admin 为 owner）', () => {
    const body = executable();
    expect(body).toMatch(/INSERT INTO `workspace_members`/i);
    expect(body).toMatch(/IF\(`username` = 'admin', 'owner', 'member'\)/i);
  });
});
