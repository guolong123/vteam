import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_AGENT_ROLE_BY_KEY,
  FALLBACK_AGENT_ROLE,
  deriveCustomAgentRoleId,
} from '../common/constants/agent-role.constants';
import { BUILTIN_ROLE_PROMPTS } from '../common/constants/agent-role-prompts.constants';

/**
 * Current-schema contracts for historical migrations
 * `20260919000007_add_agent_roles_and_member_role_id` and
 * `20260919000008_populate_builtin_role_prompts`.
 *
 * The two archived migrations contained table creation/backfill DML and seven
 * prompt UPDATEs.  Those one-off statements cannot be part of a schema-only
 * squash.  The final baseline retains the table/column/FK shape, and the seed
 * plus production derivation functions retain the data invariants that made
 * fresh installs equivalent to upgraded installs.
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
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');
const SEED = path.resolve(__dirname, '..', '..', 'prisma', 'seed.ts');

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

/** Replay the production three-way role resolution contract. */
function resolveBackfillRoleId(agentRole: string | null): string {
  if (agentRole === null) return FALLBACK_AGENT_ROLE.id;
  const builtin = BUILTIN_AGENT_ROLE_BY_KEY[agentRole];
  if (builtin) return builtin.id;
  return deriveCustomAgentRoleId(agentRole);
}

describe('agent_roles current-schema contract (historical 20260919000007)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const roles = tableDefinition(executable, 'agent_roles');
  const members = tableDefinition(executable, 'team_members');
  const agents = tableDefinition(executable, 'agents');

  describe('final schema shape', () => {
    it('baseline keeps the RBAC roles table distinct from agent_roles', () => {
      expect(roles).toContain('CREATE TABLE `agent_roles`');
      expect(executable.match(/CREATE TABLE `roles`/g) ?? []).toHaveLength(1);
      expect(
        executable.match(/CREATE TABLE `agent_roles`/g) ?? [],
      ).toHaveLength(1);
    });

    it('team_members.role_id is nullable, indexed, and restricted on role deletion', () => {
      expect(members).toMatch(/`role_id`\s+VARCHAR\(191\) NULL/);
      expect(members).toContain('INDEX `idx_team_members_role`(`role_id`)');
      expect(executable).toMatch(
        /team_members_role_id_fkey` FOREIGN KEY \(`role_id`\) REFERENCES `agent_roles`\(`id`\) ON DELETE RESTRICT/,
      );
    });

    it('agent_roles.default_agent_id uses SET NULL while the role relationship is separate', () => {
      expect(roles).toMatch(/`default_agent_id`\s+VARCHAR\(191\) NULL/);
      expect(executable).toMatch(
        /agent_roles_default_agent_id_fkey` FOREIGN KEY \(`default_agent_id`\) REFERENCES `agents`\(`id`\) ON DELETE SET NULL/,
      );
      expect(members).toContain('`role_id` VARCHAR(191) NULL');
    });

    it('the removed agents.role column is absent from the final agents table', () => {
      expect(agents).toContain('`agent_key` VARCHAR(63) NULL');
      expect(agents).not.toMatch(/`role`\s+VARCHAR/);
    });

    it('baseline keeps all schema foreign keys while omitting historical data DML', () => {
      expect(sql).toContain('agent_roles_default_agent_id_fkey');
      expect(sql).toContain('team_members_role_id_fkey');
      expect(executable).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\s/m);
    });
  });

  describe('current seed data contract', () => {
    it('the seven builtin role definitions retain stable ids, keys, names, order, and agents', () => {
      expect(BUILTIN_AGENT_ROLES).toHaveLength(7);
      expect(BUILTIN_AGENT_ROLES.map((role) => role.id)).toEqual([
        'ar_product',
        'ar_project_manager',
        'ar_architect',
        'ar_developer',
        'ar_tester',
        'ar_plan',
        'ar_librarian',
      ]);
      for (const role of BUILTIN_AGENT_ROLES) {
        expect(role.key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(role.name.length).toBeGreaterThan(0);
        expect(role.sortOrder).toBeGreaterThan(0);
        expect(role.defaultAgentId).toMatch(/^a_[a-z0-9_]+$/);
      }
    });

    it('the general fallback row remains the documented non-null target', () => {
      expect(FALLBACK_AGENT_ROLE).toMatchObject({
        id: 'ar_general',
        key: 'general',
      });
    });

    it('custom role ids remain deterministic and distinct from builtin/fallback ids', () => {
      const id = resolveBackfillRoleId('analyst');
      expect(id).toBe(deriveCustomAgentRoleId('analyst'));
      expect(id).toMatch(/^ar_c_[0-9a-f]{16}$/);
      expect(id).not.toBe(FALLBACK_AGENT_ROLE.id);
      expect(resolveBackfillRoleId('analyst')).toBe(id);
    });

    it('all three historical backfill cases resolve to a non-null role id', () => {
      expect(resolveBackfillRoleId('product')).toBe('ar_product');
      expect(resolveBackfillRoleId('analyst')).toMatch(/^ar_c_[0-9a-f]{16}$/);
      expect(resolveBackfillRoleId(null)).toBe('ar_general');
      const ids = ['product', 'tester', 'analyst', 'myagent', null, 'plan'].map(
        resolveBackfillRoleId,
      );
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(
        true,
      );
    });

    it('every builtin role has a non-empty role prompt in the current seed source', () => {
      const seed = fs.readFileSync(SEED, 'utf8');
      expect(seed).toContain('const templateAgents = [');
      expect(Object.keys(BUILTIN_ROLE_PROMPTS).sort()).toEqual(
        [...BUILTIN_KEYS].sort(),
      );
      for (const key of BUILTIN_KEYS) {
        const prompt = BUILTIN_ROLE_PROMPTS[key];
        expect(prompt.length).toBeGreaterThan(100);
        expect(prompt.startsWith('# 角色：')).toBe(true);
      }
    });
  });

  describe('Prisma schema agreement', () => {
    it('schema maps AgentRole and TeamMember with the baseline delete semantics', () => {
      const schema = fs.readFileSync(SCHEMA, 'utf8');
      expect(schema).toMatch(
        /model AgentRole \{[\s\S]*?@@map\("agent_roles"\)/,
      );
      expect(schema).toMatch(
        /model TeamMember \{[\s\S]*?roleId\s+String\?\s+@map\("role_id"\)/,
      );
      expect(schema).toMatch(
        /role\s+AgentRole\?\s+@relation\(fields: \[roleId\][\s\S]*?onDelete: Restrict/,
      );
      expect(schema).toMatch(
        /defaultAgent\s+Agent\?\s+@relation\("AgentRoleDefaultAgent"[\s\S]*?onDelete: SetNull/,
      );
    });

    it('schema keeps exactly one RBAC Role model and one AgentRole model', () => {
      const schema = fs.readFileSync(SCHEMA, 'utf8');
      expect((schema.match(/^model Role /gm) ?? []).length).toBe(1);
      expect((schema.match(/^model AgentRole /gm) ?? []).length).toBe(1);
      expect((schema.match(/@@map\("agent_roles"\)/g) ?? []).length).toBe(1);
    });
  });
});

describe('role_prompt current-schema contract (historical 20260919000008)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const roles = tableDefinition(executable, 'agent_roles');

  it('baseline retains the nullable TEXT role_prompt column', () => {
    expect(roles).toMatch(/`role_prompt`\s+TEXT(?:,|$)/m);
  });

  it('seed prompts are complete for every builtin and are not empty placeholders', () => {
    expect(Object.keys(BUILTIN_ROLE_PROMPTS)).toHaveLength(7);
    for (const key of BUILTIN_KEYS) {
      expect(BUILTIN_ROLE_PROMPTS[key].trim().length).toBeGreaterThan(0);
      expect(BUILTIN_ROLE_PROMPTS[key]).toContain('## 职责');
    }
  });

  it('prompt ownership is separate from capability and execution-policy columns', () => {
    expect(roles).toContain('`capabilities` JSON NULL');
    expect(roles).not.toContain('`policy_id`');
  });

  it('the single baseline has no historical role_prompt UPDATE to replay', () => {
    expect(executable).not.toMatch(/UPDATE `agent_roles` SET `role_prompt`/);
    expect(executable).not.toMatch(/JSON_(SET|REMOVE)\(/);
  });
});
