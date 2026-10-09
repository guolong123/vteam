import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
} from '../common/constants/agent-role.constants';
import {
  ROLE_BOUNDARIES,
  VTEAM_MCP_TOOL_NAMES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import {
  capabilityKeyForTool,
  isPlatformCapabilityKey,
  PLATFORM_CAPABILITIES,
} from '../common/constants/platform-capability.constants';

/**
 * Contract for migration `20261009020000_capability_memory_org_tools`（记忆整理升级回填）。
 *
 * 缺陷：`vteam_memory_archive` / `vteam_memory_merge`（memory-enhancement Todo 8a）的**注册面
 * 齐备**但**存量数据面从未回填**——fresh install 由 seed 首次 create 写入完整矩阵（34 工具），
 * upgrade 路径上两个键在 `execution_policies.config.tools` 与 `agent_roles.capabilities`
 * 双双缺失。生产 Agent 如实上报「当前工具集只有 memory_search/save/update，没有 merge/archive」。
 *
 * 本 spec 的职责（全部**文本解析**，从不执行 SQL —— 结构上验证不了运行时，故只锁 SQL 形状）：
 * 1. **常量一致性**：两个工具名 ∈ `VTEAM_MCP_TOOL_NAMES`、各恰属一个能力点、PM 的
 *    `toolAllows` 含两键、其余 6 岗不含、出厂岗位矩阵逐岗取值正确；
 * 2. **迁移形状**：两个工具键与两个能力点键都必须出现在 SQL 里，且每条语句都写且仅写一个键；
 * 3. **只增不改**：每条 JSON_SET 都以「该键缺失」为守卫（不覆盖运营者已显式的值，含 false/deny）；
 * 4. **回填值 = 出厂矩阵**：解析 SQL 的逐键赋值，与 `BUILTIN_ROLE_CAPABILITY_MAPS` /
 *    `EXTERNAL_AGENT_ROLE_CAPABILITIES` / 其余行的出厂取值逐格比对（SQL↔TS 防漂移）；
 * 5. **无 DDL**：SET 到的列要么建表时已存在，要么由**链上更早**的迁移 ADD COLUMN
 *    （`capabilities_configured_at` 由 20260929000000 建立）——防重演 PR #36 的 `ERROR 1054`；
 * 6. **防误建 tools 对象**：`execution_policies` 两条语句必须带 `vteam_memory_update` 在场守卫。
 *
 * 语义背景见迁移文件头（缺失键在两层的不同语义：层② guard allowlist「缺键 = 不在 allowlist」，
 * 层 `AgentRole.capabilities`「缺键 = 放行」default-allow）。
 */

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261009020000_capability_memory_org_tools',
  'migration.sql',
);

/** 建立 `capabilities_configured_at` 的前序迁移（链上更早 ⇒ 执行时列已存在）。 */
const COLUMN_PROVIDING_MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260929000000_capability_git_web_tier',
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

const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

/** Todo 8a 新增的两个 MCP 工具真实暴露名。 */
const TOOL_KEYS = ['vteam_memory_archive', 'vteam_memory_merge'] as const;
/** 与之对应的两个业务能力点键。 */
const CAPABILITY_KEYS = ['memory.archive', 'memory.merge'] as const;

const BUILTIN_KEYS = BUILTIN_AGENT_ROLES.map((role) => role.key);
const PM_KEY = 'project_manager';
/** 除 PM 外的 6 个内置岗（出厂矩阵里两个键均为 false）。 */
const NON_PM_BUILTIN_KEYS = BUILTIN_KEYS.filter((key) => key !== PM_KEY);

const sql = fs.readFileSync(MIGRATION, 'utf8');

/**
 * 剥掉 `--` 行后的可执行 SQL。
 *
 * 剥注释是**承重**的，不是装饰：本迁移刻意保留了一段**被注释掉的**「外部岗豁免」说明
 * （记录 20260929000000 曾经的做法为何不再适用），它不带分号——朴素解析会把它与下一条
 * 语句粘成一条，从而把外部岗误报成「零写入」或写出错误取值。
 */
function executableSql(): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

interface RoleAssignment {
  key: string;
  value: boolean;
  keys: string[];
  negated: boolean;
}

interface PolicyAssignment {
  tool: string;
  value: string;
  policyId: string;
}

/**
 * 解析 `agent_roles` 的逐键赋值（每条语句恰写一个能力点键）。
 *
 * 判据用**正则提取**而非字符串相等：迁移里 `memory.archive` / `memory.merge` 的岗位名单
 * 形态有三种（PM 单键 `= 'project_manager'`、其余 6 键 / 外部 3 键 `IN (...)`、其余行
 * `NOT IN (...)`），正则把「值 + 名单 + 是否取反」抽成三元组，spec 再与出厂常量逐格
 * 比对——SQL 少写一个岗位、取反写反、值写错、名单退化成单键 `=` 都会红。
 */
function roleAssignments(): RoleAssignment[] {
  const body = executableSql();
  const jsonSet =
    /JSON_SET\(\s*`capabilities`\s*,\s*'([^']+)'\s*,\s*(true|false)\s*\)/g;
  const keyEquals = /`key`\s*=\s*'([\w]+)'/;
  const keyList = /`key`\s+(NOT\s+IN|IN)\s*\(([^)]*)\)/g;
  const out: RoleAssignment[] = [];
  for (const stmt of body.split(';')) {
    if (!stmt.includes('JSON_SET')) continue;
    const set = new RegExp(jsonSet.source).exec(stmt);
    if (!set) continue;
    const list = new RegExp(keyList.source).exec(stmt);
    const single = keyEquals.exec(stmt);
    if (!list && !single) continue;
    out.push({
      key: set[1].replace('$."', '').replace('"', ''),
      value: set[2] === 'true',
      keys: list
        ? [...list[2].matchAll(/'([\w]+)'/g)].map((m) => m[1])
        : [single?.[1] as string],
      negated: list
        ? list[1].toUpperCase().replace(/\s+/g, '') === 'NOTIN'
        : false,
    });
  }
  return out;
}

/** 某能力点键被写入的行 → 取值（忽略 `NOT IN` 语句，它只负责「其余行」）。 */
function writtenFor(capabilityKey: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const a of roleAssignments()) {
    if (a.key !== capabilityKey || a.negated) continue;
    for (const key of a.keys) out[key] = a.value;
  }
  return out;
}

/** 某能力点键的「其余行」（`NOT IN`）语句的排除名单。 */
function restExclusion(capabilityKey: string): string[] | null {
  const stmt = roleAssignments().find(
    (a) => a.key === capabilityKey && a.negated,
  );
  return stmt ? stmt.keys : null;
}

function policyAssignments(): PolicyAssignment[] {
  const body = executableSql();
  const jsonSet =
    /JSON_SET\(\s*`config`\s*,\s*'\$\."tools"\."([^"]+)"'\s*,\s*'([^']+)'\s*\)/;
  const out: PolicyAssignment[] = [];
  for (const stmt of body.split(';')) {
    if (!stmt.includes('JSON_SET')) continue;
    const set = new RegExp(jsonSet.source).exec(stmt);
    if (!set) continue;
    const policyId = /`id`\s*=\s*'([^']+)'/.exec(stmt);
    if (!policyId) continue;
    out.push({ tool: set[1], value: set[2], policyId: policyId[1] });
  }
  return out;
}

describe('记忆整理能力点存量回填迁移 20261009020000', () => {
  describe('① 常量一致性（src 侧权威）', () => {
    it('两个工具名 ∈ VTEAM_MCP_TOOL_NAMES，且各恰属一个记忆整理能力点', () => {
      for (const tool of TOOL_KEYS) {
        expect(VTEAM_MCP_TOOL_NAMES).toContain(tool);
      }
      expect(capabilityKeyForTool(TOOL_KEYS[0])).toBe(CAPABILITY_KEYS[0]);
      expect(capabilityKeyForTool(TOOL_KEYS[1])).toBe(CAPABILITY_KEYS[1]);
      for (const key of CAPABILITY_KEYS) {
        expect(isPlatformCapabilityKey(key)).toBe(true);
      }
      // 两个能力点都是单工具点（不覆盖多工具），故 key↔tool 是双向一一映射。
      for (const key of CAPABILITY_KEYS) {
        const capability = PLATFORM_CAPABILITIES.find((c) => c.key === key);
        expect(capability?.tools).toHaveLength(1);
      }
    });

    it('两个能力点 defaultDeny=false（出厂默认放行，实际生效面由岗位矩阵收窄）', () => {
      for (const key of CAPABILITY_KEYS) {
        const capability = PLATFORM_CAPABILITIES.find((c) => c.key === key);
        expect(capability?.defaultDeny).toBe(false);
      }
    });

    it('ROLE_BOUNDARIES：仅 PM 的 toolAllows 含两个工具，其余 6 岗不含', () => {
      const pmAllows = ROLE_BOUNDARIES[
        'vteam-project_manager' as VteamAgentName
      ].toolAllows as Record<string, string>;
      for (const tool of TOOL_KEYS) {
        expect(pmAllows[tool]).toBe('allow');
      }
      for (const role of BUILTIN_AGENT_ROLES) {
        if (role.key === PM_KEY) continue;
        const allows = ROLE_BOUNDARIES[`vteam-${role.key}` as VteamAgentName]
          .toolAllows as Record<string, string>;
        for (const tool of TOOL_KEYS) {
          expect(allows).not.toHaveProperty(tool);
        }
      }
    });

    it('出厂岗位矩阵：PM 两键为 true，其余 6 内置岗与 3 外部岗均为 false', () => {
      expect(BUILTIN_ROLE_CAPABILITY_MAPS[PM_KEY]).toMatchObject({
        [CAPABILITY_KEYS[0]]: true,
        [CAPABILITY_KEYS[1]]: true,
      });
      for (const key of NON_PM_BUILTIN_KEYS) {
        expect(BUILTIN_ROLE_CAPABILITY_MAPS[key]).toMatchObject({
          [CAPABILITY_KEYS[0]]: false,
          [CAPABILITY_KEYS[1]]: false,
        });
      }
      for (const key of EXTERNAL_AGENT_ROLE_KEYS) {
        expect(EXTERNAL_AGENT_ROLE_CAPABILITIES).toMatchObject({
          [CAPABILITY_KEYS[0]]: false,
          [CAPABILITY_KEYS[1]]: false,
        });
        expect(key).toBeTruthy();
      }
    });
  });

  describe('② execution_policies.config.tools（层② guard allowlist）', () => {
    it('两个工具键都写 ep_project_manager 且值为 allow', () => {
      const parsed = policyAssignments();
      for (const tool of TOOL_KEYS) {
        const hit = parsed.filter((p) => p.tool === tool);
        expect(hit).toHaveLength(1);
        expect(hit[0].policyId).toBe('ep_project_manager');
        expect(hit[0].value).toBe('allow');
      }
    });

    it('只写 PM 一个内置策略行：其余 6 内置策略行缺键即等价于 factory 意图的 deny', () => {
      // resolveGuardTools 是「整体胜出、绝不逐键合并」语义 ⇒ 该层缺键 = 不在 allowlist。
      // 出厂 toolAllows 不含这两个工具 ⇒ 不写才是与 fresh install 落库值一致的取值；
      // 写显式 'deny' 反而与 factory 分裂。
      const ids = new Set(policyAssignments().map((p) => p.policyId));
      expect([...ids]).toEqual(['ep_project_manager']);
    });

    it('不触碰运营者数据（type="template" 守卫），且防误建 tools 对象', () => {
      const statements = executableSql()
        .split(';')
        .map((s) => s.trim())
        .filter((s) => /^UPDATE\s+`execution_policies`/.test(s));
      expect(statements).toHaveLength(2);
      for (const stmt of statements) {
        expect(stmt).toContain("`type` = 'template'");
        // 硬条件：既有记忆工具在场 ⇒ 这是一个真实的出厂形状 tools 矩阵。否则 JSON_SET 会
        // 新建只含 2 项的 tools 对象，而「整体胜出」语义会让它顶掉整份常量 allowlist。
        expect(stmt).toContain(
          'JSON_CONTAINS_PATH(`config`, \'one\', \'$."tools"."vteam_memory_update"\') = 1',
        );
      }
    });
  });

  describe('③ agent_roles.capabilities 逐键赋值 = 出厂矩阵', () => {
    it('每条语句都写且仅写一个记忆整理能力点键', () => {
      const parsed = roleAssignments();
      expect(parsed).toHaveLength(8);
      for (const a of parsed) {
        expect(CAPABILITY_KEYS).toContain(
          a.key as (typeof CAPABILITY_KEYS)[number],
        );
      }
      // 每键 4 条：PM=true / 其余 6 岗=false / 外部 3 岗=false / NOT IN 其余行=true。
      for (const key of CAPABILITY_KEYS) {
        expect(parsed.filter((a) => a.key === key)).toHaveLength(4);
      }
    });

    for (const key of CAPABILITY_KEYS) {
      it(`${key}：PM=true、其余 6 内置岗=false、外部 3 岗=false，逐岗与出厂矩阵一致`, () => {
        const written = writtenFor(key);
        expect(written).toEqual({
          [PM_KEY]: true,
          ...Object.fromEntries(NON_PM_BUILTIN_KEYS.map((k) => [k, false])),
          ...Object.fromEntries(
            EXTERNAL_AGENT_ROLE_KEYS.map((k) => [k, false]),
          ),
        });
        // 与 src 权威常量逐格比对（SQL↔TS 防漂移，不靠上面的硬编码名单自证）。
        for (const roleKey of BUILTIN_KEYS) {
          expect(written[roleKey]).toBe(
            BUILTIN_ROLE_CAPABILITY_MAPS[roleKey][key],
          );
        }
      });

      it(`${key}：NOT IN 语句覆盖其余行，取值为出厂默认（defaultDeny:false ⇒ true）`, () => {
        const exclusion = restExclusion(key);
        expect(exclusion).not.toBeNull();
        // 排除名单必须恰好是 7 内置 + 3 外部，多一个少一个都会让某类行漏写或被写两次。
        expect([...(exclusion as string[])].sort()).toEqual(
          [...BUILTIN_KEYS, ...EXTERNAL_AGENT_ROLE_KEYS].sort(),
        );
        expect(restExclusion(key)).toHaveLength(
          BUILTIN_KEYS.length + EXTERNAL_AGENT_ROLE_KEYS.length,
        );
        const restStmt = roleAssignments().find(
          (a) => a.key === key && a.negated,
        );
        // 其余行写 true 而非 false：default-allow 下它们当前本就被放行，写 true 只是把
        // 隐式放行显式化（不放大授权），与 20260929000000 对该组写 read=true 同策。
        expect(restStmt?.value).toBe(true);
      });
    }
  });

  describe('④ 只增不改 / 幂等（重跑 migrate deploy 必须安全 no-op）', () => {
    it('每条 JSON_SET 都以「该键缺失」为守卫，不覆盖运营者已显式的值', () => {
      for (const stmt of executableSql().split(';')) {
        if (!stmt.includes('JSON_SET')) continue;
        expect(stmt).toContain('JSON_CONTAINS_PATH');
        expect(stmt).toMatch(/JSON_CONTAINS_PATH\([^)]*'one'/);
        expect(stmt).toMatch(/=\s*0\s*$/);
      }
    });

    it('agent_roles 语句同时要求 capabilities 非 NULL（NULL 行交 seed 出厂矩阵补齐）', () => {
      for (const stmt of executableSql().split(';')) {
        if (!stmt.includes('JSON_SET') || !stmt.includes('`agent_roles`'))
          continue;
        expect(stmt).toContain('`capabilities` IS NOT NULL');
      }
    });

    it('逐键拆分是承重的：没有一条语句用「多路径守卫」一次判两个键', () => {
      // `JSON_CONTAINS_PATH(doc,'one',a,b)=0` 只在两键**全部**缺失时为真——某行已有其中
      // 一键（如运营者显式 deny 过 archive），整行会被跳过、另一键永久留空（default-allow
      // 下即永久放行 / 层② 永久不在 allowlist）。拆开后每键独立幂等。
      // 判据是**每个守卫只带一个路径**：`'one', 'path'` 之后不得再跟第二个路径参数。
      for (const stmt of executableSql().split(';')) {
        if (!stmt.includes('JSON_SET')) continue;
        expect([
          ...stmt.matchAll(/JSON_CONTAINS_PATH\([^)]*'one'\s*,\s*'[^']*'\s*,/g),
        ]).toEqual([]);
      }
    });

    it('无任何可能覆盖运营者编辑的写法（无 JSON_REPLACE / 无整列赋值）', () => {
      const body = executableSql();
      expect(body).not.toContain('JSON_REPLACE');
      expect(body).not.toMatch(/SET\s+`config`\s*=\s*`config`/);
      expect(body).not.toMatch(/SET\s+`capabilities`\s*=\s*`capabilities`/);
      expect(body).not.toMatch(/\bTRUNCATE\b/i);
      expect(body).not.toMatch(/\bDELETE\b/i);
    });
  });

  describe('⑤ 打戳与 DDL 边界', () => {
    it('capabilities_configured_at 只在 NULL 时补，不覆盖运营者已有戳', () => {
      const body = executableSql();
      expect(body).toMatch(
        /UPDATE\s+`agent_roles`\s+SET\s+`capabilities_configured_at`\s*=\s*CURRENT_TIMESTAMP\(3\)/i,
      );
      expect(body).toMatch(
        /`capabilities` IS NOT NULL[\s\S]{0,80}`capabilities_configured_at` IS NULL/i,
      );
    });

    it('本迁移无任何 DDL', () => {
      const body = executableSql();
      expect(body).not.toMatch(/\bALTER\b/i);
      expect(body).not.toMatch(/\bCREATE\b/i);
      expect(body).not.toMatch(/\bDROP\b/i);
    });

    it('DDL 守卫：SET 到的列，建表时已存在或由链上更早的迁移 ADD COLUMN 补上', () => {
      const baseline = fs.readFileSync(BASELINE_MIGRATION, 'utf8');
      const baselineColumnsOf = (table: string): Set<string> => {
        const m = new RegExp(
          `CREATE TABLE \`${table}\` \\(([\\s\\S]*?)\\n\\) ENGINE=`,
        ).exec(baseline);
        expect(m).not.toBeNull();
        return new Set(
          [...(m as RegExpExecArray)[1].matchAll(/^\s*`(\w+)`/gm)].map(
            (x) => x[1],
          ),
        );
      };
      const addedEarlier = new Set(
        [
          ...fs
            .readFileSync(COLUMN_PROVIDING_MIGRATION, 'utf8')
            .matchAll(/ADD COLUMN\s+`(\w+)`/g),
        ].map((m) => m[1]),
      );

      // 每条 UPDATE 的目标表与被 SET 的列，逐句校验（不能只看并集，否则「A 表的列写到
      // B 表」这类错配会被并集掩盖）。
      const statements = executableSql()
        .split(';')
        .map((s) => s.trim())
        .filter((s) => /^UPDATE\b/.test(s));
      expect(statements.length).toBeGreaterThan(0);
      const uncovered: string[] = [];
      for (const stmt of statements) {
        const table = /UPDATE\s+`(\w+)`/.exec(stmt)?.[1] as string;
        // SET 子句既可能是 `col` = JSON_SET(...)（数据回填），也可能是
        // `col` = CURRENT_TIMESTAMP(3)（打戳）——两种形状都要纳入列覆盖校验。
        const columns = [
          ...stmt.matchAll(
            /UPDATE\s+`\w+`\s+SET\s+`(\w+)`\s*=\s*(?:JSON_SET|CURRENT_TIMESTAMP)/g,
          ),
        ].map((m) => m[1] as string);
        expect(columns.length).toBeGreaterThan(0);
        const known = baselineColumnsOf(table);
        for (const column of columns) {
          if (!known.has(column) && !addedEarlier.has(column)) {
            uncovered.push(`${table}.${column}`);
          }
        }
      }
      expect(uncovered).toEqual([]);
      // 显式钉住本迁移依赖的那一列确实由前序迁移建立（否则「链上更早」是空话）。
      expect(addedEarlier.has('capabilities_configured_at')).toBe(true);
      // 两个被写的既有列必须**建表时就有**（不得依赖任何 ADD COLUMN）。
      expect(baselineColumnsOf('agent_roles').has('capabilities')).toBe(true);
      expect(baselineColumnsOf('execution_policies').has('config')).toBe(true);
    });

    it('schema.prisma 的 AgentRole 声明了 capabilities 与 capabilitiesConfiguredAt', () => {
      const schema = fs.readFileSync(SCHEMA, 'utf8');
      const model = /^model AgentRole \{([\s\S]*?)^\}/m.exec(schema);
      expect(model).not.toBeNull();
      expect(model?.[1]).toMatch(
        /capabilities\s+Json\?\s+@map\("capabilities"\)/,
      );
      expect(model?.[1]).toMatch(
        /capabilitiesConfiguredAt\s+DateTime\?\s+@map\("capabilities_configured_at"\)/,
      );
    });
  });

  describe('⑥ 无条件覆盖禁令（回归守卫）', () => {
    it('迁移不改写 execution_policies.config 的其他字段（permission/correction 原样保留）', () => {
      const body = executableSql();
      // 只允许对 `$.tools.<tool>` 这一条路径做 JSON_SET；任何对 `$.permission` /
      // `$.correction` / 整列的写入都会击穿「页面可编辑的运行时来源」这条产品约束。
      const setPaths = [
        ...body.matchAll(/JSON_SET\(\s*`config`\s*,\s*'([^']*)'/g),
      ].map((m) => m[1]);
      expect(setPaths.length).toBeGreaterThan(0);
      for (const p of setPaths) {
        expect(p.startsWith('$."tools"."vteam_memory_')).toBe(true);
      }
      expect(body).not.toContain('"$.permission');
      expect(body).not.toContain('"$.correction');
    });

    it('迁移不改 seed.ts 的 ExecutionPolicy update:{} 语义（升级不回滚用户编辑）', () => {
      const seed = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'prisma', 'seed.ts'),
        'utf8',
      );
      const upsert =
        /await prisma\.executionPolicy\.upsert\(\{[\s\S]*?\n {4}\}\);/.exec(
          seed,
        );
      expect(upsert).not.toBeNull();
      // 「config 是页面可编辑的运行时来源」这条产品约束不得被本迁移悄悄废掉。
      expect(upsert?.[0]).toContain('update: {}');
      // 出厂 config 的 tools 来自 ROLE_BOUNDARIES 镜像拷贝，PM 镜像必须携带两个新键
      // （fresh install 路径不得被本迁移带偏）。
      const pmBoundary =
        /'vteam-project_manager': defineBoundary\(\{[\s\S]*?\n {2}\}\),/.exec(
          seed,
        )?.[0];
      expect(pmBoundary).toBeDefined();
      for (const tool of TOOL_KEYS) {
        expect(pmBoundary).toContain(`${tool}: 'allow'`);
      }
      // 其余 6 岗镜像不得含这两键（与迁移「不写」的处置一致）。
      for (const role of BUILTIN_AGENT_ROLES) {
        if (role.key === PM_KEY) continue;
        const boundary = new RegExp(
          `'vteam-${role.key}': defineBoundary\\(\\{[\\s\\S]*?\\n {2}\\}\\),`,
        ).exec(seed)?.[0];
        expect(boundary).toBeDefined();
        for (const tool of TOOL_KEYS) {
          expect(boundary).not.toContain(tool);
        }
      }
    });
  });
});
