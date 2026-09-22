import * as fs from 'fs';
import * as path from 'path';
import {
  ROLE_BOUNDARIES,
  VTEAM_MCP_TOOL_NAMES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import {
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
  EXTERNAL_AGENT_ROLE_TOOL_ALLOWLIST,
} from '../common/constants/agent-role.constants';
import {
  buildCapabilityMatrixFromTools,
  buildFactoryCapabilityMatrix,
  capabilityKeyForTool,
} from '../common/constants/platform-capability.constants';

/**
 * 迁移契约：`20260921000006_agent_role_capabilities`（role-owned capability model）。
 *
 * 本迁移把岗位平台工具权威从 `policy_id` 间接层换成 `capabilities` 能力点矩阵：
 *   1. ADD COLUMN capabilities JSON NULL；
 *   2. 内置角色从现网 config.tools 派生（临时表物化，避免 UPDATE 自引用 1093）；
 *   3. 无策略行时回退常量口径矩阵（7 个内置 key）；
 *   4. 外部 3 岗位写 ep_external 等价矩阵；其余角色（ar_general 等）写出厂矩阵；
 *   5. 兜底 UPDATE 保证无 NULL capabilities；
 *   6. DROP policy_id + 索引，DELETE ep_external（NOT EXISTS 守卫）。
 *
 * 关键证明：迁移内嵌的**常量口径矩阵**与 `platform-capability.constants` +
 * `ROLE_BOUNDARIES` 的代码派生逐键相等（内置/外部/出厂三类），杜绝 SQL 与 TS 漂移。
 * 真库 populated/fresh 迁移演练记录在 notepad（scratch DB 证明）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260921000006_agent_role_capabilities',
  'migration.sql',
);
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const BUILTIN_KEYS = [
  'product',
  'project_manager',
  'architect',
  'developer',
  'tester',
  'plan',
  'librarian',
] as const;

function jsonLiteralAfter(prefix: string, sql: string): Record<string, boolean> {
  const idx = sql.indexOf(prefix);
  if (idx < 0) {
    throw new Error(`迁移缺少字面量锚点: ${prefix}`);
  }
  const start = sql.lastIndexOf("CAST('", idx) + "CAST('".length;
  const end = sql.indexOf("' AS JSON)", start);
  return JSON.parse(sql.slice(start, end).replace(/''/g, "'"));
}

describe('agent_roles.capabilities 迁移契约（capability model）', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const ddl = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

  it('头注释声明 capability 背景 / default-allow / 保守映射 / 单向性 / JSON 陷阱', () => {
    for (const marker of [
      'capability model',
      'default-allow',
      '保守方向',
      '单向迁移',
      'JSON_OBJECT',
    ]) {
      expect(sql).toContain(marker);
    }
  });

  it('DDL：恰一条 ADD COLUMN capabilities JSON NULL', () => {
    const addColumns = ddl.match(/ADD COLUMN/g) ?? [];
    expect(addColumns).toHaveLength(1);
    expect(ddl).toMatch(/ALTER TABLE `agent_roles` ADD COLUMN `capabilities` JSON NULL;/);
  });

  it('内置派生走临时表物化（避免 UPDATE 自引用）+ config.tools OBJECT 守卫', () => {
    expect(sql).toContain('CREATE TEMPORARY TABLE `tmp_agent_role_tools`');
    expect(sql).toMatch(
      /JSON_TYPE\(`p`\.`config` -> '\$\.tools'\) = 'OBJECT'/,
    );
    expect(sql).toMatch(
      /INNER JOIN `tmp_agent_role_tools` AS `t` ON `t`\.`role_id` = `r`\.`id`/,
    );
    expect(sql).toContain('DROP TEMPORARY TABLE IF EXISTS `tmp_agent_role_tools`');
  });

  it('每个能力点表达式产出 JSON true/false（NULL 值为 null 的陷阱已规避）', () => {
    // 21 个能力点键均出现在派生 JSON_OBJECT 中，值表达式恒走 CAST('true'/'false' AS JSON)。
    const derivation = sql.slice(
      sql.indexOf('SET `r`.`capabilities` = JSON_OBJECT('),
      sql.indexOf('WHERE `r`.`capabilities` IS NULL;'),
    );
    for (const key of Object.keys(buildFactoryCapabilityMatrix())) {
      expect(derivation).toContain(`'${key}',`);
    }
    expect((derivation.match(/CAST\('true' AS JSON\)/g) ?? []).length).toBeGreaterThanOrEqual(21);
    expect((derivation.match(/CAST\('false' AS JSON\)/g) ?? []).length).toBeGreaterThanOrEqual(21);
  });

  it('内置常量回退矩阵（7 key）与 ROLE_BOUNDARIES 代码派生逐键相等', () => {
    for (const key of BUILTIN_KEYS) {
      const literal = jsonLiteralAfter(
        `WHERE \`type\` = 'builtin' AND \`capabilities\` IS NULL AND \`key\` = '${key}';`,
        sql,
      );
      const derived = buildCapabilityMatrixFromTools(
        ROLE_BOUNDARIES[`vteam-${key}` as VteamAgentName].toolAllows,
      );
      expect(literal).toEqual(derived);
    }
  });

  it('外部岗位矩阵与 EXTERNAL_AGENT_ROLE_CAPABILITIES 逐键相等（8 true / 13 false）', () => {
    const literal = jsonLiteralAfter(
      "WHERE `capabilities` IS NULL AND `key` IN ('sisyphus', 'prometheus', 'atlas');",
      sql,
    );
    expect(literal).toEqual(EXTERNAL_AGENT_ROLE_CAPABILITIES);
    expect(Object.values(literal).filter(Boolean)).toHaveLength(8);
    expect(Object.values(literal).filter((v) => v === false)).toHaveLength(13);
    // 8 个 true 能力点恰覆盖外部 8 工具。
    const granted = Object.entries(literal)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort();
    const fromTools = [
      ...new Set(
        EXTERNAL_AGENT_ROLE_TOOL_ALLOWLIST.map((t) =>
          capabilityKeyForTool(t),
        ),
      ),
    ].sort();
    expect(granted).toEqual(fromTools);
    expect(EXTERNAL_AGENT_ROLE_KEYS).toEqual([
      'sisyphus',
      'prometheus',
      'atlas',
    ]);
  });

  it('出厂矩阵兜底 UPDATE（WHERE capabilities IS NULL）与工厂派生相等，保证无 NULL', () => {
    const matches = [
      ...sql.matchAll(
        /SET `capabilities` = CAST\('(\{[^']*\})' AS JSON\) WHERE `capabilities` IS NULL;/g,
      ),
    ];
    expect(matches).toHaveLength(1);
    expect(JSON.parse(matches[0][1])).toEqual(buildFactoryCapabilityMatrix());
  });

  it('删除 policy 间接层：DROP INDEX + DROP COLUMN policy_id', () => {
    expect(sql).toMatch(/DROP INDEX `idx_agent_roles_policy` ON `agent_roles`;/);
    expect(sql).toMatch(/ALTER TABLE `agent_roles` DROP COLUMN `policy_id`;/);
  });

  it('DELETE ep_external 带 NOT EXISTS(agents.policy_id) 引用守卫', () => {
    expect(sql).toMatch(
      /DELETE FROM `execution_policies`[\s\S]*?WHERE `id` = 'ep_external'[\s\S]*?AND NOT EXISTS \(SELECT 1 FROM `agents` WHERE `policy_id` = 'ep_external'\)/,
    );
  });

  it('schema：AgentRole 含 capabilities（无 policyId）；Agent 仍含 policyId', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const roleModel = schema.match(/^model AgentRole \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(roleModel).toMatch(/^\s*capabilities Json\?\s+@map\("capabilities"\)\s*$/m);
    expect(roleModel).not.toMatch(/^\s*policyId\s/m);
    expect(roleModel).not.toMatch(/idx_agent_roles_policy/);

    const agentModel = schema.match(/^model Agent \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(agentModel).toMatch(/^\s*policyId\s+String\?\s+@map\("policy_id"\)\s*$/m);
  });

  it('目录覆盖 28 工具（迁移按同目录硬编码，漂移即红）', () => {
    expect(VTEAM_MCP_TOOL_NAMES).toHaveLength(28);
  });
});
