import { Test } from '@nestjs/testing';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';

describe('ArtifactsController', () => {
  let controller: ArtifactsController;
  const service = {
    findByTask: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    findOne: jest.fn(),
    findVersion: jest.fn(),
    append: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ArtifactsController],
      providers: [{ provide: ArtifactsService, useValue: service }],
    }).compile();
    controller = moduleRef.get(ArtifactsController);
  });

  it('GET /tasks/:id/artifacts：转发 findByTask（id + 查询参数）', async () => {
    await expect(
      controller.findByTask('t_0000000001', { type: 'text', accepted: 'true', page: 1, pageSize: 20 }),
    ).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(service.findByTask).toHaveBeenCalledWith('t_0000000001', {
      type: 'text',
      accepted: 'true',
      page: 1,
      pageSize: 20,
    });
  });

  it('GET /artifacts/:id：转发 findOne', async () => {
    service.findOne.mockResolvedValue({ id: 'art_0000000001', currentVersion: 1 });
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
    service.append.mockResolvedValue({ status: 'archived', artifact: { id: 'art_0000000001' } });
    await expect(
      controller.append('t_0000000001', {
        type: 'text',
        title: '验收结论',
        content: '通过',
      }),
    ).resolves.toEqual({ status: 'archived', artifact: { id: 'art_0000000001' } });
    expect(service.append).toHaveBeenCalledWith('t_0000000001', {
      taskId: 't_0000000001',
      type: 'text',
      title: '验收结论',
      content: '通过',
      fileRef: undefined,
    });
  });
});
