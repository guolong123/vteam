import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { UPLOAD_ERRORS } from './uploads.constants';
import { UploadsController } from './uploads.controller';
import { FileStorageService, StoredFile } from './uploads.service';
import { ArtifactsService } from '../artifacts/artifacts.service';

describe('UploadsController', () => {
  let controller: UploadsController;
  let service: { describe: jest.Mock };
  let artifactsService: {
    archiveFile: jest.Mock;
    assertTaskMember: jest.Mock;
  };
  /** M0：带 taskId 上传的调用方身份（JWT 由全局守卫注入）。 */
  const memberUser = { id: 'u_member' } as any;

  const file: StoredFile = {
    fieldname: 'file',
    originalname: '报告.docx',
    encoding: '7bit',
    mimetype:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 4096,
    destination: '/tmp/uploads',
    filename: 'uuid-1.docx',
    path: '/tmp/uploads/uuid-1.docx',
  };

  beforeEach(async () => {
    service = { describe: jest.fn() };
    artifactsService = {
      archiveFile: jest.fn(),
      assertTaskMember: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        { provide: FileStorageService, useValue: service },
        { provide: ArtifactsService, useValue: artifactsService },
      ],
    }).compile();

    controller = module.get<UploadsController>(UploadsController);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POST /uploads 返回 service.describe 结果（{url,name,size,ext}）', async () => {
    service.describe.mockReturnValue({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
    });

    const result = await controller.upload(file, {});

    expect(service.describe).toHaveBeenCalledWith(file, undefined);
    expect(result).toEqual({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
    });
    expect(artifactsService.archiveFile).not.toHaveBeenCalled();
  });

  it('任意扩展名（.zip/.html 等）照常上传（无类型白名单拦截）', async () => {
    const zipFile: StoredFile = {
      ...file,
      originalname: '归档.zip',
      mimetype: 'application/zip',
      filename: 'uuid-2.zip',
      path: '/tmp/uploads/uuid-2.zip',
    };
    service.describe.mockReturnValue({
      url: '/uploads/uuid-2.zip',
      name: '归档.zip',
      size: 4096,
      ext: 'zip',
    });

    const result = await controller.upload(zipFile, {});

    expect(service.describe).toHaveBeenCalledWith(zipFile, undefined);
    expect(result).toEqual({
      url: '/uploads/uuid-2.zip',
      name: '归档.zip',
      size: 4096,
      ext: 'zip',
    });
  });

  it('无扩展名文件照常上传（ext 为空串，不拒绝）', async () => {
    const noExtFile: StoredFile = {
      ...file,
      originalname: 'Makefile',
      mimetype: 'application/octet-stream',
      filename: 'uuid-3',
      path: '/tmp/uploads/uuid-3',
    };
    service.describe.mockReturnValue({
      url: '/uploads/uuid-3',
      name: 'Makefile',
      size: 128,
      ext: '',
    });

    const result = await controller.upload(noExtFile, {});

    expect(service.describe).toHaveBeenCalledWith(noExtFile, undefined);
    expect(result).toEqual({
      url: '/uploads/uuid-3',
      name: 'Makefile',
      size: 128,
      ext: '',
    });
  });

  it('带 taskId：读落盘文件计算 sha256 → 归档为 file 产出物，返回上传元数据', async () => {
    service.describe.mockReturnValue({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
    });
    const buffer = Buffer.from('文件内容 bytes');
    jest.spyOn(fsPromises, 'readFile').mockResolvedValue(buffer);
    artifactsService.archiveFile.mockResolvedValue({
      artifactId: 'art_1',
      version: 1,
      status: 'created',
    });

    const result = await controller.upload(
      file,
      { taskId: 't_0000000001' },
      memberUser,
    );

    // M0：归档前先校验任务归属团队 + 调用者是成员
    expect(artifactsService.assertTaskMember).toHaveBeenCalledWith(
      't_0000000001',
      'u_member',
    );
    expect(fsPromises.readFile).toHaveBeenCalledWith(file.path);
    expect(artifactsService.archiveFile).toHaveBeenCalledWith('t_0000000001', {
      fileRef: '/uploads/uuid-1.docx',
      storedUrl: '/uploads/uuid-1.docx',
      storedName: '报告.docx',
      sha256: createHash('sha256').update(buffer).digest('hex'),
    });
    expect(result).toEqual({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
    });
  });

  it('带 taskId 但归档失败（archiveFile 抛错）→ 不阻断上传成功返回（warn 记录）', async () => {
    service.describe.mockReturnValue({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
    });
    jest
      .spyOn(fsPromises, 'readFile')
      .mockResolvedValue(Buffer.from('文件内容 bytes'));
    artifactsService.archiveFile.mockRejectedValue(
      new Error('产出物「报告.docx」当前版本已验收锁定，不可追加'),
    );

    const result = await controller.upload(
      file,
      { taskId: 't_0000000001' },
      memberUser,
    );

    expect(artifactsService.archiveFile).toHaveBeenCalled();
    expect(result).toEqual({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
    });
  });

  describe('M0 止血：带 taskId 归档前归属校验', () => {
    it('非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER，且不落归档（不读文件/不写产出物）', async () => {
      service.describe.mockReturnValue({
        url: '/uploads/uuid-1.docx',
        name: '报告.docx',
        size: 4096,
        ext: 'docx',
      });
      artifactsService.assertTaskMember.mockRejectedValue(
        new ForbiddenException({
          code: 'PERMISSION_TEAM_NOT_MEMBER',
          message: '您不是该团队成员',
        }),
      );

      await expect(
        controller.upload(file, { taskId: 't_other_team' }, {
          id: 'u_outsider',
        } as any),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'PERMISSION_TEAM_NOT_MEMBER' },
      });
      expect(artifactsService.assertTaskMember).toHaveBeenCalledWith(
        't_other_team',
        'u_outsider',
      );
      expect(artifactsService.archiveFile).not.toHaveBeenCalled();
    });

    it('任务不存在 → 404 TASK_NOT_FOUND（不静默降级为普通上传）', async () => {
      service.describe.mockReturnValue({
        url: '/uploads/uuid-1.docx',
        name: '报告.docx',
        size: 4096,
        ext: 'docx',
      });
      artifactsService.assertTaskMember.mockRejectedValue(
        new NotFoundException({
          code: 'TASK_NOT_FOUND',
          message: '任务 t_missing 不存在',
        }),
      );

      await expect(
        controller.upload(file, { taskId: 't_missing' }, memberUser),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'TASK_NOT_FOUND' },
      });
      expect(artifactsService.archiveFile).not.toHaveBeenCalled();
    });

    it('带 taskId 但无调用方身份 → 401（fail-closed，不落归档）', async () => {
      service.describe.mockReturnValue({
        url: '/uploads/uuid-1.docx',
        name: '报告.docx',
        size: 4096,
        ext: 'docx',
      });

      await expect(
        controller.upload(file, { taskId: 't_0000000001' }),
      ).rejects.toMatchObject({ status: 401 });
      expect(artifactsService.assertTaskMember).not.toHaveBeenCalled();
      expect(artifactsService.archiveFile).not.toHaveBeenCalled();
    });
  });

  it('缺 file → 400 UPLOAD_FILE_REQUIRED（且不调 service/归档）', async () => {
    await expect(controller.upload(undefined, {})).rejects.toMatchObject({
      response: expect.objectContaining({
        code: UPLOAD_ERRORS.FILE_REQUIRED,
      }),
    });
    expect(service.describe).not.toHaveBeenCalled();
    expect(artifactsService.archiveFile).not.toHaveBeenCalled();
  });

  it('抛出的异常为 BadRequestException', async () => {
    let thrown: unknown;
    try {
      await controller.upload(undefined, {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
  });
});
