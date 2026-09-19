import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_AGENT_ROLE_BY_KEY,
  FALLBACK_AGENT_ROLE,
  deriveCustomAgentRoleId,
} from '../common/constants/agent-role.constants';

/**
 * agent-role-entity todo 1 迁移契约测试。
 *
 * jest 基座不连真库（PrismaClient 全量 mock，test/setup-env.js 只设 sqlite URL），
 * 真库回填证明在 `.omo/evidence/agent-role-entity/task-1-migration.txt`（live migrate deploy）。
 * 本 spec 锁定两部分：
 *   1. migration.sql / schema.prisma 的**结构契约**（表名、FK onDelete、列、7 内置 INSERT）；
 *   2. 回填三态规则的**行为契约**——用生产派生函数（deriveCustomAgentRoleId）重放
 *      case (i)/(ii)/(iii)，断言每个成员最终落到非空且正确的 roleId。
 */
const MIGRATION_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260919000007_add_agent_roles_and_member_role_id',
  'migration.sql',
);
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

const BUILTIN_KEYS = BUILTIN_AGENT_ROLES.map((r) => r.key);

/**
 * 回填规则（与 migration.sql 4b/4c 及 constants 的派生规则一致）：
 * resolve(role) → 成员应得的 role_id；null 输入 = case iii。
 */
function resolveBackfillRoleId(agentRole: string | null): string {
  if (agentRole === null) return FALLBACK_AGENT_ROLE.id;
  const builtin = BUILTIN_AGENT_ROLE_BY_KEY[agentRole];
  if (builtin) return builtin.id;
  return deriveCustomAgentRoleId(agentRole);
}

describe('agent_roles 迁移 + 三态回填契约', () => {
  const sql = fs.readFileSync(MIGRATION_DIR, 'utf8');

  describe('结构契约（migration.sql + schema.prisma）', () => {
    it('建表名为 agent_roles，绝不使用 roles / Role（RBAC 保留字）', () => {
      expect(sql).toContain('CREATE TABLE `agent_roles`');
      expect(sql).not.toMatch(/CREATE TABLE `roles`/);
    });

    it('team_members.role_id 列 + 索引 + FK，且 FK 为 ON DELETE RESTRICT', () => {
      expect(sql).toContain('ALTER TABLE `team_members` ADD COLUMN `role_id` VARCHAR(191) NULL');
      expect(sql).toContain('CREATE INDEX `idx_team_members_role` ON `team_members`(`role_id`)');
      expect(sql).toMatch(
        /team_members_role_id_fkey` FOREIGN KEY \(`role_id`\) REFERENCES `agent_roles`\(`id`\) ON DELETE RESTRICT/,
      );
    });

    it('default_agent_id FK 为 ON DELETE SET NULL（review fix m8）', () => {
      expect(sql).toMatch(
        /agent_roles_default_agent_id_fkey` FOREIGN KEY \(`default_agent_id`\) REFERENCES `agents`\(`id`\) ON DELETE SET NULL/,
      );
    });

    it('INSERT 7 个内置行（ar_<role>），key/name/sortOrder 与常量一致，role_prompt 暂空', () => {
      // 内置行字段以空格对齐，故逐字段断言 + 逐行正则（而非整段连续子串）。
      for (const role of BUILTIN_AGENT_ROLES) {
        const row = sql
          .split('\n')
          .find((line) => line.includes(`'${role.id}'`));
        expect(row).toBeDefined();
        expect(row).toContain(`'${role.key}'`);
        expect(row).toContain(`'${role.name}'`);
        expect(row).toContain("'builtin'");
        expect(row).toMatch(new RegExp(`NULL, ${role.sortOrder}, NOW\\(3\\), NOW\\(3\\)\\)`));
      }
      expect(sql).toMatch(/\(SELECT `id` FROM `agents` WHERE `id` = 'a_product'\)/);
    });

    it('INSERT 兜底行 general / 通用（case iii 目标）', () => {
      expect(sql).toContain("('ar_general', 'general', '通用'");
    });

    it('case (ii) 的派生表达式与常量派生规则一致（MD5 前缀 + custom_ stem）', () => {
      expect(sql).toMatch(/CONCAT\('ar_c_', LEFT\(MD5\(`d`\.`role`\), 16\)\)/);
      expect(sql).toMatch(/CONCAT\(\s*'custom_'/);
      expect(sql).toMatch(/LEFT\(MD5\(`d`\.`role`\), 8\)/);
    });

    it('三态 UPDATE 齐备（builtin / 非空非内置 / NULL）', () => {
      // (i) 内置
      expect(sql).toMatch(/SET `tm`\.`role_id` = CONCAT\('ar_', `a`\.`role`\)/);
      // (ii) 派生
      expect(sql).toMatch(/CONCAT\('ar_c_', LEFT\(MD5\(`a`\.`role`\), 16\)\)/);
      // (iii) 兜底
      expect(sql).toMatch(/SET `tm`\.`role_id` = 'ar_general'/);
    });

    it('迁移声明回填不可逆 + 记录精确恢复命令（pre-migration dump）', () => {
      expect(sql).toContain('回填**不可逆**');
      expect(sql).toMatch(/mysqldump -uroot -p"\$MYSQL_ROOT_PASSWORD"/);
      expect(sql).toMatch(/mysql -uroot -p"\$MYSQL_ROOT_PASSWORD" aiagents/);
      expect(sql).toContain('pre-migration-dump.sql');
    });

    it('schema：model AgentRole @@map("agent_roles")，TeamMember.roleId 带 FK 语义', () => {
      const schema = fs.readFileSync(SCHEMA, 'utf8');
      expect(schema).toMatch(/model AgentRole \{[\s\S]*?@@map\("agent_roles"\)/);
      // RBAC Role 仍恰有一个（本轮不得引入第二个 model Role / @@map("roles")）。
      // 用行首锚定排除注释里引用的 `@@map("roles")` 说明文字。
      expect((schema.match(/^model Role /gm) ?? []).length).toBe(1);
      expect((schema.match(/^\s*@@map\("roles"\)\s*$/gm) ?? []).length).toBe(1);
      expect((schema.match(/^\s*@@map\("agent_roles"\)\s*$/gm) ?? []).length).toBe(1);
      // TeamMember.roleId + onDelete: Restrict 关系行。
      expect(schema).toMatch(/model TeamMember \{[\s\S]*?roleId\s+String\?\s+@map\("role_id"\)/);
      expect(schema).toMatch(/role\s+AgentRole\?\s+@relation\(fields: \[roleId\][\s\S]*?onDelete: Restrict/);
      // defaultAgentId 关系 onDelete: SetNull。
      expect(schema).toMatch(/defaultAgent\s+Agent\?\s+@relation\("AgentRoleDefaultAgent"[\s\S]*?onDelete: SetNull/);
      // Agent.role 未被 drop/rename（Agent 模型内仍是 `role  String?`）。
      const agentModel = schema.match(/^model Agent \{[\s\S]*?^\}/m)?.[0] ?? '';
      expect(agentModel).toMatch(/^\s*role\s+String\?\s*$/m);
      expect(agentModel).toContain('defaultForRoles');
    });
  });

  describe('三态回填行为契约（生产派生函数重放）', () => {
    it('case (i)：内置 role key 的成员 → 对应内置 AgentRole', () => {
      for (const role of BUILTIN_AGENT_ROLES) {
        expect(resolveBackfillRoleId(role.key)).toBe(role.id);
      }
      expect(resolveBackfillRoleId('product')).toBe('ar_product');
      expect(resolveBackfillRoleId('librarian')).toBe('ar_librarian');
    });

    it('case (ii)：非空非内置值（specs 的 analyst）→ type=custom 派生的 AgentRole', () => {
      const id = resolveBackfillRoleId('analyst');
      expect(id).toBe(deriveCustomAgentRoleId('analyst'));
      expect(id).toMatch(/^ar_c_[0-9a-f]{16}$/);
      expect(id).not.toBe('ar_general');
      // 同值恒等：两个成员共用同一行。
      expect(resolveBackfillRoleId('analyst')).toBe(id);
    });

    it('case (iii)：Agent.role 为 NULL 的成员 → 文档化兜底角色 general', () => {
      expect(resolveBackfillRoleId(null)).toBe('ar_general');
    });

    it('三态全非空：任意 role（含 NULL）解析结果均非空，0-null 可达成', () => {
      const members: (string | null)[] = ['product', 'tester', 'analyst', 'myagent', null, 'plan'];
      const ids = members.map(resolveBackfillRoleId);
      expect(ids).toHaveLength(members.length);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    });

    it('every builtin has a defaultAgentId（7 行 defaultAgentId 已设）', () => {
      expect(BUILTIN_AGENT_ROLES.filter((r) => !r.defaultAgentId)).toHaveLength(0);
      expect(BUILTIN_KEYS).toHaveLength(7);
    });
  });
});
