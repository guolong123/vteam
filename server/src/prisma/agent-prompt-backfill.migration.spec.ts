import * as fs from 'fs';
import * as path from 'path';

/**
 * todo 9 数据迁移 (`20260919000009_backfill_split_agent_prompts`) 契约。
 *
 * F3 REJECT：todo 4 只回填了 `agent_roles.role_prompt`，存量 `agents.prompt` 仍是拆分前正文
 * （`agent upsert update: {}` 刻意不覆盖用户编辑）→ 装配把岗位定义叠加一遍、重复。
 * 本迁移把 7 个内置模板行的 `agents.prompt` 升级到与 `seed.ts` 拆分后正文逐字节一致。
 *
 * 静态契约（jest 不连真库；真库 before/after 证明见
 * `.omo/evidence/agent-role-entity/task-9-agent-prompt-backfill.txt`）：
 *   1. 恰 7 条 `UPDATE agents SET prompt = ...`，逐行 `type='template'` + 拆分前 SHA2 + 四个标记守卫；
 *   2. 迁移写入字面量与 `seed.ts` 的 `templateAgents[].prompt` **逐字节相等**；
 *   3. 迁移正文自身不含任何拆分前标记（guard 标记不可能命中已升级行）；
 *   4. SET 目标仅 `prompt` 与 `updated_at`（不触碰能力/权限字段）。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260919000009_backfill_split_agent_prompts',
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

/** 拆分前出厂正文的 SHA2(prompt, 256)（迁移写入时从存量库录制；见迁移头）。 */
const PRESPLIT_SHA: Record<string, string> = {
  a_product: 'd29275d5715fb981a19908599fd76472d6465d7738f0151811b6c239e4f550f1',
  a_project_manager: '1d4a8929a53824e7cddbf2b2be8435c5f84a48adcda8fdcaa2e01f358942b4cc',
  a_architect: 'b43f463cdfe9021c6fcf2f344a0bea6ed9e804a51f83e2b4e7694a83a4fb45b0',
  a_developer: '95af379744e72d75cbe8726cfd6e8ff45f48f3b0e41503c2222e5da40c8fb1ad',
  a_tester: '434d7954182eb13256b19c9324739d986cc6ff9cd375d75b2a9b54853d927181',
  a_plan: '755c79ecbe833e2d9a1d238638daee24f89f46ee85397dc4c57299fe5c1cd7c2',
  a_librarian: '22bd899f8264cf32c655ab6a2b72690a23d63e7d8637992c6e1df3dea1d8e71a',
};

/** 拆分后正文绝不含的四个结构标记（guard (b) 用；也是「行已升级」的判据）。 */
const PRESPLIT_MARKERS = ['# 角色：', '## 职责', '## 协同方式', '团队协作规约'];

/** 从 seed.ts 的 `const templateAgents = [...]` 字面量抽出 7 个 id→prompt（不执行 TS）。 */
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
  return new Map(arr.map((a) => [a.id, a.prompt]));
}

/** 抽出 `WHERE id = '<k>'` 那条 UPDATE 写入的 prompt 字面量（按语句切分）。 */
function unescapeSqlString(literal: string): string {
  return literal.replace(/''/g, "'").replace(/\\n/g, '\n');
}

function extractPromptLiteral(sql: string, id: string): string {
  const statement = sql
    .split(';')
    .find(
      (s) =>
        s.includes('UPDATE `agents` SET `prompt`') &&
        s.includes(`WHERE \`id\` = '${id}'`),
    );
  expect(statement).toBeDefined();
  const m = statement!.match(/SET `prompt` = '((?:[^']|'')*)'/);
  expect(m).not.toBeNull();
  return unescapeSqlString(m![1]);
}

describe('agents.prompt 回填迁移契约（agent-role-entity todo 9）', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const seedPrompts = seedAgentPrompts();

  it('seed 恰 7 个模板 Agent，id 与迁移覆盖集一致', () => {
    expect([...seedPrompts.keys()].sort()).toEqual([...ORDER].sort());
  });

  it('恰 7 条 UPDATE agents SET prompt', () => {
    const updates = sql.match(/UPDATE `agents` SET `prompt`/g) ?? [];
    expect(updates).toHaveLength(7);
    for (const id of ORDER) {
      expect(sql).toContain(`WHERE \`id\` = '${id}'`);
    }
  });

  it('守卫：逐行 type=template + 拆分前 SHA2 + 四个标记（绝不盲写）', () => {
    for (const id of ORDER) {
      const statement = sql
        .split(';')
        .find((s) => s.includes(`WHERE \`id\` = '${id}'`));
      expect(statement).toBeDefined();
      expect(statement).toContain("AND `type` = 'template'");
      expect(statement).toContain(
        `AND SHA2(\`prompt\`, 256) = '${PRESPLIT_SHA[id]}'`,
      );
      for (const marker of PRESPLIT_MARKERS) {
        expect(statement).toContain(`AND \`prompt\` LIKE '%${marker}%'`);
      }
    }
  });

  it('迁移正文与 seed.ts 拆分后 prompt 逐字节相等（fresh install == 存量升级）', () => {
    for (const id of ORDER) {
      const fromMigration = extractPromptLiteral(sql, id);
      expect(fromMigration).toBe(seedPrompts.get(id));
      expect(fromMigration.length).toBeGreaterThan(100);
      expect(fromMigration).toContain('## 工作方式');
    }
  });

  it('seed 拆分后正文不含任何拆分前标记（守卫标记与升级后状态互斥）', () => {
    for (const id of ORDER) {
      const prompt = seedPrompts.get(id) as string;
      for (const marker of PRESPLIT_MARKERS) {
        expect(prompt).not.toContain(marker);
      }
    }
  });

  it('SET 目标仅 prompt 与 updated_at（不触碰能力/权限字段）', () => {
    const setAssignments = [...sql.matchAll(/UPDATE `agents` SET ([\s\S]*?)WHERE/g)];
    expect(setAssignments).toHaveLength(7);
    for (const m of setAssignments) {
      const targets = [...m[1].matchAll(/`([a-z_]+)`\s*=/g)].map((x) => x[1]);
      expect(targets).toEqual(['prompt', 'updated_at']);
    }
  });

  it('声明回滚路径（迁移前 agents 备份 + 还原命令）', () => {
    expect(sql).toContain('回滚');
    expect(sql).toMatch(/mysqldump -uroot -p"\$MYSQL_ROOT_PASSWORD"/);
    expect(sql).toMatch(/mysql -uroot -p"\$MYSQL_ROOT_PASSWORD"/);
    expect(sql).toContain('pre-agent-prompt-backfill-dump.sql');
  });
});
