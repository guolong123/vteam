import * as fs from 'fs';
import * as path from 'path';

/**
 * agent-role-decommission todo 7 迁移契约（`20260919000010_drop_agents_role`）。
 *
 * 本迁移是**单向 contract 阶段**（删列无反向 SQL，回滚=恢复 pre-migration dump）。
 * jest 基座不连真库（真库 populated-DB 迁移证明 + 回滚演练记录在
 * `.omo/evidence/agent-role-decommission/task-7-drop.txt`）。本 spec 锁定结构契约：
 *   1. 迁移头注释声明列的历史用途、四个用途的替换去向、精确回滚命令与 dump 路径；
 *   2. 回填谓词**显式收窄**（review fix m6）：两条 JOIN 均要求目标策略行存在 + `policy_id IS NULL`；
 *   3. 孤儿守卫在 DROP 之前（非 custom 行 policy_id 仍 NULL → 迁移失败，DROP 不执行）；
 *   4. custom 有意无策略清单 SELECT 在 DROP 之前（DROP 后 role 列不可达）；
 *   5. `ALTER TABLE agents DROP COLUMN role` 恰一条且位于文件末尾；
 *   6. schema.prisma 的 model Agent 不再含 `role String?`。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260919000010_drop_agents_role',
  'migration.sql',
);
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

describe('agents.role drop 迁移契约（todo 7）', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  /** 去注释后的可执行 SQL（头注释含 DROP/DROP COLUMN 字样，语句计数须只看代码行）。 */
  const ddl = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

  it('头注释声明四用途历史 + 替换去向 + 精确回滚命令与 dump 路径', () => {
    for (const marker of [
      '岗位标签',
      'ep_<role>',
      'vteam-<role>',
      '计划职责判定',
      'AgentRole',
      'policyId',
      'agentKey',
      'DROP COLUMN',
    ]) {
      expect(sql).toContain(marker);
    }
    expect(sql).toContain('pre-migration-dump.sql');
    expect(sql).toMatch(/mysqldump -uroot -p"\$MYSQL_ROOT_PASSWORD"/);
    expect(sql).toMatch(/mysql -uroot -p"\$MYSQL_ROOT_PASSWORD" aiagents/);
    expect(sql).toContain(
      '.omo/evidence/agent-role-decommission/pre-migration-dump.sql',
    );
    expect(sql).toContain('单向');
  });

  it('回填 a1：旧 ep_<role> 回退——JOIN 到真实存在的策略行 + 仅 NULL 行', () => {
    expect(sql).toMatch(
      /UPDATE `agents` AS `a`[\s\S]*?INNER JOIN `execution_policies` AS `p` ON `p`\.`id` = CONCAT\('ep_', `a`\.`role`\)[\s\S]*?WHERE `a`\.`policy_id` IS NULL[\s\S]*?AND `a`\.`role` IS NOT NULL/,
    );
  });

  it('回填 a2：ep_<agentKey> 键路径——同样收窄到真实策略行 + 仅 NULL 行', () => {
    expect(sql).toMatch(
      /INNER JOIN `execution_policies` AS `p` ON `p`\.`id` = CONCAT\('ep_', `a`\.`agent_key`\)[\s\S]*?WHERE `a`\.`policy_id` IS NULL[\s\S]*?AND `a`\.`agent_key` IS NOT NULL/,
    );
  });

  it('孤儿守卫在 DROP 之前：非 custom 且 policy_id 仍 NULL → INSERT NULL 报错，DROP 不执行', () => {
    const guardAt = sql.indexOf('_drop_agents_role_orphan_guard');
    const dropAt = sql.indexOf('ALTER TABLE `agents` DROP COLUMN `role`');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThan(guardAt);
    expect(sql).toMatch(
      /WHERE `policy_id` IS NULL AND `type` <> 'custom' LIMIT 1/,
    );
  });

  it('custom 清单 SELECT 在 DROP 之前（「有意无策略」绝不静默）', () => {
    const listAt = sql.indexOf(
      "WHERE `type` = 'custom' AND `policy_id` IS NULL",
    );
    const dropAt = sql.indexOf('ALTER TABLE `agents` DROP COLUMN `role`');
    expect(listAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThan(listAt);
  });

  it('DROP COLUMN 恰一条、无其它 DDL（不与无关 schema 变更混装）', () => {
    expect(ddl.match(/DROP COLUMN/g) ?? []).toHaveLength(1);
    expect(ddl.match(/ALTER TABLE/g) ?? []).toHaveLength(1);
    const dropAt = ddl.indexOf('ALTER TABLE `agents` DROP COLUMN `role`');
    expect(ddl.slice(dropAt).trim()).toBe(
      'ALTER TABLE `agents` DROP COLUMN `role`;',
    );
  });

  it('schema：model Agent 不再含 role 列（contract 已落地）', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const agentModel = schema.match(/^model Agent \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(agentModel).not.toMatch(/^\s*role\s+String\?\s*$/m);
    expect(agentModel).toContain('agentKey');
  });
});
