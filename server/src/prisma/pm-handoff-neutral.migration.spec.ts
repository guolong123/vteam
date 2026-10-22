import * as fs from 'fs';
import * as path from 'path';
import { ROLE_BOUNDARIES } from '../common/constants/agent.constants';
import { renderBoundarySection } from '../chat/worker-dispatcher';

/**
 * 迁移守卫 spec：`20261024000000_pm_handoff_neutral`（pm-coordination-hardening 批次 E）。
 *
 * 与同批其它守卫一致：本机/CI 无 MySQL，手写迁移真跑一次的机会为零 ⇒ 这份 spec 是它唯一的护栏。
 *
 * 守的是三件事：
 *   1. 迁移只做一件事、且只落在 `ep_project_manager` 这一行（不碰其它岗位/表）；
 *   2. 守卫只认**出厂那张 5 项分工表**（逐 scope 比对 `requirements/design/code/test/plan`）
 *      ⇒ 管理员自定义过映射的部署不会被覆盖；幂等（置空后长度为 0，条件不成立）；
 *   3. 迁移结果与**代码口径**一致：常量 `handoffTo` 已是空表，且渲染出的【职责边界】段
 *      不再出现任何 `scope→vteam-*` 映射、也不吐空括号。
 */
const MIGRATION_DIR_NAME = '20261024000000_pm_handoff_neutral';

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

const PREVIOUS_MIGRATION_DIR_NAME = '20261023000000_pm_discipline_generic';

const PM = 'vteam-project_manager';

/** 出厂那张研发分工表（迁移要清掉的东西）。 */
const FACTORY_HANDOFF: Record<string, string> = {
  requirements: 'vteam-product',
  design: 'vteam-architect',
  code: 'vteam-developer',
  test: 'vteam-tester',
  plan: 'vteam-plan',
};

const sql = () => fs.readFileSync(MIGRATION, 'utf8');

function executableSql(): string {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

function statements(): string[] {
  return executableSql()
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe(`migration ${MIGRATION_DIR_NAME}`, () => {
  it('① 目录恰好一个，字典序晚于批次 D', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d.includes('pm_handoff_neutral'));
    expect(dirs).toEqual([MIGRATION_DIR_NAME]);

    const all = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => fs.statSync(path.join(MIGRATIONS_DIR, d)).isDirectory())
      .sort();
    expect(all.indexOf(MIGRATION_DIR_NAME)).toBeGreaterThan(
      all.indexOf(PREVIOUS_MIGRATION_DIR_NAME),
    );
  });

  it('② 可执行语句恰好一条 UPDATE，且只改 execution_policies 的 ep_project_manager', () => {
    const stmts = statements();
    expect(stmts).toHaveLength(1);
    const stmt = stmts[0];
    expect(stmt.startsWith('UPDATE `execution_policies`')).toBe(true);
    expect(stmt).toContain("`id` = 'ep_project_manager'");
    expect(stmt).toContain('`updated_at` = NOW(3)');

    const ddl = executableSql();
    for (const forbidden of [
      /\bINSERT\b/i,
      /\bDELETE\b/i,
      /\bALTER\b/i,
      /\bCREATE\b/i,
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bREPLACE\b/i,
    ]) {
      expect(ddl).not.toMatch(forbidden);
    }
    // 不碰其它岗位：SQL 里只允许出现 ep_project_manager 这一个 id。
    expect([...ddl.matchAll(/'(ep_[a-z_]+)'/g)].map((m) => m[1])).toEqual([
      'ep_project_manager',
    ]);
  });

  it('③ 置空的是 correction.handoff（JSON_OBJECT() 空对象），不是整段 correction', () => {
    const stmt = statements()[0];
    expect(stmt).toContain(
      "JSON_SET(`config`, '$.correction.handoff', JSON_OBJECT())",
    );
    // 只动 handoff：不得用整体覆盖 config / correction 的写法（会冲掉工具与权限配置）。
    expect(stmt).not.toMatch(/SET `config` = JSON_OBJECT/);
    expect(stmt).not.toMatch(/SET `config` = '/);
  });

  it('④ 守卫逐 scope 比对出厂分工表（管理员自定义过的映射不会被覆盖）', () => {
    const stmt = statements()[0];
    expect(stmt).toContain(
      "JSON_LENGTH(JSON_EXTRACT(`config`, '$.correction.handoff')) = 5",
    );
    for (const [scope, target] of Object.entries(FACTORY_HANDOFF)) {
      expect(stmt).toContain(
        `JSON_UNQUOTE(JSON_EXTRACT(\`config\`, '$.correction.handoff."${scope}"')) = '${target}'`,
      );
    }
  });

  it('⑤ 幂等：置空后 JSON_LENGTH 为 0 ⇒ 条件不成立，重跑 0 行', () => {
    const stmt = statements()[0];
    // 唯一的赋值目标就是 handoff 本身 ⇒ 第二次执行时长度已为 0，WHERE 不再命中。
    expect(stmt).toContain("'$.correction.handoff', JSON_OBJECT()");
    expect(stmt).toMatch(
      /JSON_LENGTH\(JSON_EXTRACT\(`config`, '\$\.correction\.handoff'\)\) = 5/,
    );
  });

  it('⑥ 代码口径一致：常量 handoffTo 已空表，渲染段不再出现行业映射与空括号', () => {
    expect(ROLE_BOUNDARIES[PM].handoffTo).toEqual({});

    const section = renderBoundarySection({
      scopeSummary: ROLE_BOUNDARIES[PM].scopeSummary,
      handoff: ROLE_BOUNDARIES[PM].handoffTo,
    });
    expect(section).not.toContain('→vteam-');
    expect(section).not.toContain('（）');
    expect(section.endsWith('转交对应角色。')).toBe(true);
  });
});
