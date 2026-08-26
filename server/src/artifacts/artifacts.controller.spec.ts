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
    findOne: jest.fn(),
    findVersion: jest.fn(),
    append: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ArtifactsController],
      providers: [
        { provide: ArtifactsService, useValue: service },
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
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
  });
});
