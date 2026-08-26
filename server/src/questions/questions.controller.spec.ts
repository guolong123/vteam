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

  const guardsOf = (method: string) =>
    (Reflect.getMetadata(
      GUARDS_METADATA,
      QuestionsController.prototype[method],
    ) ?? []) as unknown[];

  beforeEach(async () => {
    service = { findAll: jest.fn(), reply: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QuestionsController],
      providers: [
        { provide: QuestionsService, useValue: service },
        // 方法级 @UseGuards(PermissionGuard) 在 compile 时实例化，PermissionGuard 依赖 PrismaService
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    }).compile();
    controller = module.get<QuestionsController>(QuestionsController);
  });

  it('GET /questions 转发 findAll（taskId/status 透传）', async () => {
    service.findAll.mockResolvedValue([{ id: 'aq_1' }]);
    const result = await controller.findAll('t_1', 'pending');
    expect(service.findAll).toHaveBeenCalledWith({
      taskId: 't_1',
      status: 'pending',
    });
    expect(result).toEqual([{ id: 'aq_1' }]);
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

  it('POST /questions/:id/reply 挂 PermissionGuard + chats.edit（member 矩阵已预置）', () => {
    expect(guardsOf('reply')).toContain(PermissionGuard);
  });
});
