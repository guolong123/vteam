import * as fs from 'fs';
import * as path from 'path';
import {
  capabilityKeyForTool,
  PLATFORM_CAPABILITIES,
} from '../common/constants/platform-capability.constants';
import { VTEAM_MCP_TOOL_NAMES } from '../common/constants/agent.constants';

/**
 * Contract for migration `20261014010000_memory_search_to_list`
 * （MCP 工具改名 vteam_memory_search → vteam_memory_list，纯注册面）。
 *
 * 本 spec 的职责（全部**文本解析**，从不执行 SQL —— 结构上验证不了运行时，故只锁形状）：
 * 1. **常量一致性（SQL↔TS 防漂移）**：新工具名 ∈ `VTEAM_MCP_TOOL_NAMES`、恰属
 *    `memory.search` 能力点、旧工具名已不在目录；能力点键 unchanged；
 * 2. **tools rename**：`tools.name` 与 `tools.action` 各一条 UPDATE，旧值 → 新值，
 *    且只 SET 这两列（不夹带 description/enabled 等其他列）；
 * 3. **JSON 键 rename**：`execution_policies.config.tools` 的键
 *    `vteam_memory_search` → `vteam_memory_list`，值经 `JSON_EXTRACT` 原样搬移
 *    （保全运营者显式的 'allow'/'ask'/'deny'），先 JSON_SET 新键、后 JSON_REMOVE 旧键；
 * 4. **只-if-exists 守卫 / 幂等**：每条语句都以「旧值/旧键命中」为守卫——fresh install
 *    （seed 已写新名）与重跑均 0 行 no-op；JSON_SET 另带「新键不存在」守卫，迁移在
 *    两步之间中断后重跑仍收敛；**绝不会**凭空创建 tools 对象；
 * 5. **运营者数据边界**：只碰 `type='template'` 行；`agent_roles.capabilities`
 *    一个字符都不碰（它的键是能力点键 memory.search，不是工具名）；
 * 6. **无 DDL**：SET 到的列建表时即存在（squashed_baseline 已 CREATE），
 *    不 ALTER / ADD COLUMN / 改 schema.prisma 任何模型。
 */

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261014010000_memory_search_to_list',
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

/** 改名前的工具真实暴露名 / 权限点 action。 */
const OLD_TOOL = 'vteam_memory_search';
const OLD_ACTION = 'memory_search';
/** 改名后的工具真实暴露名 / 权限点 action。 */
const NEW_TOOL = 'vteam_memory_list';
const NEW_ACTION = 'memory_list';
/** 不受改名影响的能力点键（岗位矩阵的真值来源）。 */
const CAPABILITY_KEY = 'memory.search';

const sql = fs.readFileSync(MIGRATION, 'utf8');

/** 剥掉 `--` 行后的可执行 SQL（契约判据只跑在可执行语句上）。 */
function executableSql(): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** 可执行 SQL 按 `;` 拆出的语句（trim 后去空）。 */
function statements(): string[] {
  return executableSql()
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface ToolsRowUpdate {
  column: string;
  newValue: string;
  whereColumn: string;
  whereValue: string;
}

/** 解析 `tools` 表的单列 rename 语句（SET 恰一列 = 字面量，WHERE 恰一列 = 字面量）。 */
function toolsUpdates(): ToolsRowUpdate[] {
  const re =
    /UPDATE\s+`tools`\s+SET\s+`(\w+)`\s*=\s*'([^']+)'\s+WHERE\s+`(\w+)`\s*=\s*'([^']+)'/;
  const out: ToolsRowUpdate[] = [];
  for (const stmt of statements()) {
    if (!/^UPDATE\s+`tools`/.test(stmt)) continue;
    const m = re.exec(stmt);
    expect(m).not.toBeNull();
    out.push({
      column: (m as RegExpExecArray)[1],
      newValue: (m as RegExpExecArray)[2],
      whereColumn: (m as RegExpExecArray)[3],
      whereValue: (m as RegExpExecArray)[4],
    });
  }
  return out;
}

describe('MCP 工具改名迁移 20261014010000', () => {
  describe('① 常量一致性（src 侧权威，SQL↔TS 防漂移）', () => {
    it('新工具名 ∈ VTEAM_MCP_TOOL_NAMES，旧名已出清单', () => {
      expect(VTEAM_MCP_TOOL_NAMES).toContain(NEW_TOOL);
      expect(VTEAM_MCP_TOOL_NAMES).not.toContain(OLD_TOOL);
    });

    it('新工具名恰属 memory.search 能力点，键未随工具改名漂移', () => {
      expect(capabilityKeyForTool(NEW_TOOL)).toBe(CAPABILITY_KEY);
      expect(capabilityKeyForTool(OLD_TOOL)).toBeNull();
      const capability = PLATFORM_CAPABILITIES.find(
        (c) => c.key === CAPABILITY_KEY,
      );
      expect(capability?.tools).toEqual([NEW_TOOL]);
    });

    it('迁移文件头记录了「能力点键不动」的契约', () => {
      // 键是业务语义命名而非工具名：岗位矩阵/迁移不得按工具名改写它。
      expect(sql).toContain(CAPABILITY_KEY);
      expect(sql).toMatch(/能力点键[\s\S]*?(不变|原样不动)/);
    });
  });

  describe('② tools 目录 rename（name 与 action）', () => {
    it('恰两条 UPDATE `tools`：name 与 action 各一条，旧值 → 新值', () => {
      const parsed = toolsUpdates();
      expect(parsed).toHaveLength(2);
      const byColumn = new Map(parsed.map((p) => [p.column, p]));
      expect(byColumn.get('name')).toEqual({
        column: 'name',
        newValue: NEW_TOOL,
        whereColumn: 'name',
        whereValue: OLD_TOOL,
      });
      expect(byColumn.get('action')).toEqual({
        column: 'action',
        newValue: NEW_ACTION,
        whereColumn: 'action',
        whereValue: OLD_ACTION,
      });
    });

    it('只 SET name/action 两列（不夹带 description/enabled/mcp_server 等）', () => {
      const columns = toolsUpdates().map((p) => p.column);
      expect([...columns].sort()).toEqual(['action', 'name']);
    });

    it('守卫即幂等：WHERE 只按旧值命中——fresh install（seed 已写新名）与重跑均 0 行', () => {
      for (const stmt of statements()) {
        if (!/^UPDATE\s+`tools`/.test(stmt)) continue;
        // 每个 WHERE 右值恰是旧值（新值行不会被命中 ⇒ 迁移后重跑是 no-op）。
        expect(stmt).toMatch(/WHERE\s+`(name|action)`\s*=\s*'[^']+'/);
        expect(stmt).not.toMatch(/WHERE\s+`(name|action)`\s*=\s*'1'/);
      }
      const parsed = toolsUpdates();
      for (const p of parsed) {
        expect(p.whereValue).toBe(p.column === 'name' ? OLD_TOOL : OLD_ACTION);
        expect(p.newValue).toBe(p.column === 'name' ? NEW_TOOL : NEW_ACTION);
        // 写入值 ≠ 守卫值（否则是自赋值空转）。
        expect(p.newValue).not.toBe(p.whereValue);
      }
    });
  });

  describe('③ execution_policies.config.tools JSON 键 rename', () => {
    it('先 JSON_SET 新键（值 = 旧键 JSON 标量原样搬移），后 JSON_REMOVE 旧键', () => {
      const body = executableSql();
      const setStmt =
        /JSON_SET\(\s*`config`\s*,\s*'\$\."tools"\."([^"]+)"'\s*,\s*JSON_EXTRACT\(\s*`config`\s*,\s*'\$\."tools"\."([^"]+)"'\s*\)/.exec(
          body,
        );
      expect(setStmt).not.toBeNull();
      expect((setStmt as RegExpExecArray)[1]).toBe(NEW_TOOL);
      // 值保全：第三参数必须是旧键的 JSON_EXTRACT，不是字面量——
      // 运营者显式的 'allow'/'ask'/'deny' 逐字节保留。
      expect((setStmt as RegExpExecArray)[2]).toBe(OLD_TOOL);
      expect(body).not.toMatch(
        /JSON_SET\(\s*`config`\s*,\s*'\$\."tools"\."[^"]+"'\s*,\s*'(allow|ask|deny)'/,
      );

      const removeStmt =
        /JSON_REMOVE\(\s*`config`\s*,\s*'\$\."tools"\."([^"]+)"'/.exec(body);
      expect(removeStmt).not.toBeNull();
      expect((removeStmt as RegExpExecArray)[1]).toBe(OLD_TOOL);
    });

    it('两条语句都只碰 `$.tools.<tool>` 路径，不碰 permission/correction', () => {
      const setPaths = [
        ...executableSql().matchAll(/JSON_SET\(\s*`config`\s*,\s*'([^']*)'/g),
      ].map((m) => m[1]);
      expect(setPaths).toHaveLength(1);
      expect(setPaths[0]).toBe(`$."tools"."${NEW_TOOL}"`);
      const removePaths = [
        ...executableSql().matchAll(
          /JSON_REMOVE\(\s*`config`\s*,\s*'([^']*)'/g,
        ),
      ].map((m) => m[1]);
      expect(removePaths).toHaveLength(1);
      expect(removePaths[0]).toBe(`$."tools"."${OLD_TOOL}"`);
      expect(executableSql()).not.toContain('"$.permission');
      expect(executableSql()).not.toContain('"$.correction');
    });

    it('两条语句都以旧键在场为守卫 ⇒ 无 tools 对象/旧键的行零写入（绝不凭空建键）', () => {
      const policyStmts = statements().filter((s) =>
        /^UPDATE\s+`execution_policies`/.test(s),
      );
      expect(policyStmts).toHaveLength(2);
      const oldKeyGuard = `JSON_CONTAINS_PATH(\`config\`, 'one', '$."tools"."${OLD_TOOL}"') = 1`;
      for (const stmt of policyStmts) {
        expect(stmt).toContain("`type` = 'template'");
        expect(stmt).toContain(oldKeyGuard);
      }
    });

    it('JSON_SET 另带「新键不存在」守卫：两步之间中断后重跑仍收敛', () => {
      const setStmt = statements().find(
        (s) =>
          /^UPDATE\s+`execution_policies`/.test(s) && s.includes('JSON_SET'),
      );
      expect(setStmt).toBeDefined();
      expect(setStmt).toContain(
        `JSON_CONTAINS_PATH(\`config\`, 'one', '$."tools"."${NEW_TOOL}"') = 0`,
      );
      // 收敛性：第 1 步写新键后重跑，JSON_SET 被 =0 守卫挡住（不覆盖），
      // JSON_REMOVE 收掉旧键 ⇒ 终态恒定「只有新键」。
      const removeStmt = statements().find(
        (s) =>
          /^UPDATE\s+`execution_policies`/.test(s) && s.includes('JSON_REMOVE'),
      );
      expect(removeStmt).toBeDefined();
    });

    it("只碰 type='template'（出厂策略）；custom 运营者行一个键都不动", () => {
      const policyStmts = statements().filter((s) =>
        /^UPDATE\s+`execution_policies`/.test(s),
      );
      for (const stmt of policyStmts) {
        expect(stmt).toContain("`type` = 'template'");
        // 不得退化为「全表按旧键 rename」（custom 行同键会被顺带改掉）。
        expect(stmt).not.toMatch(
          /^UPDATE\s+`execution_policies`\s+SET[\s\S]*WHERE\s+JSON_CONTAINS_PATH/,
        );
      }
    });
  });

  describe('④ agent_roles 零触碰（能力点键不是工具名）', () => {
    it('可执行 SQL 不含任何 `agent_roles` 语句', () => {
      expect(executableSql()).not.toMatch(/`agent_roles`/);
    });

    it('不出现对 capabilities 列的任何写入形状', () => {
      expect(executableSql()).not.toMatch(/`capabilities`/);
    });
  });

  describe('⑤ 无 DDL / 列存在性守卫', () => {
    it('本迁移无任何 DDL（不 ALTER / CREATE / DROP / ADD COLUMN）', () => {
      const body = executableSql();
      expect(body).not.toMatch(/\bALTER\b/i);
      expect(body).not.toMatch(/\bCREATE\b/i);
      expect(body).not.toMatch(/\bDROP\b/i);
      expect(body).not.toMatch(/\bADD COLUMN\b/i);
      expect(body).not.toMatch(/\bDELETE\b/i);
      expect(body).not.toMatch(/\bTRUNCATE\b/i);
    });

    it('DDL 守卫：SET 到的列建表时即存在（squashed_baseline）', () => {
      const baseline = fs.readFileSync(BASELINE_MIGRATION, 'utf8');
      const baselineColumnsOf = (table: string): Set<string> => {
        const m = new RegExp(
          `CREATE TABLE \\\`${table}\\\` \\(([\\s\\S]*?)\\n\\) ENGINE=`,
        ).exec(baseline);
        expect(m).not.toBeNull();
        return new Set(
          [...(m as RegExpExecArray)[1].matchAll(/^\s*`(\w+)`/gm)].map(
            (x) => x[1],
          ),
        );
      };
      const toolsColumns = baselineColumnsOf('tools');
      const policyColumns = baselineColumnsOf('execution_policies');
      expect(toolsColumns.has('name')).toBe(true);
      expect(toolsColumns.has('action')).toBe(true);
      expect(policyColumns.has('config')).toBe(true);
      expect(policyColumns.has('type')).toBe(true);

      // 逐句核对 UPDATE 目标表与被 SET 列（防「A 表的列写到 B 表」错配）。
      for (const stmt of statements()) {
        if (!/^UPDATE\b/.test(stmt)) continue;
        const table = /UPDATE\s+`(\w+)`/.exec(stmt)?.[1] as string;
        const columns = [
          ...stmt.matchAll(
            /UPDATE\s+`\w+`\s+SET\s+`(\w+)`\s*=\s*(?:JSON_SET|JSON_REMOVE|'[^']+'|CURRENT_TIMESTAMP)/g,
          ),
        ].map((m) => m[1] as string);
        expect(columns.length).toBeGreaterThan(0);
        const known = table === 'tools' ? toolsColumns : policyColumns;
        for (const column of columns) {
          expect(known.has(column)).toBe(true);
        }
      }
    });

    it('schema.prisma 的 Tool / ExecutionPolicy 模型未被本迁移改动的基础声明仍在', () => {
      const schema = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma'),
        'utf8',
      );
      const toolModel = /^model Tool \{([\s\S]*?)^\}/m.exec(schema);
      expect(toolModel).not.toBeNull();
      // name/action 两列声明原样（迁移只改数据，不改模型）。
      expect(toolModel?.[1]).toMatch(/name\s+String/);
      expect(toolModel?.[1]).toMatch(/action\s+String\s+@unique/);
    });
  });

  describe('⑥ seed 出厂路径一致性（fresh install 不复辟旧名）', () => {
    it('seed.ts 的 tools-table 条目已是新 action/新 name，且无旧名残留', () => {
      const seed = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'prisma', 'seed.ts'),
        'utf8',
      );
      expect(seed).toContain(`action: '${NEW_ACTION}'`);
      expect(seed).toContain(`name: '${NEW_TOOL}'`);
      expect(seed).not.toContain(OLD_TOOL);
      expect(seed).not.toContain(OLD_ACTION);
    });
  });
});
