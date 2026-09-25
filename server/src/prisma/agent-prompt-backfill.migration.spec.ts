import * as fs from 'fs';
import * as path from 'path';

/**
 * Current-schema contract for the historical
 * `20260919000009_backfill_split_agent_prompts` migration.
 *
 * The original migration updated already-existing `agents` rows with a
 * deliberately narrow SHA/marker guard.  The squashed baseline is a schema
 * deployment artifact, so those one-off UPDATE statements are no longer an
 * executable file.  The equivalent current contract is the baseline column
 * shape plus the seed-owned prompt matrix: a fresh install and an upgraded
 * install must expose the same seven complete template prompts.
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

const ORDER = [
  'a_product',
  'a_project_manager',
  'a_architect',
  'a_developer',
  'a_tester',
  'a_plan',
  'a_librarian',
] as const;

/** The split prompt must not contain any of the old, pre-split sections. */
const PRESPLIT_MARKERS = ['# 角色：', '## 职责', '## 协同方式', '团队协作规约'];

/** Read a table definition from the active single baseline. */
function tableDefinition(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE \`${table}\``);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n) ', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

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

/** Extract the seven template-agent prompt literals from seed.ts. */
function seedAgentPrompts(): Map<string, string> {
  const src = fs.readFileSync(SEED, 'utf8');
  const marker = 'const templateAgents = [';
  const at = src.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(open);
  const arr = new Function(`return (${src.slice(open, end + 1)});`)() as {
    id: string;
    prompt: string;
  }[];
  return new Map(arr.map((agent) => [agent.id, agent.prompt]));
}

describe('agents.prompt current-schema contract (historical 20260919000009)', () => {
  const sql = fs.readFileSync(BASELINE, 'utf8');
  const executable = executableSql(sql);
  const agentsTable = tableDefinition(executable, 'agents');
  const seedPrompts = seedAgentPrompts();

  it('baseline records the single-baseline squash and the immutable migration archive', () => {
    expect(sql).toContain('由原有 81 个 Prisma 迁移压缩而来');
    expect(sql).toContain(
      '.omo/evidence/tech-debt-remediation/legacy-migrations/',
    );
    expect(sql).toContain('完整数据库基线');
  });

  it('baseline exposes the required agents.prompt column and no legacy role column', () => {
    expect(agentsTable).toMatch(/`prompt`\s+TEXT NOT NULL/);
    expect(agentsTable).toContain('`agent_key`');
    expect(agentsTable).toContain('`policy_id`');
    expect(agentsTable).not.toMatch(/`role`\s+VARCHAR/);
  });

  it('seed owns exactly the seven template-agent ids covered by the historical backfill', () => {
    expect([...seedPrompts.keys()].sort()).toEqual([...ORDER].sort());
    expect(seedPrompts.size).toBe(7);
  });

  it('fresh-install prompts are complete, post-split values rather than historical fragments', () => {
    for (const id of ORDER) {
      const prompt = seedPrompts.get(id);
      expect(prompt).toBeDefined();
      expect(prompt?.length).toBeGreaterThan(100);
      expect(prompt).toContain('## 工作方式');
      for (const marker of PRESPLIT_MARKERS) {
        expect(prompt).not.toContain(marker);
      }
    }
  });

  it('all seven seed prompts are independent, deterministic source values', () => {
    const prompts = ORDER.map((id) => seedPrompts.get(id));
    expect(new Set(prompts).size).toBe(ORDER.length);
    expect(prompts.every((prompt) => typeof prompt === 'string')).toBe(true);
  });

  it('the active baseline remains a schema deployment, while historical row DML is archived', () => {
    // ALTER TABLE is expected for foreign keys; one-off data migration DML is not.
    expect(executable).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\s/m);
    expect(executable).not.toMatch(/JSON_(SET|REMOVE)\(/);
  });
});
