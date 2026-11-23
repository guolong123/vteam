import * as fs from 'fs';
import * as path from 'path';

/**
 * 迁移守卫 spec：`20261123110000_agent_role_discipline_prompt`。
 *
 * 守三件事（本机/CI 无 MySQL，这份 spec 是迁移的唯一护栏）：
 *   1. 两列 ADD COLUMN 的形态正确（TEXT 可空 / INT NOT NULL DEFAULT 3）；
 *   2. PM 行的 UPDATE 只在未配置时写入（幂等，不覆盖用户编辑）；
 *   3. 正文包含「只协调不执行 / 派发 / 一次一个执行者 / 做完即停」等纪律要点。
 */
const MIGRATION_DIR_NAME = '20261123110000_agent_role_discipline_prompt';
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
);
const MIGRATION = path.resolve(
  MIGRATIONS_DIR,
  MIGRATION_DIR_NAME,
  'migration.sql',
);

const sql = () => fs.readFileSync(MIGRATION, 'utf8');
function statements(): string[] {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe(`migration ${MIGRATION_DIR_NAME}`, () => {
  it('① 目录恰好一个，可执行语句 = 2 条 ALTER + 1 条 UPDATE', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d.includes('agent_role_discipline_prompt'));
    expect(dirs).toEqual([MIGRATION_DIR_NAME]);
    const stmts = statements();
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toMatch(
      /ADD COLUMN `discipline_prompt` text .*DEFAULT NULL/i,
    );
    expect(stmts[1]).toMatch(
      /ADD COLUMN `discipline_every` int NOT NULL DEFAULT 3/i,
    );
    expect(stmts[2].startsWith('UPDATE `agent_roles`')).toBe(true);
  });

  it('② PM UPDATE 只认 key=project_manager，且仅在未配置时写入（幂等）', () => {
    const stmt = statements()[2];
    expect(stmt).toContain("`key` = 'project_manager'");
    expect(stmt).toContain('`discipline_prompt` IS NULL');
    expect(stmt).toContain("`discipline_prompt` = ''");
    expect(stmt).not.toContain('`role_prompt`');
    expect(stmt).not.toContain('`capabilities`');
  });

  it('③ 纪律正文含可执行要点（只协调不执行 / 派发 / 一次一个 / 做完即停）', () => {
    const literal = /SET `discipline_prompt` = '([^']+)'/.exec(statements()[2]);
    expect(literal).not.toBeNull();
    const text = literal![1];
    expect(text).toContain('只做统筹');
    expect(text).toContain('不自己下场排查');
    expect(text).toContain('vteam_notify_agent');
    expect(text).toContain('一次只激活一个执行者');
    expect(text).toContain('做完即停');
  });
});
