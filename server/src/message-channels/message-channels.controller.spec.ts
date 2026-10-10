import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MessageChannelsController } from './message-channels.controller';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { MessageRegistryService } from './message-registry.service';
import { MessageDeliveryService } from './message-delivery.service';
import { MessageInboundService } from './message-inbound.service';

describe('MessageChannelsController', () => {
  let controller: MessageChannelsController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [MessageChannelsController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            messageChannel: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            messageDelivery: { findMany: jest.fn() },
            taskMessageChannel: { findMany: jest.fn() },
            task: { findUnique: jest.fn() },
          },
        },
        IdGeneratorService,
        {
          provide: MessageRegistryService,
          useValue: {
            get: jest.fn(),
            getChannel: jest.fn(),
            requestStop: jest.fn(),
            startEnabled: jest.fn(),
            submitInbound: jest.fn(),
          },
        },
        {
          provide: MessageDeliveryService,
          useValue: { listByChannel: jest.fn() },
        },
        { provide: MessageInboundService, useValue: {} },
      ],
    }).compile();
    controller = module.get(MessageChannelsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('inbound route is Public (no auth guard)', async () => {
    const { IS_PUBLIC_KEY } =
      await import('../auth/decorators/public.decorator');
    const handler = (controller as any).inbound;
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler);
    expect(isPublic).toBe(true);
  });

  /**
   * wecom_aibot 的 botId 独占校验（生产 mc_2/mc_6 事故）。
   *
   * 两个渠道填了同一个 botId → WeCom 只允许一条长连接，后连的那条会被服务端
   * 直接踢下线且 SDK 不再重连（sdk index.esm.js:380-397），表现为永远 connecting。
   * 停用旧渠道后再启新渠道是合法迁移路径，故冲突方 enabled=false 时必须放行。
   */
  describe('wecom_aibot botId 独占校验', () => {
    let prisma: any;
    /** 存量 wecom 渠道（默认启用） */
    const existingRows = (
      rows: Array<{
        id: string;
        name: string;
        enabled: boolean;
        botId: string;
      }>,
    ) =>
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        secrets: { botId: r.botId, secret: 's' },
        enabled: r.enabled,
      }));

    beforeEach(() => {
      prisma = (controller as any).prisma;
      prisma.messageChannel.findMany.mockResolvedValue([]);
      prisma.messageChannel.create.mockImplementation(
        async ({ data }: any) => ({
          ...data,
          lastStatus: null,
          lastError: null,
        }),
      );
      prisma.messageChannel.update.mockImplementation(
        async ({ data }: any) => ({
          id: 'mc_self',
          name: 'self',
          type: 'wecom_aibot',
          config: {},
          secrets: {},
          enabled: true,
          ...data,
        }),
      );
    });

    it('创建：botId 与某个已启用渠道重复 → 409，且错误里点名冲突渠道', async () => {
      prisma.messageChannel.findMany.mockResolvedValue(
        existingRows([
          { id: 'mc_2', name: '群主机器人', enabled: true, botId: 'bot_dup' },
        ]),
      );

      let caught: any;
      try {
        await (controller as any).create({
          name: '新机器人',
          type: 'wecom_aibot',
          secrets: { botId: 'bot_dup', secret: 's' },
        });
        fail('应拒绝重复 botId');
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.getStatus()).toBe(409);
      const body = caught.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('CHANNEL_BOTID_DUPLICATE');
      expect(body.conflictingChannelId).toBe('mc_2');
      expect(body.conflictingChannelName).toBe('群主机器人');
      expect(String(body.message)).toContain('mc_2');
      expect(String(body.message)).toContain('群主机器人');
      expect(String(body.message)).toContain('一个企微机器人只能有一条长连接');
      // 冲突时不得落库
      expect(prisma.messageChannel.create).not.toHaveBeenCalled();
    });

    it('创建：botId 重复但冲突渠道已停用 → 放行（先停旧、再启新的迁移路径）', async () => {
      prisma.messageChannel.findMany.mockResolvedValue(
        existingRows([
          { id: 'mc_old', name: '旧机器人', enabled: false, botId: 'bot_dup' },
        ]),
      );

      await expect(
        (controller as any).create({
          name: '新机器人',
          type: 'wecom_aibot',
          secrets: { botId: 'bot_dup', secret: 's' },
        }),
      ).resolves.toBeDefined();
      expect(prisma.messageChannel.create).toHaveBeenCalled();
    });

    it('创建：非 wecom_aibot 类型完全不受该校验影响', async () => {
      prisma.messageChannel.findMany.mockResolvedValue(
        existingRows([
          { id: 'mc_2', name: '群主机器人', enabled: true, botId: 'bot_dup' },
        ]),
      );

      await expect(
        (controller as any).create({
          name: 'webhook',
          type: 'generic_webhook',
          secrets: { botId: 'bot_dup' },
        }),
      ).resolves.toBeDefined();
      // 非 wecom 类型连查都不该查
      expect(prisma.messageChannel.findMany).not.toHaveBeenCalled();
      expect(prisma.messageChannel.create).toHaveBeenCalled();
    });

    it('更新：请求不带 secrets 时用库里的 botId 校验，仍能挡住重复', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue({
        id: 'mc_6',
        name: '新机器人',
        type: 'wecom_aibot',
        config: {},
        secrets: { botId: 'bot_dup', secret: 's' },
        enabled: true,
      });
      prisma.messageChannel.findMany.mockResolvedValue(
        existingRows([
          { id: 'mc_2', name: '群主机器人', enabled: true, botId: 'bot_dup' },
        ]),
      );

      await expect(
        (controller as any).update('mc_6', { name: '改名' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.messageChannel.update).not.toHaveBeenCalled();
    });

    it('更新：停用中的渠道即便 botId 重复也放行（停用永远不被拦）', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue({
        id: 'mc_old',
        name: '旧机器人',
        type: 'wecom_aibot',
        config: {},
        secrets: { botId: 'bot_dup', secret: 's' },
        enabled: false,
      });
      prisma.messageChannel.findMany.mockResolvedValue(
        existingRows([
          { id: 'mc_2', name: '群主机器人', enabled: true, botId: 'bot_dup' },
        ]),
      );

      await expect(
        (controller as any).update('mc_old', { name: '改名' }),
      ).resolves.toBeDefined();
      expect(prisma.messageChannel.update).toHaveBeenCalled();
    });

    it('更新：冲突方停用时放行', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue({
        id: 'mc_new',
        name: '新机器人',
        type: 'wecom_aibot',
        config: {},
        secrets: { botId: 'bot_dup', secret: 's' },
        enabled: true,
      });
      prisma.messageChannel.findMany.mockResolvedValue(
        existingRows([
          { id: 'mc_old', name: '旧机器人', enabled: false, botId: 'bot_dup' },
        ]),
      );

      await expect(
        (controller as any).update('mc_new', { name: '改名' }),
      ).resolves.toBeDefined();
      expect(prisma.messageChannel.update).toHaveBeenCalled();
    });

    it('更新：排除自身（同一渠道改名不会误伤自己）', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue({
        id: 'mc_2',
        name: '群主机器人',
        type: 'wecom_aibot',
        config: {},
        secrets: { botId: 'bot_dup', secret: 's' },
        enabled: true,
      });
      prisma.messageChannel.findMany.mockResolvedValue(
        existingRows([
          { id: 'mc_2', name: '群主机器人', enabled: true, botId: 'bot_dup' },
        ]),
      );

      await expect(
        (controller as any).update('mc_2', { name: '群主机器人2' }),
      ).resolves.toBeDefined();
      // id: { not: 'mc_2' } 必须传下去，否则自己跟自己冲突
      expect(prisma.messageChannel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { not: 'mc_2' } }),
        }),
      );
      expect(prisma.messageChannel.update).toHaveBeenCalled();
    });

    it('停用路由不受影响：重复 botId 也能停用', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue({
        id: 'mc_6',
        name: '新机器人',
        type: 'wecom_aibot',
        config: {},
        secrets: { botId: 'bot_dup', secret: 's' },
        enabled: true,
      });
      prisma.messageChannel.findMany.mockResolvedValue(
        existingRows([
          { id: 'mc_2', name: '群主机器人', enabled: true, botId: 'bot_dup' },
        ]),
      );

      await expect((controller as any).disable('mc_6')).resolves.toBeDefined();
      expect(prisma.messageChannel.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { enabled: false } }),
      );
    });

    /**
     * enable 路径：save 侧刻意放行「目标已启用 + 冲突方停用」，
     * 这一对只有在 disable→enable 迁移时才双双启用，故 enable 是唯一的收敛点。
     */
    describe('enable 路由', () => {
      /** 库里待启用的渠道（默认停用中） */
      const stored = (over: Record<string, any> = {}) => ({
        id: 'mc_new',
        name: '新机器人',
        type: 'wecom_aibot',
        config: {},
        secrets: { botId: 'bot_dup', secret: 's' },
        enabled: false,
        ...over,
      });

      it('botId 与某个已启用渠道重复 → 409，且错误里点名冲突渠道', async () => {
        prisma.messageChannel.findUnique.mockResolvedValue(stored());
        prisma.messageChannel.findMany.mockResolvedValue(
          existingRows([
            {
              id: 'mc_2',
              name: '群主机器人',
              enabled: true,
              botId: 'bot_dup',
            },
          ]),
        );

        let caught: any;
        try {
          await (controller as any).enable('mc_new');
          fail('应拒绝重复 botId 的启用');
        } catch (e) {
          caught = e;
        }

        expect(caught).toBeInstanceOf(ConflictException);
        expect(caught.getStatus()).toBe(409);
        const body = caught.getResponse() as Record<string, unknown>;
        expect(body.code).toBe('CHANNEL_BOTID_DUPLICATE');
        expect(body.conflictingChannelId).toBe('mc_2');
        expect(body.conflictingChannelName).toBe('群主机器人');
        expect(String(body.message)).toContain('mc_2');
        expect(String(body.message)).toContain('群主机器人');
        expect(String(body.message)).toContain(
          '一个企微机器人只能有一条长连接',
        );
        // 冲突时不得落库、也不得触发 adapter.start
        expect(prisma.messageChannel.update).not.toHaveBeenCalled();
        expect(
          (controller as any).registry.startEnabled,
        ).not.toHaveBeenCalled();
      });

      it('botId 重复但冲突渠道已停用 → 放行并走到 adapter.start（先停旧、再启新的迁移路径）', async () => {
        prisma.messageChannel.findUnique.mockResolvedValue(stored());
        prisma.messageChannel.findMany.mockResolvedValue(
          existingRows([
            {
              id: 'mc_old',
              name: '旧机器人',
              enabled: false,
              botId: 'bot_dup',
            },
          ]),
        );
        const adapter = { start: jest.fn().mockResolvedValue(undefined) };
        (controller as any).registry.get.mockReturnValue(adapter);
        (controller as any).registry.startEnabled.mockResolvedValue(undefined);

        await expect(
          (controller as any).enable('mc_new'),
        ).resolves.toBeDefined();

        expect(prisma.messageChannel.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'mc_new' },
            data: { enabled: true },
          }),
        );
        expect(adapter.start).toHaveBeenCalled();
        expect((controller as any).registry.startEnabled).toHaveBeenCalled();
      });

      it('重复启用自身（幂等 re-enable）不误伤：排除自身', async () => {
        prisma.messageChannel.findUnique.mockResolvedValue(
          stored({ enabled: true }),
        );
        prisma.messageChannel.findMany.mockResolvedValue(
          existingRows([
            {
              id: 'mc_new',
              name: '新机器人',
              enabled: true,
              botId: 'bot_dup',
            },
          ]),
        );

        await expect(
          (controller as any).enable('mc_new'),
        ).resolves.toBeDefined();
        // id: { not: 'mc_new' } 必须传下去，否则自己跟自己冲突
        expect(prisma.messageChannel.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: { not: 'mc_new' } }),
          }),
        );
        expect(prisma.messageChannel.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: { enabled: true } }),
        );
      });

      it('非 wecom_aibot 类型启用完全不受该校验影响（连查询都不发）', async () => {
        prisma.messageChannel.findUnique.mockResolvedValue(
          stored({ type: 'generic_webhook' }),
        );
        prisma.messageChannel.findMany.mockResolvedValue(
          existingRows([
            {
              id: 'mc_2',
              name: '群主机器人',
              enabled: true,
              botId: 'bot_dup',
            },
          ]),
        );

        await expect(
          (controller as any).enable('mc_new'),
        ).resolves.toBeDefined();
        expect(prisma.messageChannel.findMany).not.toHaveBeenCalled();
        expect(prisma.messageChannel.update).toHaveBeenCalled();
      });

      it('happy path：无冲突时正常启用并启动 adapter', async () => {
        prisma.messageChannel.findUnique.mockResolvedValue(stored());
        prisma.messageChannel.findMany.mockResolvedValue(
          existingRows([
            {
              id: 'mc_other',
              name: '别的机器人',
              enabled: true,
              botId: 'bot_other',
            },
          ]),
        );
        const adapter = { start: jest.fn().mockResolvedValue(undefined) };
        (controller as any).registry.get.mockReturnValue(adapter);
        (controller as any).registry.startEnabled.mockResolvedValue(undefined);

        const out = await (controller as any).enable('mc_new');

        expect(out).toMatchObject({ id: 'mc_self', enabled: true });
        expect(out.secrets).toEqual({}); // 掩码
        expect(adapter.start).toHaveBeenCalled();
        expect((controller as any).registry.startEnabled).toHaveBeenCalled();
      });

      it('渠道不存在 → 404，且不落库', async () => {
        prisma.messageChannel.findUnique.mockResolvedValue(null);

        await expect(
          (controller as any).enable('mc_gone'),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.messageChannel.update).not.toHaveBeenCalled();
      });
    });
  });
});
