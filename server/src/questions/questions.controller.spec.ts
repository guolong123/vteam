import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { PermissionGuard } from '../common/guards/permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';

describe('QuestionsController（Agent 提问/权限确认端点）', () => {
  let controller: QuestionsController;
  let service: { findAll: jest.Mock; reply: jest.Mock };
  let prisma: {
    task: { findUnique: jest.Mock };
    teamUserMember: { findUnique: jest.Mock };
    agentQuestion: { findUnique: jest.Mock };
  };

  const guardsOf = (method: string) =>
    (Reflect.getMetadata(
      GUARDS_METADATA,
      QuestionsController.prototype[method],
    ) ?? []) as unknown[];

  beforeEach(async () => {
    service = { findAll: jest.fn(), reply: jest.fn() };
    prisma = {
      task: { findUnique: jest.fn().mockResolvedValue({ teamId: 'tm_1' }) },
      teamUserMember: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tum_1' }),
      },
      agentQuestion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'aq_1', taskId: null }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QuestionsController],
      providers: [
        { provide: QuestionsService, useValue: service },
        // 方法级 @UseGuards(PermissionGuard) 在 compile 时实例化，PermissionGuard 依赖 PrismaService
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();
    controller = module.get<QuestionsController>(QuestionsController);
  });

  it('GET /questions 转发 findAll（taskId/teamId/status 透传，无 user 时跳过成员校验）', async () => {
    service.findAll.mockResolvedValue([{ id: 'aq_1' }]);
    const result = await controller.findAll('t_1', undefined, 'pending');
    expect(service.findAll).toHaveBeenCalledWith({
      taskId: 't_1',
      teamId: undefined,
      status: 'pending',
    });
    expect(result).toEqual([{ id: 'aq_1' }]);
  });

  it('GET /questions 带 taskId + 团队成员 → 校验通过后转发 findAll', async () => {
    service.findAll.mockResolvedValue([{ id: 'aq_1' }]);
    const result = await controller.findAll('t_1', undefined, 'pending', {
      id: 'u_1',
    });
    expect(prisma.task.findUnique).toHaveBeenCalledWith({
      where: { id: 't_1' },
      select: { teamId: true },
    });
    expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 'tm_1', userId: 'u_1' } },
      select: { id: true },
    });
    expect(service.findAll).toHaveBeenCalledWith({
      taskId: 't_1',
      teamId: undefined,
      status: 'pending',
    });
    expect(result).toEqual([{ id: 'aq_1' }]);
  });

  it('GET /questions 带 taskId + 非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
    prisma.teamUserMember.findUnique.mockResolvedValue(null);
    const err = (await controller
      .findAll('t_1', undefined, 'pending', { id: 'u_1' })
      .catch((e: unknown) => e)) as { response?: { code?: string } };
    expect(err.response?.code).toBe('PERMISSION_TEAM_NOT_MEMBER');
    expect(service.findAll).not.toHaveBeenCalled();
  });

  it('GET /questions 带 teamId + 团队成员 → 团队校验通过后转发 findAll', async () => {
    service.findAll.mockResolvedValue([{ id: 'aq_1' }]);
    const result = await controller.findAll(undefined, 'tm_1', 'pending', {
      id: 'u_1',
    });
    expect(prisma.task.findUnique).not.toHaveBeenCalled();
    expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 'tm_1', userId: 'u_1' } },
      select: { id: true },
    });
    expect(service.findAll).toHaveBeenCalledWith({
      taskId: undefined,
      teamId: 'tm_1',
      status: 'pending',
    });
    expect(result).toEqual([{ id: 'aq_1' }]);
  });

  it('GET /questions 带 teamId + 非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
    prisma.teamUserMember.findUnique.mockResolvedValue(null);
    const err = (await controller
      .findAll(undefined, 'tm_1', 'pending', { id: 'u_1' })
      .catch((e: unknown) => e)) as { response?: { code?: string } };
    expect(err.response?.code).toBe('PERMISSION_TEAM_NOT_MEMBER');
    expect(service.findAll).not.toHaveBeenCalled();
  });

  it('GET /questions 挂 PermissionGuard + chats.view（成员只读，对齐群聊域矩阵）', () => {
    expect(guardsOf('findAll')).toContain(PermissionGuard);
  });

  it('POST /questions/:id/reply 转发 reply(id, dto, userId)', async () => {
    service.reply.mockResolvedValue({ id: 'aq_1', status: 'resolved' });
    const dto = { answers: [['继续']] } as ReplyQuestionDto;
    const result = await controller.reply('aq_1', dto, { id: 'u_1' });
    expect(service.reply).toHaveBeenCalledWith('aq_1', dto, 'u_1');
    expect(result).toEqual({ id: 'aq_1', status: 'resolved' });
  });

  it('POST /questions/:id/reply 任务归属非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
    prisma.agentQuestion.findUnique.mockResolvedValue({
      id: 'aq_1',
      taskId: 't_1',
    });
    prisma.teamUserMember.findUnique.mockResolvedValue(null);
    const dto = { answers: [['继续']] } as ReplyQuestionDto;
    const err = (await controller
      .reply('aq_1', dto, { id: 'u_1' })
      .catch((e: unknown) => e)) as { response?: { code?: string } };
    expect(err.response?.code).toBe('PERMISSION_TEAM_NOT_MEMBER');
    expect(service.reply).not.toHaveBeenCalled();
  });

  it('POST /questions/:id/reply 挂 PermissionGuard + chats.edit（member 矩阵已预置）', () => {
    expect(guardsOf('reply')).toContain(PermissionGuard);
  });
});
