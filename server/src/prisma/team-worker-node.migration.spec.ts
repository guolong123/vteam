import * as fs from 'fs';
import * as path from 'path';

/**
 * 迁移守卫 spec：`20261014000000_team_worker_node`（team-worker-node Todo 7）。
 *
 * 存在理由：与 `model-usage.migration.spec.ts` 同源——本仓本机/CI 无 MySQL
 * （`nc -z localhost 3306` 不通、`jest.config.js` 无 `globalSetup`、无 `db push`），
 * 这份迁移是**手写 DDL**，真跑 SQL 的机会为零 ⇒ **本 spec 是它的唯一护栏**。
 * 断言方向按「DROP」**反转**：前几个迁移守卫 mostly 断言「schema 有的 DDL 必须有」，
 * 本轮还要断言「schema 已删的东西，DDL 必须真的删掉」（删不干净会在已部署库留下死列，
 * 且新服务不再读写它 ⇒ 静默漂移，没有任何报错会提醒）。
 *
 * 为什么是「追加迁移」而不是「编辑 baseline」（docs/migration-baseline.md:29-31）：
 *   基线是 2026-09-25 从整库 dump 折叠出来的**历史事实**，已部署库按目录顺序逐条写
 *   `_prisma_migrations`。回头改 baseline 对已部署库是**静默 no-op**（那几句 DDL 早已
 *   执行过、不会再跑），只会在文件与真实库之间留下永久漂移；而空库重建时才读到新内容，
 *   于是同一份基线在「存量库」与「新库」两条路径上给出两套 schema——这正是基线文档
 *   明令禁止的「用 schema 重建基线」。追加新迁移目录则两条路径都干净：存量库从断点继续，
 *   新库从 baseline 建表后照样应用本迁移。**不得**编辑
 *   `server/prisma/migrations/20260925000000_squashed_baseline/migration.sql`。
 *
 * 反例先例（本轮**故意不照做**）：`server/src/prisma/agent-role-drop.migration.spec.ts:1-15`
 * 记录的是**相反**的做法——历史上的 drop 被**折叠进 baseline**、迁移本身不再存在，最终态
 * 由 spec 反述「role 归属改由 team_members/agent_roles 承载」。那条先例的前提是「当初
 * 折叠时顺带处理、且现存库已经落地」；本轮发生在折叠**之后**，没有历史迁移可以回收，
 * 也没有任何已落地状态可以反述，只能追加。
 *
 * 校验八件事（按 DROP 反转后的口径）：
 * 1. baseline **必须**含 `agents`.`worker_id`（:130）——它是本迁移的删除对象，也是
 *    「已部署库里该列真实存在」的证据（删一个不存在的列会 ERROR 1091 炸 init job）；
 * 2. 新迁移**必须**含 `ALTER TABLE \`agents\` DROP COLUMN \`worker_id\``；
 * 3. 新迁移**必须**含两条 `ADD COLUMN \`preferred_worker_id\``（teams 与 team_members）；
 * 4. schema.prisma 的 Agent 段**不再**声明 `workerId`，且 `preferred_worker_id` 恰好两处；
 * 5. 新迁移零 `UPDATE`/`INSERT`/`FOREIGN KEY`/`IF EXISTS`/`IF NOT EXISTS`（剔除 `--`
 *    注释行后；本迁移的中文理由头也不得写出这些字面量与裸列名，否则本断言与 schema
 *    注释的同名约束会打架）；
 * 6. baseline 里 `agents` 的 `worker_id` **无 FK 无索引**（:135-141 的 PRIMARY/UNIQUE/
 *    KEY/CONSTRAINT 段零命中）——这既是 DROP 安全的前提，也是「不可逆」的证据：
 *    删它不会牵动任何约束；
 * 7. 三条 DDL 的顺序、表名、列形态与 Prisma 自产 `migrate diff` 输出一致（离线等价性）；
 * 8. 迁移目录恰好一个，且字典序**晚于** `20261010030000_worker_update_state`——
 *    顺序错了 `migrate deploy` 会在含该列的旧 schema 之前/之后错位，且与
 *    `docs/migration-baseline.md` 的「按目录顺序逐条应用」直接冲突。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261014000000_team_worker_node',
  'migration.sql',
);

const BASELINE_MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260925000000_squashed_baseline',
  'migration.sql',
);

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
);

const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const sql = () => fs.readFileSync(MIGRATION, 'utf8');
const baselineSql = () => fs.readFileSync(BASELINE_MIGRATION, 'utf8');
const schema = () => fs.readFileSync(SCHEMA, 'utf8');

/** 本迁移目录名（不含路径）。 */
const MIGRATION_DIR_NAME = '20261014000000_team_worker_node';

/** 上一批手写迁移目录名——本迁移必须在字典序上排在它之后。 */
const PREVIOUS_MIGRATION_DIR_NAME = '20261010030000_worker_update_state';

/**
 * 剔除 `--` 注释行与空行，只留可执行 DDL。
 * 形状照抄 `model-usage.migration.spec.ts` 的 `statements()`：断言「本迁移只做了 X」
 * 必须跑在剔除注释后的语句行上，否则理由头里提到的字样会被误判成 DDL。
 */
function statements(): string[] {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 剔除 `--` 注释行后的整段文本（供正则断言逐字比对）。 */
function executableSql(): string {
  return sql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

/** baseline 里 `CREATE TABLE \`agents\` (...)` 的整块定义文本。 */
function baselineAgentsBlock(): string {
  const m = /CREATE TABLE `agents` \(([\s\S]*?)\n\) ENGINE=/.exec(
    baselineSql(),
  );
  if (!m) throw new Error('baseline 迁移未找到 agents 建表语句');
  return m[1];
}

/** baseline 里 `agents` 表的**列声明**行（排除 PRIMARY/UNIQUE/KEY/CONSTRAINT 行）。 */
function baselineAgentsColumns(): string[] {
  return baselineAgentsBlock()
    .split('\n')
    .filter((l) => /^\s*`/.test(l))
    .filter((l) => !/^\s*(PRIMARY KEY|UNIQUE KEY|KEY|CONSTRAINT)\b/.test(l));
}

/** baseline 里 `agents` 表的**约束与索引**行（:135-141 那段）。 */
function baselineAgentsConstraints(): string[] {
  return baselineAgentsBlock()
    .split('\n')
    .filter((l) => /^\s*(PRIMARY KEY|UNIQUE KEY|KEY|CONSTRAINT)\b/.test(l));
}

/** schema.prisma 里 `model Agent` 的声明块文本。 */
function schemaAgentBlock(): string {
  const m = /^model Agent \{([\s\S]*?)^\}/m.exec(schema());
  if (!m) throw new Error('schema.prisma 未找到 model Agent');
  return m[1];
}

describe('migration 20261014000000_team_worker_node', () => {
  it('① baseline 必须含 agents.worker_id（它是本迁移的删除对象，删不存在的列会 ERROR 1091）', () => {
    // 反转方向的关键一条：删列类迁移的护栏必须双向——既证明「库里真有这一列」
    // （否则 DDL 会在真实部署时炸），也证明「本迁移真的删了它」（见断言②）。
    const cols = baselineAgentsColumns().map((l) => l.trim().split(/\s+/)[0]);
    expect(cols).toContain('`worker_id`');
    // 列形态与 schema 同口径：可空字符串列，宽 191。
    expect(baselineAgentsBlock()).toMatch(
      /`worker_id`\s+varchar\(191\)\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci\s+DEFAULT NULL/,
    );
  });

  it('② 新迁移必须含 ALTER TABLE `agents` DROP COLUMN `worker_id`', () => {
    expect(executableSql()).toContain(
      'ALTER TABLE `agents` DROP COLUMN `worker_id`;',
    );
    // 且只删这一处：不得把删除扩到别的表/别的列（顺手动 = 越界）。
    expect(executableSql().match(/DROP COLUMN/g) ?? []).toHaveLength(1);
  });

  it('③ 新迁移必须含 teams 与 team_members 两条 ADD COLUMN preferred_worker_id', () => {
    const adds = executableSql().match(/ADD COLUMN `preferred_worker_id`/g);
    expect(adds).not.toBeNull();
    expect(adds).toHaveLength(2);

    expect(executableSql()).toContain(
      'ALTER TABLE `teams` ADD COLUMN `preferred_worker_id` varchar(191) DEFAULT NULL;',
    );
    expect(executableSql()).toContain(
      'ALTER TABLE `team_members` ADD COLUMN `preferred_worker_id` varchar(191) DEFAULT NULL;',
    );
  });

  it('④ schema.prisma 的 Agent 段零 workerId，且 preferred_worker_id 恰好两处', () => {
    // 摘声明（Todo 6）与删列（本 todo）必须同时发生：只摘声明会留下死列，
    // 只删列会让 Prisma client 读一个不存在的列 → 运行时 P2022。
    expect(schemaAgentBlock()).not.toMatch(/\bworkerId\b/);
    // @map 字面量计数：多了说明有第三处声明/注释漏改（schema 注释也不得写裸列名）。
    expect(schema().match(/preferred_worker_id/g) ?? []).toHaveLength(2);
    // 两处都必须真的落在 Team 与 TeamMember 两个模型里（不得两处都挤在同一模型）。
    const teamBlock = /^model Team \{([\s\S]*?)^\}/m.exec(schema());
    const memberBlock = /^model TeamMember \{([\s\S]*?)^\}/m.exec(schema());
    expect(teamBlock?.[1]).toContain('@map("preferred_worker_id")');
    expect(memberBlock?.[1]).toContain('@map("preferred_worker_id")');
  });

  it('⑤ 零 UPDATE / INSERT / FOREIGN KEY / IF EXISTS / IF NOT EXISTS（剔除注释后）', () => {
    // 理由头同样不得写出这些字面量与裸列名，否则「剔除注释后计数」这条护栏
    // 会被自己的文档绕过（与 schema 注释 :171 的同名约束对齐）。
    const ddl = executableSql();
    expect(ddl).not.toMatch(/\bUPDATE\b/i);
    expect(ddl).not.toMatch(/\bINSERT\b/i);
    expect(ddl).not.toMatch(/FOREIGN\s+KEY/i);
    expect(ddl).not.toMatch(/\bIF\s+EXISTS\b/i);
    expect(ddl).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    // 理由头（原始注释行）本身也不得包含上述字面量——双重防线，二条都得干净。
    const comments = sql()
      .split('\n')
      .filter((l) => l.trim().startsWith('--'))
      .join('\n');
    for (const forbidden of [
      /\bUPDATE\b/i,
      /\bINSERT\b/i,
      /FOREIGN\s+KEY/i,
      /\bIF\s+EXISTS\b/i,
      /\bIF\s+NOT\s+EXISTS\b/i,
    ]) {
      expect(comments).not.toMatch(forbidden);
    }
    expect(comments).not.toContain('preferred_worker_id');
  });

  it('⑥ baseline 里 agents.worker_id 无 FK 无索引（:135-141 的约束段零命中）', () => {
    // DROP 安全的前提：删一个被索引/FK 引用的列需要先摘约束（MySQL 会报错），
    // 且摘约束本身又是新的不可逆 DDL。这里证明它只是裸列，本迁移一句话就够。
    const constraints = baselineAgentsConstraints();
    expect(constraints.length).toBeGreaterThan(0);
    for (const line of constraints) {
      expect(line).not.toContain('worker_id');
    }
    // 该表真实存在的约束（base_agent_id / created_by / agent_key）必须仍在段内，
    // 否则上面那句 for 会是空转（空数组 = 恒绿）。
    expect(constraints.join('\n')).toContain('`uk_agents_agent_key`');
    expect(constraints.join('\n')).toContain(
      'CONSTRAINT `agents_base_agent_id_fkey`',
    );
  });

  it('⑦ 三条 DDL 与 Prisma 自产 migrate diff 输出等价（列形态/顺序/表名）', () => {
    // 离线等价自证（本机无 MySQL）：`prisma migrate diff
    // --from-schema-datamodel <迁移前 schema> --to-schema-datamodel
    // prisma/schema.prisma --script` 的原始输出为：
    //   ALTER TABLE `teams` ADD COLUMN `preferred_worker_id` VARCHAR(191) NULL;
    //   ALTER TABLE `team_members` ADD COLUMN `preferred_worker_id` VARCHAR(191) NULL;
    //   ALTER TABLE `agents` DROP COLUMN `worker_id`;
    // Prisma 把可空列渲染成 `VARCHAR(191) NULL`，MySQL 对可空列的隐式默认即 NULL，
    // 与手写的 `DEFAULT NULL` 同义；故此处逐条比对时把 NULL/DEFAULT NULL 视为等价，
    // 并钉死顺序（teams → team_members → agents）与「三条语句、一个表一条」。
    const canonical = statements().map((s) => s.replace(/\s+/g, ' '));
    expect(canonical).toEqual([
      'ALTER TABLE `teams` ADD COLUMN `preferred_worker_id` varchar(191) DEFAULT NULL',
      'ALTER TABLE `team_members` ADD COLUMN `preferred_worker_id` varchar(191) DEFAULT NULL',
      'ALTER TABLE `agents` DROP COLUMN `worker_id`',
    ]);
    // 每张表只被碰一次：不得把 DROP 拆成第二次 ALTER，也不得顺手动别的表。
    const tables = canonical.map((s) => /ALTER TABLE `(\w+)`/.exec(s)?.[1]);
    expect(tables).toEqual(['teams', 'team_members', 'agents']);
    expect(new Set(tables).size).toBe(3);
  });

  it('⑧ 迁移目录恰好一个，且字典序晚于上一批迁移（存量/新库两条路径同序）', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d.includes('team_worker_node'));
    expect(dirs).toEqual([MIGRATION_DIR_NAME]);

    const all = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => fs.statSync(path.join(MIGRATIONS_DIR, d)).isDirectory())
      .sort();
    // 字典序即 `migrate deploy` 的应用顺序（docs/migration-baseline.md）。
    // 新库：baseline 建表（含 agents.worker_id）→ … → 本迁移删列；
    // 存量库：断点续跑 → 同样在本迁移删列。两条路径的顺序必须一致，
    // 否则同一份代码在两类库上留下不同 schema（stale_state 对抗项）。
    expect(all.indexOf(MIGRATION_DIR_NAME)).toBeGreaterThan(
      all.indexOf(PREVIOUS_MIGRATION_DIR_NAME),
    );
    expect(
      all.indexOf(MIGRATION_DIR_NAME) >
        all.indexOf('20260925000000_squashed_baseline'),
    ).toBe(true);
    // 刻意**不断言**「本迁移是全仓最后一个目录」：那是与契约无关的过强约束，
    // 此后任何人追加新迁移（哪怕是无关 lane 的 migration）都会把它打红，
    // 护栏本身变成噪音。真实契约只有三条：恰好一个本迁移目录、
    // 排在上一批之后、排在 baseline 之后。
    // （2026-10-14 实测踩过：兄弟 lane 追加 20261014010000_memory_search_to_list
    //   后该断言转红，已按本条注释修正。）
    expect(all).toContain(PREVIOUS_MIGRATION_DIR_NAME);
  });

  it('⑨ 不得编辑 baseline（反转方向的静默 no-op 防线）', () => {
    // 基线仍是 2026-09-25 的历史事实：agent 段必须原样含 worker_id 列声明行。
    // 若有人把删除「折进」baseline，本迁移的 DROP 会在真实部署时 ERROR 1091，
    // 而已部署库则永远漂移（那句 DDL 不会再跑）。
    expect(baselineAgentsColumns().join('\n')).toContain(
      '`worker_id` varchar(191)',
    );
    expect(statements()).toHaveLength(3);
  });
});
