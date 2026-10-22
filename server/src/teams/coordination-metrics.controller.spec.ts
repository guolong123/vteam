import {
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
// ⚠️ server 的 tsconfig **没开** esModuleInterop ⇒ 默认导入会变成 `supertest_1.default`（不存在）
import * as request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from '../users/admin.guard';
import { CoordinationMetricsController } from './coordination-metrics.controller';
import { CoordinationMetricsService } from './coordination-metrics.service';
import { QueryCoordinationMetricsDto } from './dto/query-coordination-metrics.dto';

/**
 * CoordinationMetricsController 单测（批次 E · 协调度指标端点）。
 *
 * 覆盖：
 * - 路由形态（裸挂载 + `teams/:teamId/coordination-metrics`）与方法；
 * - **admin 门**：端点挂 AdminGuard；非管理员 403 / 未认证 401 / 管理员放行
 *   （直接驱动真实 AdminGuard，验证端点确实被它护住）；
 * - 转发：teamId + 查询参数原样透传给 service；
 * - DTO 校验：windowHours 上限 720（超限 400，不静默截断）、to 必须是 ISO-8601。
 */
describe('CoordinationMetricsController', () => {
  let controller: CoordinationMetricsController;
  let service: { getCoordinationMetrics: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  const response = {
    teamId: 'tm_0000000001',
    teamName: '种子团队',
    generatedAt: '2026-10-22T00:00:00.000Z',
    window: {
      from: '2026-10-15T00:00:00.000Z',
      to: '2026-10-22T00:00:00.000Z',
      hours: 168,
      maxHours: 720,
    },
    totalAgentMessages: 154,
    roles: [],
    metrics: [],
  };

  const guardsOf = (method: string) =>
    (Reflect.getMetadata(
      GUARDS_METADATA,
      CoordinationMetricsController.prototype[method],
    ) ?? []) as unknown[];

  beforeEach(async () => {
    service = { getCoordinationMetrics: jest.fn().mockResolvedValue(response) };
    prisma = { user: { findUnique: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CoordinationMetricsController],
      providers: [
        { provide: CoordinationMetricsService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        AdminGuard,
      ],
    }).compile();

    controller = module.get<CoordinationMetricsController>(
      CoordinationMetricsController,
    );
  });

  describe('路由注册', () => {
    it('GET teams/:teamId/coordination-metrics（裸挂载 + 完整路径）', () => {
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          CoordinationMetricsController.prototype.getCoordinationMetrics,
        ),
      ).toBe('teams/:teamId/coordination-metrics');
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          CoordinationMetricsController.prototype.getCoordinationMetrics,
        ),
      ).toBe(RequestMethod.GET);
    });

    it('控制器只暴露一个 GET（观测面零写操作）', () => {
      const handlers = Object.getOwnPropertyNames(
        CoordinationMetricsController.prototype,
      ).filter((name) => name !== 'constructor');
      expect(handlers).toEqual(['getCoordinationMetrics']);
    });

    it('端点挂 AdminGuard（不挂 PermissionGuard：teams.view 不含「看全团队经营数据」）', () => {
      expect(guardsOf('getCoordinationMetrics')).toContain(AdminGuard);
    });
  });

  describe('admin 门（真实 AdminGuard 驱动）', () => {
    const ctx = (user?: { id?: string }) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      }) as never;

    it('未认证 ⇒ 401', async () => {
      const guard = new AdminGuard(prisma as never);
      await expect(guard.canActivate(ctx(undefined))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('非管理员（无 users:manage）⇒ 403 FORBIDDEN_ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u_normal',
        enabled: true,
        role: { permissions: { teams: { view: true } } },
      });
      const guard = new AdminGuard(prisma as never);
      await expect(
        guard.canActivate(ctx({ id: 'u_normal' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('管理员 ⇒ 放行', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u_admin',
        enabled: true,
        role: { permissions: { all: true } },
      });
      const guard = new AdminGuard(prisma as never);
      await expect(guard.canActivate(ctx({ id: 'u_admin' }))).resolves.toBe(
        true,
      );
    });
  });

  describe('转发', () => {
    it('转发 teamId + 查询参数给 service', async () => {
      const query = { windowHours: 24, to: '2026-10-22T00:00:00.000Z' };

      const result = await controller.getCoordinationMetrics(
        'tm_0000000001',
        query,
      );

      expect(service.getCoordinationMetrics).toHaveBeenCalledWith(
        'tm_0000000001',
        query,
      );
      expect(result).toEqual(response);
    });

    it('service 抛 404 时原样透传（团队不存在）', async () => {
      service.getCoordinationMetrics.mockRejectedValue({
        status: 404,
        code: 'TEAM_NOT_FOUND',
      });

      await expect(
        controller.getCoordinationMetrics('tm_nope', {}),
      ).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' });
    });
  });
});

describe('QueryCoordinationMetricsDto 校验（class-validator）', () => {
  const validateDto = async (plain: Record<string, unknown>) => {
    const dto = plainToInstance(QueryCoordinationMetricsDto, plain);
    return validate(dto as object);
  };

  it('缺省（空对象）无校验错误（窗口取服务层缺省 168h）', async () => {
    expect(await validateDto({})).toHaveLength(0);
  });

  it('windowHours 在 1..720 内合法', async () => {
    expect(await validateDto({ windowHours: 1 })).toHaveLength(0);
    expect(await validateDto({ windowHours: 720 })).toHaveLength(0);
  });

  it('windowHours 超上限（721）⇒ 校验失败（HTTP 层直接 400）', async () => {
    const errors = await validateDto({ windowHours: 721 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('windowHours');
  });

  it('windowHours 非整数 ⇒ 校验失败', async () => {
    expect((await validateDto({ windowHours: 1.5 })).length).toBeGreaterThan(0);
  });

  it('to 必须是 ISO-8601 时间', async () => {
    expect(await validateDto({ to: '2026-10-22T00:00:00.000Z' })).toHaveLength(
      0,
    );
    expect((await validateDto({ to: 'not-a-date' })).length).toBeGreaterThan(0);
  });
});

/**
 * HTTP 层端到端（supertest）：真实路由 + 真实 AdminGuard + 全局前缀 + 全局校验管道。
 *
 * 覆盖「admin 门在 HTTP 上真的生效」与「窗口参数在 HTTP 上真的被挡」：
 * 未带身份 ⇒ 401；非管理员 ⇒ 403；管理员 ⇒ 200 且响应体就是指标契约；
 * `?windowHours=721` ⇒ 400（管道拦下，不进 service）。
 */
describe('CoordinationMetricsController（HTTP 层）', () => {
  let app: INestApplication;
  let service: { getCoordinationMetrics: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  const response = {
    teamId: 'tm_0000000001',
    teamName: '种子团队',
    generatedAt: '2026-10-22T00:00:00.000Z',
    window: {
      from: '2026-10-15T00:00:00.000Z',
      to: '2026-10-22T00:00:00.000Z',
      hours: 168,
      maxHours: 720,
    },
    totalAgentMessages: 154,
    roles: [],
    metrics: [],
  };

  beforeEach(async () => {
    service = { getCoordinationMetrics: jest.fn().mockResolvedValue(response) };
    prisma = { user: { findUnique: jest.fn() } };

    const moduleRef = await Test.createTestingModule({
      controllers: [CoordinationMetricsController],
      providers: [
        { provide: CoordinationMetricsService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        AdminGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // 与 main.ts 同形：全局前缀 + 全局校验管道。
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    // 测试替身：把 x-test-user 头当作已认证用户（真实链路由全局 JwtAuthGuard 填充）。
    app.use(
      (
        req: { headers: Record<string, string>; user?: unknown },
        _res,
        next,
      ) => {
        const userId = req.headers['x-test-user'];
        if (userId) req.user = { id: userId };
        next();
      },
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('未带身份 ⇒ 401（AdminGuard 兜底认证）', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/teams/tm_0000000001/coordination-metrics',
    );

    expect(res.status).toBe(401);
    expect(service.getCoordinationMetrics).not.toHaveBeenCalled();
  });

  it('非管理员 ⇒ 403 FORBIDDEN_ADMIN（service 不被调用）', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_normal',
      enabled: true,
      role: { permissions: { teams: { view: true } } },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/teams/tm_0000000001/coordination-metrics')
      .set('x-test-user', 'u_normal');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ADMIN');
    expect(service.getCoordinationMetrics).not.toHaveBeenCalled();
  });

  it('管理员 ⇒ 200，响应体就是指标契约，且查询参数透传', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_admin',
      enabled: true,
      role: { permissions: { all: true } },
    });

    const res = await request(app.getHttpServer())
      .get(
        '/api/v1/teams/tm_0000000001/coordination-metrics?windowHours=24&to=2026-10-22T00:00:00.000Z',
      )
      .set('x-test-user', 'u_admin');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(response);
    expect(service.getCoordinationMetrics).toHaveBeenCalledWith(
      'tm_0000000001',
      expect.objectContaining({ windowHours: 24 }),
    );
  });

  it('窗口超上限（?windowHours=721）⇒ 400（管道拦下，不进 service）', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_admin',
      enabled: true,
      role: { permissions: { all: true } },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/teams/tm_0000000001/coordination-metrics?windowHours=721')
      .set('x-test-user', 'u_admin');

    expect(res.status).toBe(400);
    expect(service.getCoordinationMetrics).not.toHaveBeenCalled();
  });
});
