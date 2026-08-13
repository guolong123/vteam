import { DEFAULT_ACK_MESSAGE } from '../chat/chat.constants';
import { TEMPLATE_DEFAULT_MODELS } from '../common/constants/agent.constants';

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

const mockPrisma = {
  role: { upsert: jest.fn().mockResolvedValue({ id: 'r_admin' }) },
  user: { upsert: jest.fn().mockResolvedValue({ id: 'u_admin' }) },
  project: { upsert: jest.fn().mockResolvedValue({}) },
  projectMember: { upsert: jest.fn().mockResolvedValue({}) },
  agent: { upsert: jest.fn().mockResolvedValue({}) },
  model: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) },
  workerModelAvailability: { deleteMany: jest.fn().mockResolvedValue({}) },
  tool: { upsert: jest.fn().mockResolvedValue({}) },
  mcpServer: { upsert: jest.fn().mockResolvedValue({}) },
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

import { main } from '../../prisma/seed';

describe('seed（模板 Agent 预置收到确认文案）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('5 类模板 Agent upsert create 分支均预置 ackMessage 默认文案', async () => {
    await main();

    const agentUpserts = mockPrisma.agent.upsert.mock.calls;
    const templateIds = agentUpserts
      .map((call) => call[0].where.id)
      .filter((id) => id.startsWith('a_'));
    expect(templateIds).toHaveLength(5);
    for (const id of templateIds) {
      const call = agentUpserts.find((c) => c[0].where.id === id);
      expect(call[0].create.type).toBe('template');
      expect(call[0].create.ackMessage).toBe(DEFAULT_ACK_MESSAGE);
    }
  });

  it('create 分支 ackMessage 与 chat 域默认文案常量一致（文案单一事实源）', async () => {
    await main();

    const ackValues = mockPrisma.agent.upsert.mock.calls
      .map((call) => call[0].create.ackMessage)
      .filter((v: unknown) => v !== undefined);
    expect(new Set(ackValues)).toEqual(new Set([DEFAULT_ACK_MESSAGE]));
    expect(DEFAULT_ACK_MESSAGE).toBe('收到，正在处理…');
  });

  it('已存在模板 Agent 时 update 分支仅同步出厂默认 prompt，不覆盖用户修改的 defaultModelId', async () => {
    await main();

    const templateCalls = mockPrisma.agent.upsert.mock.calls.filter((call) =>
      String(call[0].where.id).startsWith('a_'),
    );
    expect(templateCalls).toHaveLength(5);
    for (const call of templateCalls) {
      // prompt 为平台出厂默认值，seed 随平台升级同步（16 篇 §8.4）；其余字段不 touch
      expect(Object.keys(call[0].update).sort()).toEqual(['prompt']);
      expect(typeof call[0].update.prompt).toBe('string');
      expect(call[0].update.prompt.length).toBeGreaterThan(50);
    }
  });

  it('首次创建模板 Agent 时 create 分支设置 TEMPLATE_DEFAULT_MODELS 默认模型', async () => {
    await main();

    const templateCalls = mockPrisma.agent.upsert.mock.calls.filter((call) =>
      String(call[0].where.id).startsWith('a_'),
    );
    for (const call of templateCalls) {
      const id = call[0].where.id as string;
      expect(call[0].create.defaultModelId).toBe(TEMPLATE_DEFAULT_MODELS[id]);
    }
  });

  it('模板 prompt 不写死「主 Agent/牵头协调者」职责（运行时按任务 mainAgentId 动态注入）', async () => {
    await main();

    const templateCalls = mockPrisma.agent.upsert.mock.calls.filter((call) =>
      String(call[0].where.id).startsWith('a_'),
    );
    expect(templateCalls).toHaveLength(5);
    for (const call of templateCalls) {
      const prompt = call[0].update.prompt as string;
      expect(prompt).not.toContain('主 Agent');
      expect(prompt).not.toContain('牵头协调者');
      // 产品/项目经理本职描述仍保留（四方向结构不回归）
      expect(prompt).toContain('## 职责');
      expect(prompt).toContain('## 协同方式');
    }
  });
});
