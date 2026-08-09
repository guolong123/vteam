import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UPLOAD_ERRORS } from './uploads.constants';
import { UploadsController } from './uploads.controller';
import { FileStorageService, StoredFile } from './uploads.service';

describe('UploadsController', () => {
  let controller: UploadsController;
  let service: { describe: jest.Mock };

  beforeEach(async () => {
    service = { describe: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [{ provide: FileStorageService, useValue: service }],
    }).compile();

    controller = module.get<UploadsController>(UploadsController);
  });

  it('POST /uploads 返回 service.describe 结果（{url,name,size,ext}）', () => {
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
    service.describe.mockReturnValue({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
    });

    const result = controller.upload(file);
    expect(service.describe).toHaveBeenCalledWith(file);
    expect(result).toEqual({
      url: '/uploads/uuid-1.docx',
      name: '报告.docx',
      size: 4096,
      ext: 'docx',
    });
  });

  it('缺 file → 400 UPLOAD_FILE_REQUIRED（且不调 service）', () => {
    expect(() => controller.upload(undefined)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: UPLOAD_ERRORS.FILE_REQUIRED,
        }),
      }),
    );
    expect(service.describe).not.toHaveBeenCalled();
  });

  it('抛出的异常为 BadRequestException', () => {
    let thrown: unknown;
    try {
      controller.upload(undefined);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
  });
});
