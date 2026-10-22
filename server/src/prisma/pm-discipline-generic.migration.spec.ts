import * as fs from 'fs';
import * as path from 'path';
import { ROLE_BOUNDARIES } from '../common/constants/agent.constants';
import { BUILTIN_ROLE_PROMPTS } from '../common/constants/agent-role-prompts.constants';

/**
 * 迁移守卫 spec：`20261023000000_pm_discipline_generic`（pm-coordination-hardening 批次 D）。
 *
 * 存在理由与同批其它守卫一致：本机/CI 无 MySQL，手写迁移真跑一次的机会为零 ⇒ 这份 spec
 * 是它唯一的护栏。
 *
 * 为什么需要这条迁移（而不是只改常量）：seed 对 AgentRole / ExecutionPolicy 一律 `update: {}`
 * （create-if-absent，不回滚用户编辑）⇒ 重跑 seed **不会**把新正文推给存量部署；派发时 agent
 * 读到的是 DB 里的值 ⇒ 已跑过批次 C 的实例不改迁移就永远停在「需求→产品经理」那版行业词正文。
 *
 * 断言清单：
 *   1. 目录恰好一个（本次改动没有另起炉灶的第二份），且字典序晚于批次 C 与 receipt 那批；
 *   2. 可执行语句恰好三条，全是 UPDATE（无 INSERT/DELETE/DDL）；
 *   3. 第 (1) 条写 agent_roles.role_prompt，且字面量 === live 常量；
 *   4. 第 (2) 条写 execution_policies.config.correction.scopeSummary，字面量 === live scopeSummary；
 *   5. 第 (3) 条写同一行的 description，与 (2) 同文（seed 把 description 落成 scopeSummary）；
 *   6. 守卫集合覆盖全部出厂旧值：role_prompt 的 NULL/空串/批次 C 之前/批次 C；scope 与
 *      description 的 NULL/两版 C 之前/批次 C —— ��量部署（任一历史版本）都能收敛；
 *   7. 幂等：新值不在守卫集合里 ⇒ 重跑 0 行受影响；
 *   8. 正文**岗位无关**：迁移字面量里不得出现行业产出物映射（需求→…/代码/用例…），
 *      否则本批的唯一目的（非研发团队也读得懂）就没达成。
 */
const MIGRATION_DIR_NAME = '20261023000000_pm_discipline_generic';

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

const C_MIGRATION_DIR_NAME = '20261022000000_pm_coordination_discipline';

const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const PM = 'vteam-project_manager';

const sql = () => fs.readFileSync(MIGRATION, 'utf8');

/** 剔除 `--` 注释行后的整段文本（断言「本迁移只做了 X」必须跑在可执行文本上）。 */
function executableSql(): string {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

/** 可执行语句（按 ASCII 分号切；正文里的分号是全角「；」，不会误切）。 */
function statements(): string[] {
  return executableSql()
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * MySQL 单行字面量还原：正文以 `\n` 转义写入（默认 sql_mode 下 \n = 0x0A），
 * 其余反斜杠序列一律不允许出现（本仓正文引号全为全角）。
 */
function unescapeLiteral(raw: string): string {
  expect(raw).not.toMatch(/\\(?![n])/);
  return raw.replace(/\\n/g, '\n');
}

function literalAfter(source: string, pattern: RegExp): string {
  const m = pattern.exec(source);
  expect(m).not.toBeNull();
  return unescapeLiteral(m![1]);
}

const ROLE_LITERAL_RE =
  /UPDATE `agent_roles` SET `role_prompt` = '((?:[^'\\]|\\.)*)'/;
const SCOPE_LITERAL_RE =
  /JSON_SET\(`config`, '\$\.correction\.scopeSummary', '((?:[^'\\]|\\.)*)'\)/;
const DESC_LITERAL_RE =
  /UPDATE `execution_policies`\nSET `description` = '((?:[^'\\]|\\.)*)'/;

const NEW_PROMPT = BUILTIN_ROLE_PROMPTS.project_manager;
const NEW_SCOPE = ROLE_BOUNDARIES[PM].scopeSummary;

describe(`migration ${MIGRATION_DIR_NAME}`, () => {
  it('① 目录恰好一个，字典序晚于批次 C', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d.includes('pm_discipline_generic'));
    expect(dirs).toEqual([MIGRATION_DIR_NAME]);

    const all = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => fs.statSync(path.join(MIGRATIONS_DIR, d)).isDirectory())
      .sort();
    expect(all.indexOf(MIGRATION_DIR_NAME)).toBeGreaterThan(
      all.indexOf(C_MIGRATION_DIR_NAME),
    );
  });

  it('② 可执行语句恰好三条，且都是 UPDATE（无 INSERT/DELETE/DDL）', () => {
    const stmts = statements();
    expect(stmts).toHaveLength(3);
    for (const s of stmts) {
      expect(s.startsWith('UPDATE ')).toBe(true);
    }
    const ddl = executableSql();
    expect(ddl).not.toMatch(/\bINSERT\b/i);
    expect(ddl).not.toMatch(/\bDELETE\b/i);
    expect(ddl).not.toMatch(/\bALTER\b/i);
    expect(ddl).not.toMatch(/\bCREATE\b/i);
    expect(ddl).not.toMatch(/\bDROP\b/i);
    expect(ddl).not.toMatch(/\bTRUNCATE\b/i);
    expect(ddl).not.toMatch(/\bREPLACE\b/i);
  });

  it('③ role_prompt 条：改 agent_roles、字面量 === live 常量、行选择器是 key = project_manager', () => {
    const stmt = statements()[0];
    expect(stmt).toMatch(/^UPDATE `agent_roles` SET `role_prompt` = '/);
    expect(stmt).toContain('`updated_at` = NOW(3)');
    expect(stmt).toContain("`key` = 'project_manager'");
    expect(literalAfter(stmt, ROLE_LITERAL_RE)).toBe(NEW_PROMPT);
  });

  it('④ scopeSummary 条：改 execution_policies.config、字面量 === live scopeSummary', () => {
    const stmt = statements()[1];
    expect(stmt).toContain("JSON_SET(`config`, '$.correction.scopeSummary'");
    expect(stmt).toContain('`updated_at` = NOW(3)');
    expect(stmt).toContain("`id` = 'ep_project_manager'");
    expect(literalAfter(stmt, SCOPE_LITERAL_RE)).toBe(NEW_SCOPE);
  });

  it('⑤ description 条：同一行、与 scopeSummary 同文（同一条事实，不得漂移）', () => {
    const stmt = statements()[2];
    expect(stmt).toContain("`id` = 'ep_project_manager'");
    const desc = literalAfter(stmt, DESC_LITERAL_RE);
    expect(desc).toBe(NEW_SCOPE);
  });

  it('⑥ 守卫覆盖全部出厂旧值：role 的 NULL/空串/C 之前/C 版；scope 与 description 同理', () => {
    const role = statements()[0];
    expect(role).toContain('`role_prompt` IS NULL');
    expect(role).toContain("`role_prompt` = ''");
    const roleGuards = [
      ...role.matchAll(/OR `role_prompt` = '((?:[^'\\]|\\.)+)'/g),
    ].map((m) => unescapeLiteral(m[1]));
    // 批次 C 的正文（含行业词与「产出是派发与核验」）必须在守卫里 ⇒ 已跑过 C 的实例能收敛。
    expect(roleGuards.some((g) => g.includes('产出是派发与核验'))).toBe(true);
    // 批次 C 之前的出厂正文（不含那四条纪律）也在守卫里 ⇒ 从未跑过 C 的实例同样收敛。
    expect(
      roleGuards.some(
        (g) =>
          g.startsWith('# 角色：项目经理') && !g.includes('产出是派发与核验'),
      ),
    ).toBe(true);

    for (const stmt of [statements()[1], statements()[2]]) {
      const matched =
        stmt === statements()[1]
          ? [...stmt.matchAll(/scopeSummary'\)\) = '((?:[^'\\]|\\.)+)'/g)]
          : [...stmt.matchAll(/OR `description` = '((?:[^'\\]|\\.)+)'/g)];
      const guards = matched.map((m) => unescapeLiteral(m[1]));
      expect(guards).toHaveLength(3);
      // 两版 C 之前出厂值（V1 含「负责任务拆解编排」、V2 含「负责进度跟踪」）+ 批次 C 的值。
      expect(guards.some((g) => g.includes('负责任务拆解编排'))).toBe(true);
      expect(guards.some((g) => g.includes('负责进度跟踪'))).toBe(true);
      expect(guards.some((g) => g.includes('一律派给对应岗位'))).toBe(true);
    }
  });

  it('⑦ 幂等：守卫集合里没有新值 ⇒ 重跑 0 行受影响', () => {
    const roleGuards = [
      ...statements()[0].matchAll(/OR `role_prompt` = '((?:[^'\\]|\\.)+)'/g),
    ].map((m) => unescapeLiteral(m[1]));
    expect(roleGuards).not.toContain(NEW_PROMPT);

    const scopeGuards = [
      ...statements()[1].matchAll(/scopeSummary'\)\) = '((?:[^'\\]|\\.)+)'/g),
    ].map((m) => unescapeLiteral(m[1]));
    expect(scopeGuards).not.toContain(NEW_SCOPE);

    const descGuards = [
      ...statements()[2].matchAll(/OR `description` = '((?:[^'\\]|\\.)+)'/g),
    ].map((m) => unescapeLiteral(m[1]));
    expect(descGuards).not.toContain(NEW_SCOPE);
  });

  it('⑧ 正文岗位无关：迁移字面量里不得出现行业产出物映射', () => {
    const roleNew = literalAfter(statements()[0], ROLE_LITERAL_RE);
    for (const pair of ['需求→', '方案→', '实现→', '用例→', '计划→']) {
      expect(roleNew).not.toContain(pair);
    }
    expect(roleNew).not.toContain('需求/方案');
    expect(roleNew).toContain('【判定顺序·任何请求先过这一步】');
    expect(roleNew).toContain('【冲突裁决】');
    for (const noun of ['需求', '方案', '代码', '用例']) {
      expect(NEW_SCOPE).not.toContain(noun);
    }
  });

  it('⑨ 不碰其它岗位/表：可执行 SQL 里没有别的内置 role key 或别的表', () => {
    const ddl = executableSql();
    const tables = [...ddl.matchAll(/UPDATE `(\w+)`/g)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(
      new Set(['agent_roles', 'execution_policies']),
    );
    for (const key of [
      'product_manager',
      'architect',
      'developer',
      'tester',
      'plan',
      'librarian',
    ]) {
      expect(ddl).not.toContain(`'${key}'`);
    }
  });

  it('⑩ schema 未漂移（列名/类型不变）', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    expect(schema).toMatch(
      /rolePrompt\s+String\?\s+@db\.Text\s+@map\("role_prompt"\)/,
    );
    expect(schema).toMatch(
      /model ExecutionPolicy[\s\S]{0,400}description\s+String\?\s+@db\.Text/,
    );
  });
});
