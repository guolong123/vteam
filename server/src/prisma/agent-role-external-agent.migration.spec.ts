import * as fs from 'fs';
import * as path from 'path';
import { EXTERNAL_AGENT_ROLES } from '../common/constants/agent-role.constants';

/**
 * 「外部 agent」功能下线后的 schema 契约（原 `20260919000011_agent_role_external_agent`）。
 *
 * 历史：该迁移曾给 `agent_roles` 加可空列 `default_opencode_agent_name`（VARCHAR(128)），
 * 让岗位直接绑定 opencode 引擎的 agent 名；`team_members` 也有同构的 `opencode_agent_name`。
 * 2026-11-21 功能整体下线（生产库两列非空计数均为 0），迁移
 * `20261121220000_drop_external_agent_columns` 删除两列。
 *
 * 本套把「下线」这件事钉死：schema 不能再出现这两列、删除迁移必须存在且幂等可读、
 * seed 的外部岗位必须仍绑**平台 Agent**（否则这些岗位会因 ROLE_DEFAULT_AGENT_MISSING 不可派发）。
 */

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
);
const SCHEMA = path.resolve(__dirname, '..', '..', 'prisma', 'schema.prisma');
const DROP_MIGRATION = path.join(
  MIGRATIONS_DIR,
  '20261121220000_drop_external_agent_columns',
  'migration.sql',
);

describe('外部 agent 功能下线：schema 与迁移契约', () => {
  it('删除迁移存在，且两列都真的被 DROP（不是只改 schema 不迁移）', () => {
    expect(fs.existsSync(DROP_MIGRATION)).toBe(true);
    const sql = fs.readFileSync(DROP_MIGRATION, 'utf8');
    const executable = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(executable).toMatch(
      /ALTER TABLE `agent_roles` DROP COLUMN `default_opencode_agent_name`/,
    );
    expect(executable).toMatch(
      /ALTER TABLE `team_members` DROP COLUMN `opencode_agent_name`/,
    );
  });

  it('schema.prisma 不再声明这两列（Prisma 侧与迁移一致）', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    expect(schema).not.toContain('defaultOpencodeAgentName');
    expect(schema).not.toContain('default_opencode_agent_name');
    expect(schema).not.toContain('opencodeAgentName');
    expect(schema).not.toContain('opencode_agent_name');
  });

  it('schema 的 AgentRole 仍保留内部默认 Agent 槽位（下线只删外部槽位）', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const roleModel =
      schema.match(/^model AgentRole \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(roleModel).toContain('defaultAgentId String?');
    expect(roleModel).toContain('@map("default_agent_id")');
  });

  it('seed 的外部岗位绑平台 Agent（a_* id），绝不再出现 opencode 引擎名', () => {
    expect(EXTERNAL_AGENT_ROLES).toHaveLength(3);
    for (const role of EXTERNAL_AGENT_ROLES) {
      expect(role.defaultAgentId).toMatch(/^a_[a-z_]+$/);
      expect(role.defaultAgentId).not.toMatch(
        /ultraworker|Plan Builder|Plan Executor/i,
      );
      expect(role.rolePrompt).not.toMatch(
        /ultraworker|Plan Builder|Plan Executor/i,
      );
      expect(role.rolePrompt).toMatch(/^# 角色：/);
    }
  });
});
