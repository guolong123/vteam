/**
 * 团队↔通知渠道绑定端点（回归套件）。
 *
 * ⚠️ **回归根因**：`findExclusiveBindingConflicts` 把渠道外键字段名**写死**成
 * `messageChannelId`，而通知渠道绑定表 `teamNotificationChannel` 的字段是
 * `notificationChannelId`（见 `prisma/schema.prisma`）⇒ Prisma 抛
 * `Unknown argument 'messageChannelId'` ⇒ **POST /teams/:teamId/notification-channels
 * 恒 500**（消息渠道路径不受影响：字段名恰好对上）。
 *
 * 本套件的假 Prisma **按真实模型字段名校验查询参数**（未知字段直接抛错，模拟
 * `PrismaClientValidationError`）——否则"什么都能查"的假 Prisma 会把这个缺陷**吞掉**，
 * 回归测试就变成了永远绿的空壳。
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
// ⚠️ server 的 tsconfig **没开** esModuleInterop ⇒ 默认导入会变成 `supertest_1.default`（不存在）
import * as request from 'supertest';
import { PermissionGuard } from '../common/guards/permission.guard';
import { TeamMembershipGuard } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TeamChannelBindingsController } from './team-channel-bindings.controller';

/** 两张绑定表**真实存在**的字段（与 prisma/schema.prisma 一致）。 */
const LINK_TABLE_FIELDS: Record<string, Set<string>> = {
  teamMessageChannel: new Set(['teamId', 'messageChannelId']),
  teamNotificationChannel: new Set(['teamId', 'notificationChannelId']),
};

/**
 * 按真实模型字段名校验查询参数；未知字段抛错（模拟 PrismaClientValidationError）。
 *
 * ⚠️ 校验**只针对顶层键**：`where` 的顶层键就是字段名（`{ notificationChannelId: { in: [...] } }`），
 * `select` 的顶层键同理——这正是 Prisma 报 `Unknown argument` 的那一层。
 */
function assertKnownFields(
  table: string,
  args: { where?: unknown; select?: unknown },
): void {
  const allowed = LINK_TABLE_FIELDS[table];
  for (const scope of ['where', 'select'] as const) {
    const value = args[scope];
    if (!value || typeof value !== 'object') {
      continue;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!allowed.has(key)) {
        throw new Error(
          `Invalid \`prisma.${table}.findMany()\` invocation: Unknown argument \`${key}\`. ` +
            `Available options are marked with ?.`,
        );
      }
    }
  }
}

interface FakePrismaOptions {
  /** 通知渠道已存在的行（id 集合）。 */
  notificationChannels?: string[];
  /** 消息渠道已存在的行（id 集合）。 */
  messageChannels?: string[];
  /** 通知渠道绑定表已有的行（其它团队的绑定）。 */
  notificationLinks?: Array<{ teamId: string; notificationChannelId: string }>;
  /** 消息渠道绑定表已有的行（其它团队的绑定）。 */
  messageLinks?: Array<{ teamId: string; messageChannelId: string }>;
}

function createFakePrisma(options: FakePrismaOptions = {}) {
  const notificationLinks = options.notificationLinks ?? [];
  const messageLinks = options.messageLinks ?? [];

  const teamNotificationChannel = {
    findMany: jest.fn(async (args: { where?: unknown; select?: unknown }) => {
      assertKnownFields('teamNotificationChannel', args);
      return notificationLinks;
    }),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 0 })),
  };
  const teamMessageChannel = {
    findMany: jest.fn(async (args: { where?: unknown; select?: unknown }) => {
      assertKnownFields('teamMessageChannel', args);
      return messageLinks;
    }),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 0 })),
  };

  const prisma = {
    team: {
      findUnique: jest.fn(async () => ({ id: 'tm_0000000001' })),
      findMany: jest.fn(async () => [{ id: 'tm_other', name: '其它团队' }]),
    },
    notificationChannel: {
      findMany: jest.fn(async () =>
        (options.notificationChannels ?? []).map((id) => ({ id })),
      ),
    },
    messageChannel: {
      findMany: jest.fn(async () =>
        (options.messageChannels ?? []).map((id) => ({ id })),
      ),
    },
    teamNotificationChannel,
    teamMessageChannel,
  };

  return prisma;
}

describe('TeamChannelBindingsController（团队↔通知渠道绑定）', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof createFakePrisma>;

  async function buildApp(options: FakePrismaOptions = {}): Promise<void> {
    prisma = createFakePrisma(options);
    const moduleRef = await Test.createTestingModule({
      controllers: [TeamChannelBindingsController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    })
      .overrideGuard(TeamMembershipGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  }

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  // ---- 回归：POST notification-channels 曾恒 500（Prisma Unknown argument）----

  it('POST /teams/:teamId/notification-channels → 2xx（绑定成功，不 500）', async () => {
    await buildApp({ notificationChannels: ['nc_0000000001'] });

    const res = await request(app.getHttpServer())
      .post('/teams/tm_0000000001/notification-channels')
      .send({ notificationChannelIds: ['nc_0000000001'] });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(res.body).toEqual({
      teamId: 'tm_0000000001',
      notificationChannelIds: ['nc_0000000001'],
    });
  });

  it('POST notification-channels：绑定表查询用 notificationChannelId（不写死 messageChannelId）', async () => {
    await buildApp({ notificationChannels: ['nc_0000000001'] });

    await request(app.getHttpServer())
      .post('/teams/tm_0000000001/notification-channels')
      .send({ notificationChannelIds: ['nc_0000000001'] });

    const call = prisma.teamNotificationChannel.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(Object.keys(call.where)).toEqual(
      expect.arrayContaining(['notificationChannelId', 'teamId']),
    );
    expect(call.where).not.toHaveProperty('messageChannelId');
    expect(call.select).toEqual({ notificationChannelId: true, teamId: true });
  });

  it('POST notification-channels：写入用 notificationChannelId（replace-all 语义）', async () => {
    await buildApp({ notificationChannels: ['nc_0000000001'] });

    await request(app.getHttpServer())
      .post('/teams/tm_0000000001/notification-channels')
      .send({ notificationChannelIds: ['nc_0000000001'] });

    expect(prisma.teamNotificationChannel.deleteMany).toHaveBeenCalledWith({
      where: { teamId: 'tm_0000000001' },
    });
    expect(prisma.teamNotificationChannel.createMany).toHaveBeenCalledWith({
      data: [
        { teamId: 'tm_0000000001', notificationChannelId: 'nc_0000000001' },
      ],
      skipDuplicates: true,
    });
  });

  it('POST notification-channels：渠道已绑其它团队 → 409（独占语义，缺省不静默抢占）', async () => {
    await buildApp({
      notificationChannels: ['nc_0000000001'],
      notificationLinks: [
        { teamId: 'tm_other', notificationChannelId: 'nc_0000000001' },
      ],
    });

    const res = await request(app.getHttpServer())
      .post('/teams/tm_0000000001/notification-channels')
      .send({ notificationChannelIds: ['nc_0000000001'] });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('已被其他团队绑定');
  });

  it('POST notification-channels：渠道不存在 → 400（CHANNEL_NOT_FOUND）', async () => {
    await buildApp({ notificationChannels: [] });

    const res = await request(app.getHttpServer())
      .post('/teams/tm_0000000001/notification-channels')
      .send({ notificationChannelIds: ['nc_missing'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('POST notification-channels：空列表 = 清空绑定（2xx）', async () => {
    await buildApp({ notificationChannels: [] });

    const res = await request(app.getHttpServer())
      .post('/teams/tm_0000000001/notification-channels')
      .send({ notificationChannelIds: [] });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(prisma.teamNotificationChannel.createMany).not.toHaveBeenCalled();
  });

  // ---- 消息渠道路径：回归修复不得改坏原有行为 ----

  it('POST /teams/:teamId/message-channels → 2xx，且仍用 messageChannelId', async () => {
    await buildApp({ messageChannels: ['mc_0000000001'] });

    const res = await request(app.getHttpServer())
      .post('/teams/tm_0000000001/message-channels')
      .send({ messageChannelIds: ['mc_0000000001'] });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const call = prisma.teamMessageChannel.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where).toHaveProperty('messageChannelId');
    expect(prisma.teamMessageChannel.createMany).toHaveBeenCalledWith({
      data: [{ teamId: 'tm_0000000001', messageChannelId: 'mc_0000000001' }],
      skipDuplicates: true,
    });
  });
});
