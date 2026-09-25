import * as fs from 'fs';
import * as path from 'path';
import {
  ROLE_BOUNDARIES,
  VTEAM_MCP_TOOL_NAMES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
  EXTERNAL_AGENT_ROLE_TOOL_ALLOWLIST,
} from '../common/constants/agent-role.constants';
import {
  buildCapabilityMatrixFromTools,
  buildFactoryCapabilityMatrix,
  capabilityKeyForTool,
  PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITY_KEYS,
} from '../common/constants/platform-capability.constants';

/**
 * Current-schema contract for historical migration
 * `20260921000006_agent_role_capabilities`.
 *
 * The archived migration changed both data and DDL.  The baseline preserves
 * its final DDL (`agent_roles.capabilities`, with `agents.policy_id` still
 * owned by execution policy), while the current constants preserve the matrix
 * semantics that the migration established.  Assertions below deliberately
 * compare the final schema/source-of-truth values, not removed SQL text.
 */

const BASELINE = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260925000000_squashed_baseline',
  'migration.sql',
);
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'schema.prisma',
);

const BUILTIN_KEYS = BUILTIN_AGENT_ROLES.map((role) => role.key);

function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\s+CHARACTER SET\s+\S+\s+COLLATE\s+\S+/gi, '')
    .replace(/\bDEFAULT NULL\b/gi, 'NULL')
    .replace(/\bUNIQUE KEY\b/gi, 'UNIQUE INDEX')
    .replace(/^(\s*)KEY\s+/gim, '$1INDEX ')
    .replace(/(INDEX\s+`[^`]+`)\s+\(/g, '$1(')
    .replace(/REFERENCES\s+(`[^`]+`)\s+\(/g, 'REFERENCES $1(')
    .replace(/\b(varchar|text|json|datetime|tinyint|int|bigint)\b/gi, (type) =>
      type.toUpperCase(),
    );
}

function tableDefinition(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE \`${table}\``);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n) ', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

function expectCapabilityCatalog(
  matrix: Readonly<Record<string, boolean>>,
): void {
  expect(Object.keys(matrix)).toEqual([...PLATFORM_CAPABILITY_KEYS]);
  expect(
    Object.values(matrix).every((value) => typeof value === 'boolean'),
  ).toBe(true);
}

describe('agent_roles.capabilities current-schema contract (historical 20260921000006)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const roles = tableDefinition(executable, 'agent_roles');
  const agents = tableDefinition(executable, 'agents');
  const policies = tableDefinition(executable, 'execution_policies');

  it('baseline records the single squashed deployment provenance', () => {
    expect(sql).toContain('由原有 81 个 Prisma 迁移压缩而来');
    expect(sql).toContain('legacy-migrations/');
    expect(sql).toContain('完整数据库基线');
  });

  it('agent_roles owns a nullable JSON capability matrix and no policy foreign-key column', () => {
    expect(roles).toMatch(/`capabilities`\s+JSON NULL/);
    expect(roles).not.toContain('`policy_id`');
    expect(roles).toContain('UNIQUE INDEX `uk_agent_roles_key`(`key`)');
  });

  it('default-agent relationship and member role relationship have the intended delete semantics', () => {
    expect(executable).toMatch(
      /agent_roles_default_agent_id_fkey` FOREIGN KEY \(`default_agent_id`\) REFERENCES `agents`\(`id`\) ON DELETE SET NULL/,
    );
    expect(executable).toMatch(
      /team_members_role_id_fkey` FOREIGN KEY \(`role_id`\) REFERENCES `agent_roles`\(`id`\) ON DELETE RESTRICT/,
    );
  });

  it('six derived builtin matrices remain equivalent to their code boundaries', () => {
    for (const key of BUILTIN_KEYS) {
      const derived = buildCapabilityMatrixFromTools(
        ROLE_BOUNDARIES[`vteam-${key}` as VteamAgentName].toolAllows,
      );
      // project_manager is intentionally an explicit full-access override.
      const expected =
        key === 'project_manager'
          ? Object.fromEntries(
              PLATFORM_CAPABILITY_KEYS.map((capability) => [capability, true]),
            )
          : derived;
      expect(BUILTIN_ROLE_CAPABILITY_MAPS[key]).toEqual(expected);
      expectCapabilityCatalog(BUILTIN_ROLE_CAPABILITY_MAPS[key]);
    }
  });

  it('external role matrix remains the explicit eight-tool least-privilege set', () => {
    expect(EXTERNAL_AGENT_ROLE_KEYS).toEqual([
      'sisyphus',
      'prometheus',
      'atlas',
    ]);
    expectCapabilityCatalog(EXTERNAL_AGENT_ROLE_CAPABILITIES);
    const granted = Object.entries(EXTERNAL_AGENT_ROLE_CAPABILITIES)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .sort();
    const fromTools = [
      ...new Set(
        EXTERNAL_AGENT_ROLE_TOOL_ALLOWLIST.map((tool) =>
          capabilityKeyForTool(tool),
        ),
      ),
    ].sort();
    expect(granted).toEqual(fromTools);
  });

  it('factory fallback remains the current complete default-deny matrix', () => {
    const factory = buildFactoryCapabilityMatrix();
    const expected = Object.fromEntries(
      PLATFORM_CAPABILITIES.map((capability) => [
        capability.key,
        !capability.defaultDeny,
      ]),
    );
    expect(factory).toEqual(expected);
    expectCapabilityCatalog(factory);
    expect(
      Object.values(factory).filter((value) => value === false),
    ).toHaveLength(14);
  });

  it('execution policy remains the owner of Agent.policyId and its JSON config column', () => {
    expect(agents).toMatch(/`policy_id`\s+VARCHAR\(191\) NULL/);
    expect(policies).toMatch(/`config`\s+JSON NOT NULL/);
    expect(roles).not.toContain('`policy_id`');
  });

  it('Prisma schema agrees with the final capability ownership boundary', () => {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const roleModel =
      schema.match(/^model AgentRole \{[\s\S]*?^\}/m)?.[0] ?? '';
    const agentModel = schema.match(/^model Agent \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(roleModel).toMatch(/capabilities Json\?\s+@map\("capabilities"\)/);
    expect(roleModel).not.toMatch(/^\s*policyId\s/m);
    expect(agentModel).toMatch(/policyId\s+String\?\s+@map\("policy_id"\)/);
  });

  it('the vteam catalog still covers all 31 tools after the capability split', () => {
    expect(VTEAM_MCP_TOOL_NAMES).toHaveLength(31);
    expect(new Set(VTEAM_MCP_TOOL_NAMES).size).toBe(31);
  });
});
