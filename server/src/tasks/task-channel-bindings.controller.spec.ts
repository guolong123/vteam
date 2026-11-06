import { Test } from '@nestjs/testing';
import { TaskChannelBindingsController } from './task-channel-bindings.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('TaskChannelBindingsController', () => {
  let controller: TaskChannelBindingsController;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      task: { findUnique: jest.fn().mockResolvedValue({ id: 't_1' }) },
      messageChannel: {
        findMany: jest.fn().mockResolvedValue([{ id: 'mc_1' }]),
      },
      notificationChannel: {
        findMany: jest.fn().mockResolvedValue([{ id: 'nc_1' }]),
      },
      taskMessageChannel: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({}),
      },
      taskNotificationChannel: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({}),
      },
    };
    const module = await Test.createTestingModule({
      controllers: [TaskChannelBindingsController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    controller = module.get(TaskChannelBindingsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('bind message channels validates existence', async () => {
    prisma.messageChannel.findMany.mockResolvedValue([{ id: 'mc_1' }]);
    const res = await controller.bindMessageChannels('t_1', {
      messageChannelIds: ['mc_1'],
    });
    expect(res.taskId).toBe('t_1');
    expect(prisma.taskMessageChannel.deleteMany).toHaveBeenCalledWith({
      where: { taskId: 't_1' },
    });
  });

  it('任务级通知绑定已下线：GET/POST 均返回 410（M8）', () => {
    expect(() => controller.listNotificationChannels('t_1')).toThrow(
      /任务级通知渠道绑定已下线/,
    );
    expect(() => controller.bindNotificationChannels('t_1')).toThrow(
      /任务级通知渠道绑定已下线/,
    );
  });
});
