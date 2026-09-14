jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

const mockPrisma = {
  role: { upsert: jest.fn().mockResolvedValue({ id: 'r_admin' }) },
  user: { upsert: jest.fn().mockResolvedValue({ id: 'u_admin' }) },
  agent: { upsert: jest.fn().mockResolvedValue({}) },
  // 角色 ExecutionPolicy seed（vteam-role-behavior-enforcement Todo 3）：
  // mock 缺少该 key 时 seed 首次 policy upsert 即抛 TypeError。
  executionPolicy: { upsert: jest.fn().mockResolvedValue({}) },
  model: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({}),
  },
  workerModelAvailability: { deleteMany: jest.fn().mockResolvedValue({}) },
  tool: { upsert: jest.fn().mockResolvedValue({}) },
  mcpServer: { upsert: jest.fn().mockResolvedValue({}) },
  skill: { upsert: jest.fn().mockResolvedValue({}) },
  team: { upsert: jest.fn().mockResolvedValue({ id: 'tm_0000000001' }) },
  teamMember: { upsert: jest.fn().mockResolvedValue({}) },
  teamUserMember: { upsert: jest.fn().mockResolvedValue({}) },
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

import { main } from '../../prisma/seed';
import {
  ROLE_BOUNDARIES,
  VTEAM_MCP_TOOL_NAMES,
} from '../common/constants/agent.constants';

/** 模板 Agent id → 角色 ExecutionPolicy id（seed ROLE_POLICY_BINDINGS 的绑定产物）。 */
const POLICY_BY_AGENT: Record<string, string> = {
  a_product: 'ep_product',
  a_project_manager: 'ep_project_manager',
  a_architect: 'ep_architect',
  a_developer: 'ep_developer',
  a_tester: 'ep_tester',
};

/** 模板 Agent id → role（seed templateAgents 的 role，模板 agentKey 固定等于 role）。 */
const ROLE_BY_AGENT: Record<string, string> = {
  a_product: 'product',
  a_project_manager: 'project_manager',
  a_architect: 'architect',
  a_developer: 'developer',
  a_tester: 'tester',
};

/** 角色 ExecutionPolicy id → opencode agent 名（ROLE_BOUNDARIES 的 key）。 */
const AGENT_NAME_BY_POLICY: Record<string, keyof typeof ROLE_BOUNDARIES> = {
  ep_product: 'vteam-product',
  ep_project_manager: 'vteam-project_manager',
  ep_architect: 'vteam-architect',
  ep_developer: 'vteam-developer',
  ep_tester: 'vteam-tester',
};

/**
 * 裸 MCP 工具名（剥离 vteam_ 前缀）：prompt 中只允许真实暴露名 `vteam_<action>`，
 * 禁止裸名（`agent.constants.ts` VTEAM_MCP_TOOL_NAMES 为命名空间单一来源）。
 */
const BARE_MCP_NAMES = VTEAM_MCP_TOOL_NAMES.map((name) => name.replace(/^vteam_/, ''));

const templateAgentCalls = () =>
  mockPrisma.agent.upsert.mock.calls.filter((call) => String(call[0].where.id).startsWith('a_'));

describe('seed（模板 Agent 预置 + 角色策略）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('5 类模板 Agent upsert create 分支均预置为 template 类型', async () => {
    await main();

    const agentUpserts = mockPrisma.agent.upsert.mock.calls;
    const templateIds = agentUpserts
      .map((call) => call[0].where.id)
      .filter((id) => id.startsWith('a_'));
    expect(templateIds).toHaveLength(5);
    for (const id of templateIds) {
      const call = agentUpserts.find((c) => c[0].where.id === id);
      expect(call[0].create.type).toBe('template');
      expect(call[0].create.ackMessage).toBeUndefined();
    }
  });

  it('已移除默认 ACK 文案（收到，正在处理… 机制已下线）', async () => {
    await main();
    const ackValues = mockPrisma.agent.upsert.mock.calls
      .map((call) => call[0].create.ackMessage)
      .filter((v: unknown) => v !== undefined);
    expect(ackValues).toEqual([]);
  });

  it('5 条角色 ExecutionPolicy upsert：type=template、嵌套 permission、无 write 键、MCP 仅真实名 deny', async () => {
    await main();

    const policyCalls = mockPrisma.executionPolicy.upsert.mock.calls;
    expect(policyCalls).toHaveLength(5);
    expect(policyCalls.map((call) => call[0].where.id).sort()).toEqual(
      Object.values(POLICY_BY_AGENT).sort(),
    );

    for (const call of policyCalls) {
      const { create, update } = call[0];
      expect(create.type).toBe('template');
      expect(update.type).toBe('template');
      expect(update.config).toEqual(create.config);

      const permission = create.config.permission;
      // 层① 结构：edit/read 为 glob map，无 write 键（edit 是 edit/write/apply_patch 唯一闸门）
      expect(permission).not.toHaveProperty('write');
      expect(permission.edit['*']).toBe('deny');
      for (const [glob, effect] of Object.entries(permission.edit)) {
        expect(typeof glob).toBe('string');
        expect(effect).toBe(glob === '*' ? 'deny' : 'allow');
      }
      expect(permission.read).toEqual({ '*': 'allow' });
      expect(['allow', 'ask', 'deny']).toContain(permission.bash);
      expect(permission.task).toBe('deny');

      // 其余键一律为真实暴露名 `vteam_<action>` 的 deny（禁裸 MCP 名、禁未知键）
      const otherKeys = Object.keys(permission).filter(
        (key) => !['edit', 'read', 'bash', 'task'].includes(key),
      );
      expect(otherKeys.length).toBeGreaterThan(0);
      for (const key of otherKeys) {
        expect(key.startsWith('vteam_')).toBe(true);
        expect(permission[key]).toBe('deny');
      }
      // 所有角色均不开放 task_transition（仅主 Agent），必须显式 deny
      expect(permission.vteam_task_transition).toBe('deny');

      // 层② 纠正配置：越界话术指向真实工具名 + 角色摘要非空
      expect(create.config.correction.scopeSummary.length).toBeGreaterThan(0);
      expect(create.config.correction.denyTemplate).toContain('vteam_notify_agent');
    }
  });

  it('模板策略 config.tools 为 ROLE_BOUNDARIES allowlist 的拷贝（克隆深拷贝来源）', async () => {
    await main();

    const policyCalls = mockPrisma.executionPolicy.upsert.mock.calls;
    expect(policyCalls).toHaveLength(5);
    for (const call of policyCalls) {
      const policyId = String(call[0].where.id);
      const agentName = AGENT_NAME_BY_POLICY[policyId];
      expect(agentName).toBeDefined();
      expect(call[0].create.config.tools).toEqual(
        ROLE_BOUNDARIES[agentName].toolAllows,
      );
      expect(Object.keys(call[0].create.config.tools).length).toBeGreaterThan(
        0,
      );
      expect(call[0].update.config).toEqual(call[0].create.config);
    }
  });

  it('模板 Agent create 与 update 均写入 agentKey = role（opencode 注入名 vteam-<agentKey> 与现状一致）', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(5);
    for (const call of templateCalls) {
      const id = String(call[0].where.id);
      expect(call[0].create.agentKey).toBe(ROLE_BY_AGENT[id]);
      expect(call[0].update.agentKey).toBe(ROLE_BY_AGENT[id]);
    }
  });

  it('模板 Agent create 与 update 均绑定角色策略 policyId', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(5);
    for (const call of templateCalls) {
      const id = String(call[0].where.id);
      expect(call[0].create.policyId).toBe(POLICY_BY_AGENT[id]);
      expect(call[0].update.policyId).toBe(POLICY_BY_AGENT[id]);
    }
  });

  it('ExecutionPolicy upsert 先于模板 Agent upsert（绑定指向已存在策略行）', async () => {
    await main();

    const policyOrder = mockPrisma.executionPolicy.upsert.mock.invocationCallOrder.slice(-5);
    const agentOrder = mockPrisma.agent.upsert.mock.invocationCallOrder.slice(-5);
    expect(policyOrder).toHaveLength(5);
    expect(agentOrder).toHaveLength(5);
    expect(Math.max(...policyOrder)).toBeLessThan(Math.min(...agentOrder));
  });

  it('已存在模板 Agent 时 update 分支仅同步出厂默认 prompt 与 policyId，不覆盖用户修改字段', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(5);
    for (const call of templateCalls) {
      // prompt 为平台出厂默认值，seed 随平台升级同步（16 篇 §8.4）；policyId 为角色策略绑定；
      // agentKey 为模板固定绑定（= role）；其余字段不 touch
      expect(Object.keys(call[0].update).sort()).toEqual(['agentKey', 'policyId', 'prompt']);
      expect(typeof call[0].update.prompt).toBe('string');
      expect(call[0].update.prompt.length).toBeGreaterThan(50);
      expect(call[0].update).not.toHaveProperty('permissionScope');
      expect(call[0].update).not.toHaveProperty('name');
      expect(call[0].update).not.toHaveProperty('persona');
      expect(call[0].update).not.toHaveProperty('defaultModelId');
    }
  });

  it('首次创建模板 Agent 时 create 分支 defaultModelId 为 null（动态模型目录，不再静态预置）', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    for (const call of templateCalls) {
      // TEMPLATE_DEFAULT_MODELS 已清空（动态获取）：seed 落 null，模型按 worker 上报动态目录选择
      expect(call[0].create.defaultModelId).toBeNull();
    }
  });

  it('模板 prompt 四方向齐全、含越界转交，且不含禁用词/裸 MCP 名', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(5);
    for (const call of templateCalls) {
      const prompt = call[0].update.prompt as string;
      for (const section of ['## 职责', '## 权限', '## 工作方式', '## 协同方式']) {
        expect(prompt).toContain(section);
      }
      // 越界拒绝与转交（vteam_notify_agent 为真实暴露名）
      expect(prompt).toContain('转交');
      expect(prompt).toContain('vteam_notify_agent');
      expect(prompt).not.toContain('主 Agent');
      expect(prompt).not.toContain('牵头协调者');
      expect(prompt).not.toContain('UI 设计');
      // 裸 MCP 工具名（不带 vteam_ 前缀）一律禁止
      for (const bare of BARE_MCP_NAMES) {
        const barePattern = new RegExp(`(?<!vteam_)\\b${bare}\\b`);
        expect(prompt).not.toMatch(barePattern);
      }
    }
  });

  it('示例团队同时 upsert seed-admin 与 admin(u_admin) 为 owner（fresh deploy 下 admin 开箱可进群）', async () => {
    await main();

    const tumCalls = mockPrisma.teamUserMember.upsert.mock.calls;
    expect(tumCalls).toHaveLength(2);
    const createIds = tumCalls.map((call) => call[0].create.id).sort();
    expect(createIds).toEqual(['tum_0000000001', 'tum_admin_seed']);
    for (const call of tumCalls) {
      expect(call[0].create.teamId).toBe('tm_0000000001');
      expect(call[0].create.role).toBe('owner');
      expect(call[0].update).toEqual({});
    }
  });
});
