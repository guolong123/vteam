import * as fs from 'fs';
import * as path from 'path';
import { AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH } from '../common/constants/agent-role.constants';

/**
 * todo 2 迁移契约（`20260919000011_agent_role_external_agent`）。
 *
 * 本迁移是**加法-only**（新增可空列），与 `20260919000010_drop_agents_role` 的单向
 * contract 不同：可逆，回滚即 DROP COLUMN，命令写在头注释里。
 *
 * jest 基座不连真库（populated-DB 的 `migrate deploy` 证明记录在本计划证据文件）。
 * 本 spec 锁定结构契约：
 *   1. 头注释声明不变式（至多一个槽位非空）、弱校验语义、精确回滚命令；
 *   2. 只有一条 `ALTER TABLE agent_roles ADD COLUMN ... NULL`，无 UPDATE/INSERT/DELETE
 *      （无数据迁移，7 个 builtin 行不被触碰）；
 *   3. schema.prisma 的 model AgentRole 含该列且可空，列宽与 DTO 上限一致。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260919000011_agent_role_external_agent',
  'migration.sql',
);
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');

describe('agent_roles 外部 Agent 槽位迁移契约（todo 2）', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  /** 去注释后的可执行 SQL（头注释含 ALTER/DROP 字样，语句计数须只看代码行）。 */
  const ddl = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .trim();

  it('头注释声明不变式 + 弱校验语义 + 精确回滚命令', () => {
    for (const marker of [
      '至多一个',
      'AGENT_ROLE_DEFAULT_SLOT_CONFLICT',
      '弱校验',
      'warnIfOpencodeAgentUnknown',
      '回滚',
      'DROP COLUMN',
    ]) {
      expect(sql).toContain(marker);
    }
    expect(sql).toMatch(
      /ALTER TABLE `agent_roles` DROP COLUMN `default_opencode_agent_name`/,
    );
    expect(sql).toMatch(/mysql -uroot -p"\$MYSQL_ROOT_PASSWORD" aiagents/);
  });

  it('加法-only：恰一条 ADD COLUMN、可空、无数据迁移语句', () => {
    const statements = ddl
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^ALTER TABLE `agent_roles`\s+ADD COLUMN `default_opencode_agent_name` VARCHAR\(\d+\) NULL$/,
    );
    expect(ddl).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\b/);
  });

  it('列宽与 DTO 上限一致（单一事实来源：AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH）', () => {
    expect(ddl).toContain(
      `VARCHAR(${AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH})`,
    );
  });

  it('schema：model AgentRole 含 defaultOpencodeAgentName，可空且映射列名一致', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const agentRoleModel =
      schema.match(/^model AgentRole \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(agentRoleModel).toContain('defaultOpencodeAgentName String?');
    expect(agentRoleModel).toContain(
      '@map("default_opencode_agent_name")',
    );
  });

  it('schema：不变式声明在 model AgentRole 注释中（互斥 + 400 code）', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const agentRoleModel =
      schema.match(/^model AgentRole \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(agentRoleModel).toContain('互斥');
    expect(agentRoleModel).toContain('AGENT_ROLE_DEFAULT_SLOT_CONFLICT');
  });
});
