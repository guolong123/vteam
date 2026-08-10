import { DEFAULT_ACK_MESSAGE } from '../chat/chat.constants';

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
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

import { main } from '../../prisma/seed';

describe('seed（模板 Agent 预置收到确认文案）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('4 类模板 Agent upsert create 分支均预置 ackMessage 默认文案', async () => {
    await main();

    const agentUpserts = mockPrisma.agent.upsert.mock.calls;
    const templateIds = agentUpserts
      .map((call) => call[0].where.id)
      .filter((id) => id.startsWith('a_'));
    expect(templateIds).toHaveLength(4);
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
});
