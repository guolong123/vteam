import * as fs from 'fs';
import * as path from 'path';
import { ROLE_BOUNDARIES } from '../common/constants/agent.constants';
import { BUILTIN_ROLE_PROMPTS } from '../common/constants/agent-role-prompts.constants';

/**
 * 迁移守卫 spec：`20261022000000_pm_coordination_discipline`（pm-coordination-hardening 批次 C3）。
 *
 * 存在理由：与 `team-worker-node.migration.spec.ts` / `model-usage.migration.spec.ts` 同源——
 * 本机/CI **无 MySQL**（`nc -z localhost 3306` 不通、`jest.config.js` 无 `globalSetup`、无
 * `db push`），这份迁移是**手写 SQL**，真跑一次的机会为零 ⇒ **本 spec 是它的唯一护栏**。
 *
 * 为什么必须用迁移而不是只改常量（这正是本仓咬过人的坑）：
 *   `prisma/seed.ts` 对 ExecutionPolicy / AgentRole 一律 `update: {}`（create-if-absent，
 *   不回滚用户编辑）⇒ **重跑 seed 不会把新正文推给存量部署**；而派发时 agent 实际读到的
 *   是 DB 里的 `agent_roles.role_prompt` 与 `execution_policies.config.correction.scopeSummary`
 *   ⇒ 存量实例不改迁移就永远拿不到新纪律。
 *
 * 为什么是「追加迁移」而不是「编辑 baseline」（docs/migration-baseline.md:29-31）：
 *   基线是 2026-09-25 从整库 dump 折叠出来的**历史事实**，已部署库按目录顺序逐条写
 *   `_prisma_migrations`；回头改 baseline 对已部署库是**静默 no-op**（那几句 DDL 早已执行过、
 *   不会再跑），只会在文件与真实库之间留下永久漂移。`20260925000000_squashed_baseline`
 *   **不得编辑**。
 *
 * 断言十件事：
 *   1. 迁移目录恰好一个，字典序晚于上一批（存量库/新库两条路径同序）；
 *   2. 可执行语句恰好三条，且都是 UPDATE（无 INSERT/DELETE/ALTER/DDL）；
 *   3. 第一条改 `agent_roles`.`role_prompt`，行选择器是 `key` = 'project_manager'；
 *   4. 第二条改 `execution_policies`.`config` → `$.correction.scopeSummary`，
 *      行选择器是 `id` = 'ep_project_manager'；
 *   4b. 第三条改 `execution_policies`.`description`（同一行、同一句话：seed 把 description
 *       落成 scopeSummary ⇒ 两者是同一条事实，漂移即为不一致），守卫同样只认出厂旧值；
 *   5. **不碰其他岗位**（可执行 SQL 里不得出现别的内置 role key / 别的表）；
 *   6. **幂等**：三条的 WHERE 只认「出厂旧值」，新值不在其中 ⇒ 重跑 0 行受影响；
 *   7. **不覆盖用户编辑**：WHERE 认的是出厂旧正文，管理员改过的正文与之不等 ⇒ 不动；
 *   8. **三处副本同文**：常量 === seed 镜像 === 迁移字面量（role_prompt 与 scopeSummary 各一份），
 *      且迁移内 description 字面量 === scopeSummary 字面量；
 *   9. **baseline 未被编辑**：基线里既没有新正文，列形态也没变。
 */
const MIGRATION_DIR_NAME = '20261022000000_pm_coordination_discipline';

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  MIGRATION_DIR_NAME,
  'migration.sql',
);

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
);

const BASELINE = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260925000000_squashed_baseline',
  'migration.sql',
);

const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const SEED = path.resolve(__dirname, '..', '..', 'prisma', 'seed.ts');

/** 上一批手写迁移目录名——本迁移必须在字典序上排在它之后。 */
const PREVIOUS_MIGRATION_DIR_NAME = '20261019000000_parallel_tasks';

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
 * 其余反斜杠序列一律不允许出现（本仓正文引号全为全角，见迁移文件头）。
 */
function unescapeLiteral(raw: string): string {
  expect(raw).not.toMatch(/\\(?![n])/);
  return raw.replace(/\\n/g, '\n');
}

/** 取出 `SET \`col\` = '<字面量>'` 形态里的字面量原文（未还原转义）。 */
function literalAfter(source: string, pattern: RegExp): string {
  const m = pattern.exec(source);
  expect(m).not.toBeNull();
  return m![1];
}

/** seed.ts 的 `BUILTIN_ROLE_PROMPTS` 自包含镜像（seed 不 import src，只能取源码）。 */
function seedRolePrompts(): Record<string, string> {
  const source = fs.readFileSync(SEED, 'utf8');
  const marker = 'const BUILTIN_ROLE_PROMPTS: Record<string, string> =';
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at + marker.length - 1);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(open);
  return new Function(`return (${source.slice(open, end + 1)});`)() as Record<
    string,
    string
  >;
}

/** seed.ts 里 `ROLE_BOUNDARIES` 镜像中某角色的 `scopeSummary` 字面量。 */
function seedScopeSummary(agentName: string): string {
  const source = fs.readFileSync(SEED, 'utf8');
  const block = new RegExp(
    `'${agentName}': defineBoundary\\(\\{([\\s\\S]*?)\\n {2}\\}\\),`,
  ).exec(source);
  expect(block).not.toBeNull();
  const literal = /scopeSummary:\s*(\n\s*)?('(?:[^'\\]|\\.)*')/.exec(block![1]);
  expect(literal).not.toBeNull();
  return new Function(`return ${literal![2]}`)() as string;
}

/** 历史出厂正文 v1（5c38304 引入、5072df5 改掉）——scopeSummary 的旧值之一。 */
const OLD_SCOPE_V1 =
  '流程控制：负责任务拆解编排、进度跟踪、风险与阻塞协调；不产出需求/方案/代码/用例、不越权验收。';

/** 历史出厂正文 v2（5072df5 至今）——scopeSummary 的旧值之二。 */
const OLD_SCOPE_V2 =
  '流程控制：负责进度跟踪、风险与阻塞协调；不拆解任务、不制定计划、不产出需求/方案/代码/用例、不越权验收。';

const NEW_PROMPT = BUILTIN_ROLE_PROMPTS.project_manager;
const NEW_SCOPE = ROLE_BOUNDARIES['vteam-project_manager'].scopeSummary;

describe(`migration ${MIGRATION_DIR_NAME}`, () => {
  it('① 迁移目录恰好一个，字典序晚于上一批与 baseline', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d.includes('pm_coordination_discipline'));
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

  it('③ 第一条改 agent_roles.role_prompt，行选择器是 key = project_manager', () => {
    const stmt = statements()[0];
    expect(stmt).toMatch(/^UPDATE `agent_roles` SET `role_prompt` = '/);
    expect(stmt).toContain('`updated_at` = NOW(3)');
    expect(stmt).toContain("`key` = 'project_manager'");
    // 列形态与 baseline 一致：role_prompt 是可空 TEXT（正文超长时不会被截断成 VARCHAR）。
    const baseline = fs.readFileSync(BASELINE, 'utf8');
    expect(baseline).toMatch(/`role_prompt`\s+text/);
  });

  it('④ 第二条改 execution_policies.config 的 correction.scopeSummary，行选择器是 ep_project_manager', () => {
    const stmt = statements()[1];
    expect(stmt).toMatch(/^UPDATE `execution_policies`/);
    expect(stmt).toContain("JSON_SET(`config`, '$.correction.scopeSummary',");
    expect(stmt).toContain("`id` = 'ep_project_manager'");
    // config 是 json NOT NULL ⇒ 不需要（也不允许）NULL 判据；JSON_SET 需要合法 JSON 列。
    const baseline = fs.readFileSync(BASELINE, 'utf8');
    expect(baseline).toMatch(
      /CREATE TABLE `execution_policies`[\s\S]*?`config` json NOT NULL/,
    );
  });

  it('④b 第三条改 execution_policies.description，同一行、同一句话（seed 落库即 scopeSummary）', () => {
    const stmt = statements()[2];
    expect(stmt).toMatch(/^UPDATE `execution_policies`/);
    expect(stmt).toMatch(/SET `description` = '/);
    expect(stmt).toContain('`updated_at` = NOW(3)');
    expect(stmt).toContain("`id` = 'ep_project_manager'");
    // 守卫只认「出厂旧正文」：NULL 或历史两版出厂文案 ⇒ 管理员改过的 description 不被覆盖。
    expect(stmt).toContain('`description` IS NULL');
    expect(stmt).toContain(`\`description\` = '${OLD_SCOPE_V1}'`);
    expect(stmt).toContain(`\`description\` = '${OLD_SCOPE_V2}'`);
    // 不得出现「≠ 新值」这种宽判据（那会覆盖运营者在页面上改过的文案）。
    expect(stmt).not.toMatch(/description`\s*<>/);
  });

  it('⑤ 不碰其他岗位：可执行 SQL 里没有别的内置 role key，也没有别的表', () => {
    const ddl = executableSql();
    for (const key of [
      'product',
      'architect',
      'developer',
      'tester',
      'plan',
      'librarian',
    ]) {
      expect(ddl).not.toContain(`= '${key}'`);
      expect(ddl).not.toContain(`= 'ar_${key}'`);
      expect(ddl).not.toContain(`= 'ep_${key}'`);
    }
    const tables = [...ddl.matchAll(/UPDATE `(\w+)`/g)].map((m) => m[1]);
    // 三条语句落在两张表上（execution_policies 占两条：config 与 description）。
    expect(tables.sort()).toEqual([
      'agent_roles',
      'execution_policies',
      'execution_policies',
    ]);
    expect(new Set(tables)).toEqual(
      new Set(['agent_roles', 'execution_policies']),
    );
  });

  it('⑥ 幂等：三条的 WHERE 只认「出厂旧值」，新值不在其中 ⇒ 重跑 0 行受影响', () => {
    const roleNew = unescapeLiteral(
      literalAfter(
        statements()[0],
        /UPDATE `agent_roles` SET `role_prompt` = '((?:[^'\\]|\\.)*)'/,
      ),
    );
    expect(roleNew).toBe(NEW_PROMPT);

    const scopeNew = unescapeLiteral(
      literalAfter(
        statements()[1],
        /JSON_SET\(`config`, '\$\.correction\.scopeSummary', '((?:[^'\\]|\\.)*)'\)/,
      ),
    );
    expect(scopeNew).toBe(NEW_SCOPE);

    // 守卫接受的「当前值」集合：role = {NULL, '', 旧正文}；policy = {NULL, 旧 v1, 旧 v2}。
    // （`+` 而非 `*`：排除 `= ''` 这一支，单独用 IS NULL / 空串表达。）
    const acceptedRoleValues = [
      ...[
        ...statements()[0].matchAll(/OR `role_prompt` = '((?:[^'\\]|\\.)+)'/g),
      ].map((m) => unescapeLiteral(m[1])),
    ];
    expect(acceptedRoleValues).toHaveLength(1);
    expect(acceptedRoleValues).not.toContain(roleNew);
    // 空串与 NULL 两支也在守卫里（fresh 行 / 未回填行同样要收敛到新正文）。
    expect(statements()[0]).toContain('`role_prompt` IS NULL');
    expect(statements()[0]).toContain("`role_prompt` = ''");

    const acceptedScopeValues = [
      ...[
        ...statements()[1].matchAll(/scopeSummary'\)\) = '((?:[^'\\]|\\.)+)'/g),
      ].map((m) => unescapeLiteral(m[1])),
    ];
    expect(acceptedScopeValues).toHaveLength(2);
    expect(acceptedScopeValues).not.toContain(scopeNew);
    // 两条历史出厂旧值都在守卫里 ⇒ 所有存量部署（含 5c38304~5072df5 期间建的）都能收敛。
    expect(acceptedScopeValues).toContain(OLD_SCOPE_V1);
    expect(acceptedScopeValues).toContain(OLD_SCOPE_V2);

    const descNew = unescapeLiteral(
      literalAfter(
        statements()[2],
        /UPDATE `execution_policies`\nSET `description` = '((?:[^'\\]|\\.)*)'/,
      ),
    );
    expect(descNew).toBe(NEW_SCOPE);
    const acceptedDescValues = [
      ...statements()[2].matchAll(/OR `description` = '((?:[^'\\]|\\.)+)'/g),
    ].map((m) => unescapeLiteral(m[1]));
    expect(acceptedDescValues).toHaveLength(2);
    expect(acceptedDescValues).not.toContain(descNew);
    expect(acceptedDescValues).toContain(OLD_SCOPE_V1);
    expect(acceptedDescValues).toContain(OLD_SCOPE_V2);
    expect(statements()[2]).toContain('`description` IS NULL');
  });

  it('⑦ 守卫认的是**出厂旧正文**，用户改过的正文不会被覆盖', () => {
    const roleOld = unescapeLiteral(
      literalAfter(statements()[0], /OR `role_prompt` = '((?:[^'\\]|\\.)+)'/),
    );
    // 结构钉死：旧正文是「改之前」的那一版（首尾标记 + 不含新纪律条款）。
    expect(roleOld.startsWith('# 角色：项目经理')).toBe(true);
    expect(roleOld).toContain('只负责流程控制，不产出具体交付物。');
    expect(roleOld.endsWith('可协助整理验收材料与进度汇总。')).toBe(true);
    for (const clause of [
      '产出是派发与核验，不是交付物',
      '派发优先于动手',
      '串行派活',
      '做完即停',
    ]) {
      expect(roleOld).not.toContain(clause);
      expect(NEW_PROMPT).toContain(clause);
    }
  });

  it('⑧ 三处副本同文：常量 === seed 镜像 === 迁移字面量（且迁移内两份同文）', () => {
    const roleNew = unescapeLiteral(
      literalAfter(
        statements()[0],
        /UPDATE `agent_roles` SET `role_prompt` = '((?:[^'\\]|\\.)*)'/,
      ),
    );
    const scopeNew = unescapeLiteral(
      literalAfter(
        statements()[1],
        /JSON_SET\(`config`, '\$\.correction\.scopeSummary', '((?:[^'\\]|\\.)*)'\)/,
      ),
    );
    const descNew = unescapeLiteral(
      literalAfter(
        statements()[2],
        /UPDATE `execution_policies`\nSET `description` = '((?:[^'\\]|\\.)*)'/,
      ),
    );
    expect(roleNew).toBe(BUILTIN_ROLE_PROMPTS.project_manager);
    expect(roleNew).toBe(seedRolePrompts().project_manager);
    expect(scopeNew).toBe(
      ROLE_BOUNDARIES['vteam-project_manager'].scopeSummary,
    );
    expect(scopeNew).toBe(seedScopeSummary('vteam-project_manager'));
    // 迁移内的两份副本（config.correction.scopeSummary 与 description）必须逐字节同文：
    // seed 把 description 落成 scopeSummary，两者是**同一条事实**，漂移即为不一致。
    expect(descNew).toBe(scopeNew);
    expect(descNew).toBe(NEW_SCOPE);
  });

  it('⑨ baseline 未被编辑：基线里既没有新正文，列形态也没变', () => {
    const baseline = fs.readFileSync(BASELINE, 'utf8');
    expect(baseline).not.toContain('产出是派发与核验，不是交付物');
    expect(baseline).not.toContain(NEW_SCOPE);
    expect(baseline).toMatch(/`role_prompt`\s+text/);
    expect(baseline).toMatch(/`config` json NOT NULL/);
    // schema.prisma 与 baseline 仍一致（列名/类型不得漂移）。
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    expect(schema).toMatch(
      /rolePrompt\s+String\?\s+@db\.Text @map\("role_prompt"\)/,
    );
    expect(schema).toMatch(/config\s+Json/);
  });
});
