import { Test } from '@nestjs/testing';
import { REQUIRE_PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';

describe('ArtifactsController', () => {
  let controller: ArtifactsController;
  const service = {
    findByTask: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    findByTeam: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    findOne: jest.fn(),
    findVersion: jest.fn(),
    append: jest.fn(),
    restore: jest.fn(),
  };
  const prismaMock = {
    user: { findUnique: jest.fn() },
    team: { findUnique: jest.fn() },
    teamUserMember: { findUnique: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ArtifactsController],
      providers: [
        { provide: ArtifactsService, useValue: service },
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(ArtifactsController);
  });

  it('GET /tasks/:id/artifacts：转发 findByTask（id + 查询参数）', async () => {
    await expect(
      controller.findByTask('t_0000000001', {
        type: 'text',
        accepted: 'true',
        page: 1,
        pageSize: 20,
      }),
    ).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(service.findByTask).toHaveBeenCalledWith('t_0000000001', {
      type: 'text',
      accepted: 'true',
      page: 1,
      pageSize: 20,
    });
  });

  it('GET /artifacts/:id：转发 findOne', async () => {
    service.findOne.mockResolvedValue({
      id: 'art_0000000001',
      currentVersion: 1,
    });
    await expect(controller.findOne('art_0000000001')).resolves.toEqual({
      id: 'art_0000000001',
      currentVersion: 1,
    });
    expect(service.findOne).toHaveBeenCalledWith('art_0000000001');
  });

  it('GET /artifacts/:id/versions/:version：ParseIntPipe 转 number 后转发 findVersion', async () => {
    service.findVersion.mockResolvedValue({ version: 2, contentRef: 'ref' });
    await expect(controller.findVersion('art_0000000001', 2)).resolves.toEqual({
      version: 2,
      contentRef: 'ref',
    });
    expect(service.findVersion).toHaveBeenCalledWith('art_0000000001', 2);
  });

  it('POST /tasks/:id/artifacts：body 组装 payload 后转 append', async () => {
    service.append.mockResolvedValue({
      status: 'archived',
      artifact: { id: 'art_0000000001' },
    });
    await expect(
      controller.append('t_0000000001', {
        type: 'text',
        title: '验收结论',
        content: '通过',
      }),
    ).resolves.toEqual({
      status: 'archived',
      artifact: { id: 'art_0000000001' },
    });
    expect(service.append).toHaveBeenCalledWith('t_0000000001', {
      taskId: 't_0000000001',
      type: 'text',
      title: '验收结论',
      content: '通过',
      fileRef: undefined,
      category: undefined,
    });
  });

  it('POST /tasks/:id/artifacts：category 透传给 append（T4）', async () => {
    service.append.mockResolvedValue({
      status: 'archived',
      artifact: { id: 'art_0000000001', category: '需求' },
    });
    await expect(
      controller.append('t_0000000001', {
        type: 'text',
        title: '需求说明',
        content: '正文',
        category: '需求',
      }),
    ).resolves.toEqual({
      status: 'archived',
      artifact: { id: 'art_0000000001', category: '需求' },
    });
    expect(service.append).toHaveBeenCalledWith('t_0000000001', {
      taskId: 't_0000000001',
      type: 'text',
      title: '需求说明',
      content: '正文',
      fileRef: undefined,
      category: '需求',
    });
  });

  it('POST /artifacts/:id/restore：转发 restore（id + version）', async () => {
    service.restore.mockResolvedValue({
      status: 'restored',
      artifact: { id: 'art_0000000001' },
    });
    await expect(
      controller.restore('art_0000000001', { version: 1 }),
    ).resolves.toEqual({
      status: 'restored',
      artifact: { id: 'art_0000000001' },
    });
    expect(service.restore).toHaveBeenCalledWith('art_0000000001', 1);
  });

  describe('GET /teams/:id/artifacts（T5 团队聚合端点）', () => {
    it('成员直通：团队存在 + 成员 → 转发 findByTeam（id + 查询参数）', async () => {
      prismaMock.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prismaMock.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      service.findByTeam.mockResolvedValue({
        items: [{ id: 'art_0000000001', taskName: '任务一' }],
        total: 1,
        page: 1,
        pageSize: 20,
      });

      await expect(
        controller.findByTeam(
          'tm_0000000001',
          { category: '需求', page: 1, pageSize: 20 },
          { id: 'u_0000000001' } as any,
        ),
      ).resolves.toEqual({
        items: [{ id: 'art_0000000001', taskName: '任务一' }],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      expect(service.findByTeam).toHaveBeenCalledWith('tm_0000000001', {
        category: '需求',
        page: 1,
        pageSize: 20,
      });
    });

    it('未知团队 → 404 TEAM_NOT_FOUND（不调 service）', async () => {
      prismaMock.team.findUnique.mockResolvedValue(null);

      await expect(
        controller.findByTeam('tm_missing', {}, { id: 'u_1' } as any),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'TEAM_NOT_FOUND' },
      });
      expect(service.findByTeam).not.toHaveBeenCalled();
    });

    it('非成员 → 403 PERMISSION_TEAM_NOT_MEMBER（不调 service）', async () => {
      prismaMock.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prismaMock.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        controller.findByTeam('tm_0000000001', {}, { id: 'u_stranger' } as any),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'PERMISSION_TEAM_NOT_MEMBER' },
      });
      expect(service.findByTeam).not.toHaveBeenCalled();
    });

    it('读端点挂 artifacts.view（与任务列表端点同权限点）', () => {
      expect(
        Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller.findByTeam),
      ).toBe('artifacts.view');
    });
  });

  describe('权限点守卫（CONF-02 方案②补齐矩阵守卫）', () => {
    const permOf = (handler: (...args: unknown[]) => unknown) =>
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler);

    it('读端点挂 artifacts.view（列表/详情/版本）', () => {
      expect(permOf(controller.findByTask)).toBe('artifacts.view');
      expect(permOf(controller.findOne)).toBe('artifacts.view');
      expect(permOf(controller.findVersion)).toBe('artifacts.view');
    });

    it('旁路补充提交挂 artifacts.create', () => {
      expect(permOf(controller.append)).toBe('artifacts.create');
    });

    it('恢复历史版本挂 artifacts.edit（改写当前版本指针语义，需编辑权）', () => {
      expect(permOf(controller.restore)).toBe('artifacts.edit');
    });
  });
});
