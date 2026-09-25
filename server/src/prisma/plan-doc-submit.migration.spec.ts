import * as fs from 'fs';
import * as path from 'path';
import { ROLE_BOUNDARIES } from '../common/constants/agent.constants';
import { BUILTIN_ROLE_CAPABILITY_MAPS } from '../common/constants/agent-role.constants';
import { PLATFORM_CAPABILITY_KEYS } from '../common/constants/platform-capability.constants';

/**
 * Current-schema contract for historical migration
 * `20260923000001_plan_doc_submit`.
 *
 * The archived migration patched both a plan capability row and the
 * `ep_plan` execution-policy JSON.  The squashed baseline is DDL-only, so the
 * durable equivalent is checked at the two current sources of authority:
 * `BUILTIN_ROLE_CAPABILITY_MAPS.plan` and the plan role boundary/seed policy
 * binding.  The old JSON_SET statements are not replayed.
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
const SEED = path.resolve(__dirname, '..', '..', 'prisma', 'seed.ts');

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

describe('plan doc.submit current-schema contract (historical 20260923000001)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const roles = tableDefinition(executable, 'agent_roles');
  const policies = tableDefinition(executable, 'execution_policies');
  const seed = fs.readFileSync(SEED, 'utf8');

  it('baseline records the squash provenance and retains both relevant JSON columns', () => {
    expect(sql).toContain('由原有 81 个 Prisma 迁移压缩而来');
    expect(roles).toMatch(/`capabilities`\s+JSON NULL/);
    expect(policies).toMatch(/`config`\s+JSON NOT NULL/);
  });

  it('plan capability matrix explicitly grants doc.submit and retains the full catalog', () => {
    const plan = BUILTIN_ROLE_CAPABILITY_MAPS.plan;
    expect(Object.keys(plan)).toEqual([...PLATFORM_CAPABILITY_KEYS]);
    expect(plan['doc.submit']).toBe(true);
    expect(
      Object.values(plan).every((value) => typeof value === 'boolean'),
    ).toBe(true);
  });

  it('the plan execution-policy source allows the corresponding submit tool', () => {
    expect(ROLE_BOUNDARIES['vteam-plan'].toolAllows.vteam_submit_artifact).toBe(
      'allow',
    );
    expect(seed).toContain(
      "plan: { policyId: 'ep_plan', agentName: 'vteam-plan' }",
    );
  });

  it('role capability and execution policy remain separate schema authorities', () => {
    expect(roles).not.toContain('`policy_id`');
    expect(policies).toContain('`config` JSON NOT NULL');
    expect(roles).toContain('`capabilities` JSON NULL');
  });

  it('baseline does not contain the archived one-off JSON_SET/REMOVE patch', () => {
    expect(executable).not.toMatch(/JSON_(SET|REMOVE)\(/);
    expect(executable).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\s/m);
  });
});
