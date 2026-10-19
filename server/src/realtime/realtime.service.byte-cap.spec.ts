import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import {
  RealtimeEvent,
  RealtimeService,
  REALTIME_LOG_MAX_BYTES,
} from './realtime.service';

/**
 * incident-realtime-log-byte-cap：内存日志按字节收敛 + delta 帧不保留全量快照。
 *
 * 事故背景见 realtime.service.ts 中 REALTIME_LOG_MAX_BYTES /
 * REALTIME_NON_RETAINED_TYPES 的注释（2026-10 生产 OOM：1000 条 × ~1MB 全量
 * 快照常驻 ≈ 1GB + realtime_events 每 delta 一份全量快照）。
 * 两个方向的断言都必须有：字节预算真的在收敛、delta 真的不落库/不保留快照。
 */

/** 取私有内存日志（测试只读窥视，不动生产行为）。 */
const logOf = (service: RealtimeService): RealtimeEvent[] =>
  (service as unknown as { log: RealtimeEvent[] }).log;

/** 取私有字节记账（与 log 平行，验证摊销记账一致性）。 */
const logSizesOf = (service: RealtimeService): number[] =>
  (service as unknown as { logSizes: number[] }).logSizes;

/** 独立重算保留总字节（与实现同口径：JSON.stringify 的 UTF-8 长度）。 */
const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

const totalBytes = (entries: RealtimeEvent[]): number =>
  entries.reduce((sum, entry) => sum + utf8Bytes(entry), 0);

/** 造一条 ~256KiB 的大事件载荷（单条远超普通 SSE 帧，用来撑爆字节预算）。 */
const bigPayload = (n: number) => ({
  message: { id: `m_${n}`, channelId: 'c_1', blob: 'x'.repeat(256 * 1024) },
});

const DELTA_MESSAGE = {
  id: 'm_stream_1',
  channelId: 'c_1',
  senderType: 'agent',
  senderId: 'ag_1',
  content: {
    text: 'A'.repeat(4096),
    parts: [{ id: 'prt_1', type: 'text', text: 'A'.repeat(4096) }],
  },
  status: 'processing',
};

/** 与 worker-event.ingress handleMessagePartDelta 的真实广播载荷同构：全量 message + 本次 delta。 */
const deltaPayload = () => ({
  message: DELTA_MESSAGE,
  delta: [{ id: 'prt_1', type: 'text', text: 'A'.repeat(4096) }],
});

describe('RealtimeService 内存日志字节预算（incident-realtime-log-byte-cap）', () => {
  let service: RealtimeService;
  let prisma: {
    realtimeEvent: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    task: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    chatChannel: { findUnique: jest.Mock; findMany: jest.Mock };
    team: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      realtimeEvent: {
        findFirst: jest.fn(),
        create: jest.fn().mockImplementation((args) =>
          Promise.resolve({
            id: args.data.id,
            type: args.data.type,
            scopeType: args.data.scopeType,
            scopeId: args.data.scopeId,
            payload: args.data.payload,
            createdAt: new Date(),
          }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      task: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      chatChannel: { findUnique: jest.fn(), findMany: jest.fn() },
      team: { findUnique: jest.fn() },
    };
    service = new RealtimeService(
      prisma as unknown as PrismaService,
      new IdGeneratorService(),
    );
  });

  it('字节预算：压入远超预算的大事件后，保留的序列化总字节 ≤ REALTIME_LOG_MAX_BYTES（且确实发生了头部淘汰）', async () => {
    const emitted = 60; // 60 × ~256KiB ≈ 15.7MB > 8MiB 预算
    for (let n = 0; n < emitted; n++) {
      await service.emit('chat.message.new', bigPayload(n));
    }

    const log = logOf(service);
    // 预算真的在收敛（不是只按条数）：总量低于预算，且旧条目被淘汰过
    expect(totalBytes(log)).toBeLessThanOrEqual(REALTIME_LOG_MAX_BYTES);
    expect(log.length).toBeLessThan(emitted);
    expect(log.length).toBeGreaterThan(0);
    // 摊销记账与独立重算一致（logSizes 与 log 平行、logBytesTotal 无漂移）
    expect(logSizesOf(service).reduce((a, b) => a + b, 0)).toBe(
      totalBytes(log),
    );
    expect(
      (service as unknown as { logBytesTotal: number }).logBytesTotal,
    ).toBe(totalBytes(log));
    // 条数上限仍在（两个上限叠加，不互相替代）
    expect(log.length).toBeLessThanOrEqual(1000);
  });

  it('字节淘汰后仍保留最新条目：id 升序不被破坏，getLatestId 与最后一条同源', async () => {
    for (let n = 0; n < 60; n++) {
      await service.emit('chat.message.new', bigPayload(n));
    }

    const log = logOf(service);
    // 淘汰只从头部删：保留段相对顺序不变（字符串 id 升序 == 数值序）
    const ids = log.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids[ids.length - 1]).toBe(`ev_${String(60).padStart(10, '0')}`);
    // 最新一条正是刚压入的事件（内容未被误淘汰/错位）
    expect(
      (log[log.length - 1].payload as { message: { id: string } }).message.id,
    ).toBe('m_59');
    // latest-id 游标语义：最新已发事件 id
    expect(service.getLatestId()).toBe(`ev_${String(60).padStart(10, '0')}`);
  });

  it('条数上限仍在：1200 条小事件 → 只保留最近 1000 条，最新 id 不丢', async () => {
    for (let n = 0; n < 1200; n++) {
      await service.emit('agent.status', { agentId: 'ag_1', n });
    }
    const log = logOf(service);
    expect(log).toHaveLength(1000);
    expect(service.getLatestId()).toBe(`ev_${String(1200).padStart(10, '0')}`);
    // 1200 条小事件远低于字节预算 → 由条数上限收敛（证明两个上限并存）
    expect(totalBytes(log)).toBeLessThanOrEqual(REALTIME_LOG_MAX_BYTES);
  });

  it('单条事件即超预算：仍保留最新条目（latest-id 语义不因字节淘汰丢失），下一条压入再淘汰它', async () => {
    await service.emit('chat.message.new', {
      message: {
        id: 'm_huge',
        channelId: 'c_1',
        blob: 'y'.repeat(9 * 1024 * 1024),
      },
    });

    let log = logOf(service);
    expect(log).toHaveLength(1); // 日志永不为空：至少保留最新
    expect(service.getLatestId()).toBe('ev_0000000001');
    // 已知且接受的形态：单条即超预算时总量 = 预算 + 最新一条体积（见常量注释）
    expect(totalBytes(log)).toBeGreaterThan(REALTIME_LOG_MAX_BYTES);

    await service.emit('chat.message.new', { message: { id: 'm_small' } });
    log = logOf(service);
    expect(log).toHaveLength(1);
    expect((log[0].payload as { message: { id: string } }).message.id).toBe(
      'm_small',
    );
    expect(service.getLatestId()).toBe('ev_0000000002');
  });
});

describe('RealtimeService delta 帧不保留全量快照（incident-realtime-log-byte-cap）', () => {
  let service: RealtimeService;
  let prisma: {
    realtimeEvent: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    task: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    chatChannel: { findUnique: jest.Mock; findMany: jest.Mock };
    team: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      realtimeEvent: {
        findFirst: jest.fn(),
        create: jest.fn().mockImplementation((args) =>
          Promise.resolve({
            id: args.data.id,
            type: args.data.type,
            scopeType: args.data.scopeType,
            scopeId: args.data.scopeId,
            payload: args.data.payload,
            createdAt: new Date(),
          }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      task: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      chatChannel: { findUnique: jest.fn(), findMany: jest.fn() },
      team: { findUnique: jest.fn() },
    };
    service = new RealtimeService(
      prisma as unknown as PrismaService,
      new IdGeneratorService(),
    );
  });

  it('message.part.delta 零落库 + 内存日志只留识别字段：全量快照一个字都不进 realtime_events / log（回到全量快照路径此断言即红）', async () => {
    const ev = await service.emit('message.part.delta', deltaPayload(), {
      type: 'channel',
      id: 'c_1',
    });

    // (1) 不落库：realtimeEvent.create 一次都不发（事故前每 delta 一行全量快照）
    expect(prisma.realtimeEvent.create).not.toHaveBeenCalled();
    // (2) 广播/返回值仍是全量帧（wire 契约逐字节不变）
    expect(ev.payload).toEqual(deltaPayload());

    // (3) 内存日志只保留紧凑识别字段（形状 + 体积双断言）
    const log = logOf(service);
    expect(log).toHaveLength(1);
    expect(log[0].payload).toEqual({
      messageId: 'm_stream_1',
      channelId: 'c_1',
    });
    expect(utf8Bytes(log[0])).toBeLessThan(200);
    expect(JSON.stringify(log[0].payload)).not.toContain('A'.repeat(64));
    // delta 帧照常消耗 ev_ 序号，latest-id 语义保持
    expect(ev.id).toBe('ev_0000000001');
    expect(service.getLatestId()).toBe('ev_0000000001');
  });

  it('delta 的实时广播载荷与上线订阅者收到的一致（{message, delta} 全量，逐字节不变）', async () => {
    const received: RealtimeEvent[] = [];
    service.subscribe((e) => received.push(e));

    const original = deltaPayload();
    await service.emit('message.part.delta', original, {
      type: 'channel',
      id: 'c_1',
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('message.part.delta');
    expect(received[0].payload).toEqual(original);
    expect(utf8Bytes(received[0].payload)).toBeGreaterThan(4096);
    // 广播帧与返回值是同一对象（没有拷贝/裁剪广播路径）
    expect(received[0].payload).toBe(original);
  });

  it('跳过只作用于 message.part.delta：非 delta 事件照常落库全量 payload', async () => {
    await service.emit('message.part.delta', deltaPayload(), {
      type: 'channel',
      id: 'c_1',
    });
    const finalPayload = { message: DELTA_MESSAGE };
    await service.emit('chat.message.new', finalPayload, {
      type: 'channel',
      id: 'c_1',
    });

    expect(prisma.realtimeEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.realtimeEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'chat.message.new',
        scopeType: 'channel',
        scopeId: 'c_1',
        payload: finalPayload,
      }),
    });
    const log = logOf(service);
    expect(log).toHaveLength(2);
    // 非 delta 事件在内存日志中保留全量载荷（与落库同形）
    expect(log[1].payload).toEqual(finalPayload);
  });

  it('长流式累计：50 条 delta 后内存日志保留的字节仍远低于字节预算（每条 ~200B 帧+识别字段）', async () => {
    for (let n = 0; n < 50; n++) {
      await service.emit('message.part.delta', deltaPayload(), {
        type: 'channel',
        id: 'c_1',
      });
    }
    const log = logOf(service);
    expect(log).toHaveLength(50);
    // 50 × ~200B（帧头 id/type/timestamp/scope + 紧凑 payload）≈ 10KB。
    // 若回到全量快照保留：50 × 4KB+ ≈ 200KB+（此streaming测试用例即红）。
    expect(totalBytes(log)).toBeLessThan(16 * 1024);
    expect(totalBytes(log)).toBeLessThan(50 * 4 * 1024);
    expect(totalBytes(log)).toBeLessThanOrEqual(REALTIME_LOG_MAX_BYTES);
    expect(prisma.realtimeEvent.create).not.toHaveBeenCalled();
    expect(service.getLatestId()).toBe(`ev_${String(50).padStart(10, '0')}`);
  });
});
