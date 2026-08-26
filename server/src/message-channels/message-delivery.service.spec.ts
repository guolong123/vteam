import { Test, TestingModule } from '@nestjs/testing';
import { MessageDeliveryService } from './message-delivery.service';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import {
  DELIVERY_DIRECTIONS,
  DELIVERY_STATUS,
} from './message-channel.constants';

describe('MessageDeliveryService', () => {
  let service: MessageDeliveryService;
  let prisma: {
    messageChannel: { findMany: jest.Mock };
    messageDelivery: {
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      findFirst?: jest.Mock;
    };
  };
  let idGen: IdGeneratorService;

  beforeEach(async () => {
    prisma = {
      messageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      messageDelivery: {
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageDeliveryService,
        { provide: PrismaService, useValue: prisma },
        IdGeneratorService,
      ],
    }).compile();

    service = module.get(MessageDeliveryService);
    idGen = module.get(IdGeneratorService);
    await service.onModuleInit();
  });

  describe('onModuleInit seed', () => {
    it('seeds mc_/md_ prefixes from existing rows ignoring naming ids', async () => {
      prisma.messageChannel.findMany.mockResolvedValue([
        { id: 'mc_0000000005' },
        { id: 'mc_builtin_foo' },
        { id: 'mc_0000000003' },
      ]);
      prisma.messageDelivery.findMany.mockResolvedValue([
        { id: 'md_0000000010' },
        { id: 'md_0000000002' },
      ]);
      await service.onModuleInit();
      expect(await idGen.nextId('mc')).toBe('mc_0000000006');
      expect(await idGen.nextId('md')).toBe('md_0000000011');
    });
  });

  describe('tryBeginIngest', () => {
    it('falsy externalId returns duplicate:false without DB write', async () => {
      const r1 = await service.tryBeginIngest('mc_1', null);
      expect(r1).toEqual({ duplicate: false });
      expect(prisma.messageDelivery.create).not.toHaveBeenCalled();

      const r2 = await service.tryBeginIngest('mc_1', '');
      expect(r2).toEqual({ duplicate: false });
      expect(prisma.messageDelivery.create).not.toHaveBeenCalled();

      const r3 = await service.tryBeginIngest('mc_1', undefined);
      expect(r3).toEqual({ duplicate: false });
      expect(prisma.messageDelivery.create).not.toHaveBeenCalled();
    });

    it('first ingest with externalId succeeds duplicate:false', async () => {
      prisma.messageDelivery.create.mockResolvedValue({
        id: 'md_0000000001',
      });
      const r = await service.tryBeginIngest('mc_1', 'ext_123');
      expect(r.duplicate).toBe(false);
      expect(r.id).toBeDefined();
      expect(prisma.messageDelivery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'mc_1',
          externalId: 'ext_123',
          direction: DELIVERY_DIRECTIONS.inbound,
          status: 'pending',
        }),
      });
    });

    it('duplicate externalId under same channel returns duplicate:true via P2002', async () => {
      const p2002 = Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
        meta: { target: ['channel_id', 'external_id'] },
      });
      prisma.messageDelivery.create.mockRejectedValue(p2002);
      const r = await service.tryBeginIngest('mc_1', 'ext_dup');
      expect(r).toEqual({ duplicate: true });
    });

    it('non-P2002 error is rethrown', async () => {
      prisma.messageDelivery.create.mockRejectedValue(new Error('DB down'));
      await expect(service.tryBeginIngest('mc_1', 'ext_x')).rejects.toThrow(
        'DB down',
      );
    });

    it('different channel with same externalId is not duplicate (DB would allow)', async () => {
      prisma.messageDelivery.create.mockResolvedValue({
        id: 'md_0000000002',
      });
      const r1 = await service.tryBeginIngest('mc_1', 'shared_ext');
      expect(r1.duplicate).toBe(false);
      const r2 = await service.tryBeginIngest('mc_2', 'shared_ext');
      expect(r2.duplicate).toBe(false);
      expect(prisma.messageDelivery.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('finish', () => {
    it('updates status and optional fields', async () => {
      await service.finish(
        'md_1',
        DELIVERY_STATUS.ok,
        null,
        { foo: 1 },
        { bar: 2 },
      );
      expect(prisma.messageDelivery.update).toHaveBeenCalledWith({
        where: { id: 'md_1' },
        data: {
          status: 'ok',
          error: null,
          payload: { foo: 1 },
          meta: { bar: 2 },
        },
      });
    });

    it('finish with error string', async () => {
      await service.finish('md_1', DELIVERY_STATUS.failed, 'timeout');
      expect(prisma.messageDelivery.update).toHaveBeenCalledWith({
        where: { id: 'md_1' },
        data: { status: 'failed', error: 'timeout' },
      });
    });
  });

  describe('log', () => {
    it('creates one-shot delivery row with generated md_ id', async () => {
      prisma.messageDelivery.create.mockResolvedValue({
        id: 'md_0000000003',
      });
      const res = await service.log(
        DELIVERY_DIRECTIONS.inbound,
        'post_message',
        DELIVERY_STATUS.ok,
        {
          channelId: 'mc_1',
          externalId: 'ext_99',
          payload: { text: 'hi' },
          meta: { attempt: 1 },
        },
      );
      expect(res.id).toBe('md_0000000003');
      expect(prisma.messageDelivery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'mc_1',
          externalId: 'ext_99',
          direction: 'inbound',
          kind: 'post_message',
          status: 'ok',
        }),
      });
    });

    it('P2002 on log returns existing id', async () => {
      const p2002 = Object.assign(new Error('Unique'), {
        code: 'P2002',
        meta: { target: ['channel_id', 'external_id'] },
      });
      prisma.messageDelivery.create.mockRejectedValue(p2002);
      (prisma.messageDelivery as any).findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'md_existing' });
      const res = await service.log(
        DELIVERY_DIRECTIONS.inbound,
        'post_message',
        DELIVERY_STATUS.ok,
        { channelId: 'mc_1', externalId: 'dup' },
      );
      expect(res.id).toBe('md_existing');
    });
  });

  describe('listByChannel cursor pagination descending', () => {
    const makeRow = (id: string) => ({
      id,
      channelId: 'mc_1',
      createdAt: new Date(),
    });

    it('first page without cursor returns items asc and nextCursor when hasMore', async () => {
      prisma.messageDelivery.findMany.mockResolvedValue([
        makeRow('md_0000000003'),
        makeRow('md_0000000002'),
        makeRow('md_0000000001'),
      ]);
      const res = await service.listByChannel('mc_1', { limit: 2 });
      expect(prisma.messageDelivery.findMany).toHaveBeenCalledWith({
        where: { channelId: 'mc_1' },
        orderBy: { id: 'desc' },
        take: 3,
      });
      expect(res.items.map((r: any) => r.id)).toEqual([
        'md_0000000002',
        'md_0000000003',
      ]);
      expect(res.nextCursor).toBe('md_0000000002');
    });

    it('with cursor filters id < cursor', async () => {
      prisma.messageDelivery.findMany.mockResolvedValue([
        makeRow('md_0000000001'),
      ]);
      const res = await service.listByChannel('mc_1', {
        cursor: 'md_0000000002',
        limit: 10,
      });
      expect(prisma.messageDelivery.findMany).toHaveBeenCalledWith({
        where: { channelId: 'mc_1', id: { lt: 'md_0000000002' } },
        orderBy: { id: 'desc' },
        take: 11,
      });
      expect(res.items).toHaveLength(1);
      expect(res.nextCursor).toBeNull();
    });

    it('last page nextCursor null and items asc', async () => {
      prisma.messageDelivery.findMany.mockResolvedValue([
        makeRow('md_0000000002'),
        makeRow('md_0000000001'),
      ]);
      const res = await service.listByChannel('mc_1', { limit: 10 });
      expect(res.nextCursor).toBeNull();
      expect(res.items.map((r: any) => r.id)).toEqual([
        'md_0000000001',
        'md_0000000002',
      ]);
    });

    it('limit clamped 1..100', async () => {
      prisma.messageDelivery.findMany.mockResolvedValue([]);
      await service.listByChannel('mc_1', { limit: 999 });
      expect(prisma.messageDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 101 }),
      );
      await service.listByChannel('mc_1', { limit: 0 });
      expect(prisma.messageDelivery.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 2 }),
      );
    });
  });

  it('isUniqueViolation detects external_id', async () => {
    const p2002 = Object.assign(new Error('Unique'), {
      code: 'P2002',
      meta: { target: ['external_id'] },
    });
    prisma.messageDelivery.create.mockRejectedValue(p2002);
    const r = await service.tryBeginIngest('mc_1', 'ext');
    expect(r.duplicate).toBe(true);
  });
});
