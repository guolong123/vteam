import { BadRequestException } from '@nestjs/common';
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
  let artifactsService: { archiveFile: jest.Mock };

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
    artifactsService = { archiveFile: jest.fn() };

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

    expect(service.describe).toHaveBeenCalledWith(file);
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

    expect(service.describe).toHaveBeenCalledWith(zipFile);
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

    expect(service.describe).toHaveBeenCalledWith(noExtFile);
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

    const result = await controller.upload(file, { taskId: 't_0000000001' });

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

    const result = await controller.upload(file, { taskId: 't_0000000001' });

    expect(artifactsService.archiveFile).toHaveBeenCalled();
    expect(result).toEqual({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
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
