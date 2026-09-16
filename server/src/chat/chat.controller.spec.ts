import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { REQUIRE_PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { MessageReceiptsService } from './message-receipts.service';

/**
 * GET /messages/receipts 合同单测（plan-review-execution-gates follow-up task 13，
 * 补 todo 5 缺失的独立查询端点：此前仅 service 层 ack/expireDue/countPending，
 * GET /api/v1/messages/receipts 直接 404）。
 *
 * - 路由形状：path='messages/receipts' + GET + chats.view（PermissionGuard 矩阵守卫，
 *   与 channels/:id/messages 等读端点同模式；未鉴权 → 全局 JwtAuthGuard 401）；
 * - 委托：controller.findReceipts 直透 MessageReceiptsService.listReceipts，
 *   返回 {items, pending, total}，items 行含 id/messageId/from/to/status/createdAt；
 * - 过滤：taskId/teamId/status 透传，status 缺省 = 全量（不过滤）。
 */
describe('ChatController (GET /messages/receipts)', () => {
  let controller: ChatController;
  let receipts: { listReceipts: jest.Mock };

  beforeEach(async () => {
    receipts = { listReceipts: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: {} },
        { provide: MessageReceiptsService, useValue: receipts },
      ],
    })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ChatController>(ChatController);
  });

  describe('路由形状（404→200：端点存在性）', () => {
    const pathOf = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(PATH_METADATA, handler);
    const methodOf = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(METHOD_METADATA, handler);
    const permissionOf = (handler: (...args: never[]) => unknown) =>
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler);

    it('findReceipts 挂载于 messages/receipts（GET）', () => {
      expect(pathOf(controller.findReceipts)).toBe('messages/receipts');
      expect(methodOf(controller.findReceipts)).toBe(0); // RequestMethod.GET
    });

    it('findReceipts 要求 chats.view（读矩阵，与 sibling 读端点同模式）', () => {
      expect(permissionOf(controller.findReceipts)).toBe('chats.view');
    });
  });

  describe('委托与过滤', () => {
    const user = { id: 'u_1', username: 'member' } as never;

    it('teamId 查询回 {items, pending, total}（items 行含 id/messageId/from/to/status/createdAt）', async () => {
      const row = {
        id: 'mr_1',
        messageId: 'm_1',
        fromInstanceId: 'tmm_pm',
        toInstanceId: 'tmm_arch',
        status: 'pending',
        createdAt: new Date('2026-09-16T00:00:00.000Z'),
      };
      receipts.listReceipts.mockResolvedValue({
        items: [row],
        pending: 1,
        total: 1,
      });

      const res = await controller.findReceipts(
        user,
        undefined,
        'tm_1',
        undefined,
      );

      expect(receipts.listReceipts).toHaveBeenCalledWith({
        taskId: undefined,
        teamId: 'tm_1',
        status: undefined,
      });
      expect(res).toEqual({ items: [row], pending: 1, total: 1 });
      expect(Object.keys(res.items[0])).toEqual(
        expect.arrayContaining(['id', 'messageId', 'status', 'createdAt']),
      );
    });

    it('status 过滤透传（status=pending 仅回 pending 行）', async () => {
      receipts.listReceipts.mockResolvedValue({
        items: [],
        pending: 0,
        total: 3,
      });

      const res = await controller.findReceipts(user, 't_1', 'tm_1', 'pending');

      expect(receipts.listReceipts).toHaveBeenCalledWith({
        taskId: 't_1',
        teamId: 'tm_1',
        status: 'pending',
      });
      expect(res).toEqual({ items: [], pending: 0, total: 3 });
    });

    it('status 缺省 = 全量（service 侧不过滤 status）', async () => {
      receipts.listReceipts.mockResolvedValue({
        items: [{ id: 'mr_9', status: 'acked' }],
        pending: 0,
        total: 1,
      });

      await controller.findReceipts(user, undefined, 'tm_1', undefined);

      expect(receipts.listReceipts).toHaveBeenCalledWith(
        expect.objectContaining({ status: undefined }),
      );
    });
  });
});

describe('MessageReceiptsService.listReceipts（task 13 查询实现）', () => {
  let service: MessageReceiptsService;
  let prisma: {
    messageReceipt: { findMany: jest.Mock; count: jest.Mock };
    task: { findUnique: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      messageReceipt: { findMany: jest.fn(), count: jest.fn() },
      task: { findUnique: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageReceiptsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
      ],
    }).compile();

    service = module.get<MessageReceiptsService>(MessageReceiptsService);
  });

  it('按 teamId + status=pending 过滤行并回 {items, pending, total}', async () => {
    const row = {
      id: 'mr_1',
      messageId: 'm_1',
      fromInstanceId: 'tmm_pm',
      toInstanceId: 'tmm_arch',
      status: 'pending',
      createdAt: new Date(),
    };
    prisma.messageReceipt.findMany.mockResolvedValue([row]);
    prisma.messageReceipt.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(4);

    const res = await service.listReceipts({
      teamId: 'tm_1',
      status: 'pending',
    });

    expect(prisma.messageReceipt.findMany).toHaveBeenCalledWith({
      where: { teamId: 'tm_1', status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    expect(res).toEqual({ items: [row], pending: 1, total: 4 });
  });

  it('status 缺省不过滤 status（全量行 + countPending 同口径计数）', async () => {
    prisma.messageReceipt.findMany.mockResolvedValue([]);
    prisma.messageReceipt.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);

    const res = await service.listReceipts({ taskId: 't_1' });

    expect(prisma.messageReceipt.findMany).toHaveBeenCalledWith({
      where: { taskId: 't_1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(res).toEqual({ items: [], pending: 0, total: 2 });
  });
});
