import { Test, TestingModule } from '@nestjs/testing';
import { NotificationDeliveryService } from './notification-delivery.service';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { DELIVERY_DIRECTIONS, DELIVERY_STATUS } from './notification.constants';

describe('NotificationDeliveryService', () => {
  let service: NotificationDeliveryService;
  let prisma: {
    notificationChannel: { findMany: jest.Mock };
    notificationDelivery: {
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      findFirst?: jest.Mock;
    };
  };
  let idGen: IdGeneratorService;

  beforeEach(async () => {
    prisma = {
      notificationChannel: { findMany: jest.fn().mockResolvedValue([]) },
      notificationDelivery: {
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDeliveryService,
        { provide: PrismaService, useValue: prisma },
        IdGeneratorService,
      ],
    }).compile();

    service = module.get(NotificationDeliveryService);
    idGen = module.get(IdGeneratorService);
    await service.onModuleInit();
  });

  describe('onModuleInit seed', () => {
    it('seeds nc_/nd_ prefixes from existing rows ignoring naming ids', async () => {
      prisma.notificationChannel.findMany.mockResolvedValue([
        { id: 'nc_0000000005' },
        { id: 'nc_builtin_foo' },
        { id: 'nc_0000000003' },
      ]);
      prisma.notificationDelivery.findMany.mockResolvedValue([
        { id: 'nd_0000000010' },
        { id: 'nd_0000000002' },
      ]);
      await service.onModuleInit();
      expect(await idGen.nextId('nc')).toBe('nc_0000000006');
      expect(await idGen.nextId('nd')).toBe('nd_0000000011');
    });
  });

  describe('finish', () => {
    it('updates status and optional fields', async () => {
      await service.finish(
        'nd_1',
        DELIVERY_STATUS.ok,
        null,
        { foo: 1 },
        { bar: 2 },
      );
      expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
        where: { id: 'nd_1' },
        data: {
          status: 'ok',
          error: null,
          payload: { foo: 1 },
          meta: { bar: 2 },
        },
      });
    });

    it('finish with error string', async () => {
      await service.finish('nd_1', DELIVERY_STATUS.failed, 'timeout');
      expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
        where: { id: 'nd_1' },
        data: { status: 'failed', error: 'timeout' },
      });
    });
  });

  describe('log', () => {
    it('creates one-shot delivery row with generated nd_ id', async () => {
      prisma.notificationDelivery.create.mockResolvedValue({
        id: 'nd_0000000003',
      });
      const res = await service.log(
        DELIVERY_DIRECTIONS.outbound,
        'markdown',
        DELIVERY_STATUS.ok,
        {
          channelId: 'nc_1',
          externalId: 'ext_99',
          payload: { text: 'hi' },
          meta: { attempt: 1 },
        },
      );
      expect(res.id).toBe('nd_0000000003');
      expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'nc_1',
          externalId: 'ext_99',
          direction: 'outbound',
          kind: 'markdown',
          status: 'ok',
        }),
      });
    });

    it('P2002 duplicate returns existing id (resync)', async () => {
      const p2002 = Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
        meta: { target: ['channel_id', 'external_id'] },
      });
      prisma.notificationDelivery.create.mockRejectedValue(p2002);
      prisma.notificationDelivery.findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'nd_0000000001' });
      const res = await service.log(
        DELIVERY_DIRECTIONS.outbound,
        'markdown',
        DELIVERY_STATUS.ok,
        {
          channelId: 'nc_1',
          externalId: 'ext_dup',
          payload: { text: 'hi' },
        },
      );
      expect(res.id).toBe('nd_0000000001');
      expect(prisma.notificationDelivery.findFirst).toHaveBeenCalledWith({
        where: { channelId: 'nc_1', externalId: 'ext_dup' },
        select: { id: true },
      });
    });

    it('non-P2002 error is rethrown', async () => {
      prisma.notificationDelivery.create.mockRejectedValue(
        new Error('DB down'),
      );
      await expect(
        service.log(DELIVERY_DIRECTIONS.outbound, 'markdown', 'ok', {
          channelId: 'nc_1',
        }),
      ).rejects.toThrow('DB down');
    });
  });

  describe('listByChannel cursor pagination descending', () => {
    const makeRow = (id: string) => ({
      id,
      channelId: 'nc_1',
      createdAt: new Date(),
    });

    it('first page without cursor returns items asc and nextCursor when hasMore', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([
        makeRow('nd_0000000003'),
        makeRow('nd_0000000002'),
        makeRow('nd_0000000001'),
      ]);
      const res = await service.listByChannel('nc_1', { limit: 2 });
      expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith({
        where: { channelId: 'nc_1' },
        orderBy: { id: 'desc' },
        take: 3,
      });
      expect(res.items.map((r: any) => r.id)).toEqual([
        'nd_0000000002',
        'nd_0000000003',
      ]);
      expect(res.nextCursor).toBe('nd_0000000002');
    });

    it('with cursor filters id < cursor', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([
        makeRow('nd_0000000001'),
      ]);
      const res = await service.listByChannel('nc_1', {
        cursor: 'nd_0000000002',
        limit: 10,
      });
      expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith({
        where: { channelId: 'nc_1', id: { lt: 'nd_0000000002' } },
        orderBy: { id: 'desc' },
        take: 11,
      });
      expect(res.items).toHaveLength(1);
      expect(res.nextCursor).toBeNull();
    });

    it('last page nextCursor null and items asc', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([
        makeRow('nd_0000000002'),
        makeRow('nd_0000000001'),
      ]);
      const res = await service.listByChannel('nc_1', { limit: 10 });
      expect(res.nextCursor).toBeNull();
      expect(res.items.map((r: any) => r.id)).toEqual([
        'nd_0000000001',
        'nd_0000000002',
      ]);
    });

    it('limit clamped 1..100', async () => {
      prisma.notificationDelivery.findMany.mockResolvedValue([]);
      await service.listByChannel('nc_1', { limit: 999 });
      expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 101 }),
      );
      await service.listByChannel('nc_1', { limit: 0 });
      expect(prisma.notificationDelivery.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 2 }),
      );
    });
  });
});
