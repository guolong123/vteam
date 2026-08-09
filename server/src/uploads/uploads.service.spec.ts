import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import { FILE_SIZE_LIMIT, UPLOAD_ERRORS } from './uploads.constants';
import { FileStorageService, StoredFile } from './uploads.service';

describe('FileStorageService（文件存储基础：文件名生成 / 白名单 / multer 策略 / 元数据）', () => {
  describe('extractExtension', () => {
    it('提取小写扩展名（含大写扩展名归一）', () => {
      expect(FileStorageService.extractExtension('需求文档.PDF')).toBe('pdf');
      expect(FileStorageService.extractExtension('a.b.csv')).toBe('csv');
    });

    it('无扩展名 / 点结尾 / 空名 → null', () => {
      expect(FileStorageService.extractExtension('README')).toBeNull();
      expect(FileStorageService.extractExtension('file.')).toBeNull();
      expect(FileStorageService.extractExtension('')).toBeNull();
    });
  });

  describe('generateFilename', () => {
    it('生成 UUID + 保留扩展名（杜绝重名/路径穿越）', () => {
      const name = FileStorageService.generateFilename('报告.PDF');
      expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/);
      expect(name).not.toContain('报告');
    });

    it('无扩展名 → 纯 UUID', () => {
      const name = FileStorageService.generateFilename('README');
      expect(name).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('assertAllowed（扩展名白名单）', () => {
    it.each(['a.pdf', 'b.docx', 'c.xlsx', 'd.csv', 'e.png', 'f.jpg', 'g.md', 'h.txt'])(
      '接受白名单文件 %s',
      (originalname) => {
        expect(() =>
          FileStorageService.assertAllowed({ originalname, mimetype: 'application/octet-stream' }),
        ).not.toThrow();
      },
    );

    it.each(['a.exe', 'b.html', 'c.js', 'd.sh', 'e', 'f.'])(
      '拒绝非法/无扩展名文件 %s → 400 UPLOAD_FILE_TYPE_NOT_ALLOWED',
      (originalname) => {
        expect(() =>
          FileStorageService.assertAllowed({ originalname, mimetype: 'application/octet-stream' }),
        ).toThrow(
          expect.objectContaining({
            response: expect.objectContaining({
              code: UPLOAD_ERRORS.FILE_TYPE_NOT_ALLOWED,
            }),
          }),
        );
      },
    );

    it('不依赖 mimetype（octet-stream 亦按扩展名放行，扩展名是可控类型信号）', () => {
      expect(() =>
        FileStorageService.assertAllowed({ originalname: 'a.pdf', mimetype: 'application/octet-stream' }),
      ).not.toThrow();
    });
  });

  describe('buildMulterOptions（diskStorage 策略）', () => {
    it('组装 storage / limits(10MB) / fileFilter', () => {
      const options = FileStorageService.buildMulterOptions();
      expect(options.storage).toBeDefined();
      expect(options.limits).toEqual({ fileSize: FILE_SIZE_LIMIT });
      expect(typeof options.fileFilter).toBe('function');
    });

    it('fileFilter 接受白名单文件、拒绝非法文件（cb 语义）', async () => {
      const options = FileStorageService.buildMulterOptions();
      const accept = await new Promise<{ err: Error | null; ok: boolean }>(
        (resolve) =>
          options.fileFilter(null, { originalname: 'ok.pdf', mimetype: 'application/pdf' }, (err, ok) =>
            resolve({ err, ok }),
          ),
      );
      const reject = await new Promise<{ err: Error | null; ok: boolean }>(
        (resolve) =>
          options.fileFilter(null, { originalname: 'bad.exe', mimetype: 'application/octet-stream' }, (err, ok) =>
            resolve({ err, ok }),
          ),
      );
      expect(accept).toEqual({ err: null, ok: true });
      expect(reject.ok).toBe(false);
      expect(reject.err).toBeInstanceOf(BadRequestException);
    });
  });

  describe('describe（上传响应元数据）', () => {
    it('返回 {url, name, size, ext}', () => {
      const file: StoredFile = {
        fieldname: 'file',
        originalname: '需求文档.PDF',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 2048,
        destination: '/tmp/uploads',
        filename: 'abc-123.pdf',
        path: '/tmp/uploads/abc-123.pdf',
      };
      const meta = new FileStorageService().describe(file);
      expect(meta).toEqual({
        url: '/uploads/abc-123.pdf',
        name: '需求文档.PDF',
        size: 2048,
        ext: 'pdf',
      });
    });

    it('无扩展名 → ext 空串', () => {
      const file: StoredFile = {
        fieldname: 'file',
        originalname: 'README',
        encoding: '7bit',
        mimetype: 'text/plain',
        size: 10,
        destination: '/tmp/uploads',
        filename: 'abc-123',
        path: '/tmp/uploads/abc-123',
      };
      expect(new FileStorageService().describe(file).ext).toBe('');
    });
  });

  describe('normalizeFileRef（产出物 fileRef 归一化，FILE-02）', () => {
    it('/uploads/ 前缀 → 原样（控制面静态服务 + web rewrite 可达）', () => {
      expect(FileStorageService.normalizeFileRef('/uploads/api-doc.pdf')).toBe(
        '/uploads/api-doc.pdf',
      );
    });

    it('http(s):// 完整 URL → 原样（外部引用）', () => {
      expect(
        FileStorageService.normalizeFileRef('https://files.example.com/report.pdf'),
      ).toBe('https://files.example.com/report.pdf');
      expect(FileStorageService.normalizeFileRef('http://localhost:3000/x.png')).toBe(
        'http://localhost:3000/x.png',
      );
    });

    it('worker 工作区原始路径 → 提取 basename 归一为 /uploads/<basename>', () => {
      expect(
        FileStorageService.normalizeFileRef('/data/workspace/tasks/t_1/report.PDF'),
      ).toBe('/uploads/report.PDF');
      expect(
        FileStorageService.normalizeFileRef('C:\\workspace\\patch.txt'),
      ).toBe('/uploads/patch.txt');
    });

    it('纯文件名 → 归一为 /uploads/<name>', () => {
      expect(FileStorageService.normalizeFileRef('api-doc.pdf')).toBe(
        '/uploads/api-doc.pdf',
      );
    });

    it('无扩展名 / 空串 → 原样（不伪造可访问 URL）', () => {
      expect(FileStorageService.normalizeFileRef('/data/tasks/t_1/README')).toBe(
        '/data/tasks/t_1/README',
      );
      expect(FileStorageService.normalizeFileRef('')).toBe('');
    });
  });

  describe('describeFileRef（归一化 fileRef 派生展示元数据，FILE-02）', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('/uploads/ 引用 → name=basename + ext，size 读磁盘（文件存在）', () => {
      const spy = jest.spyOn(fs, 'statSync').mockReturnValue({ size: 4096 } as never);
      const meta = FileStorageService.describeFileRef('/uploads/uuid.pdf');
      expect(meta).toEqual({ name: 'uuid.pdf', ext: 'pdf', size: 4096 });
      spy.mockRestore();
    });

    it('/uploads/ 引用磁盘缺失 → size null（前端不显示大小徽章）', () => {
      const spy = jest.spyOn(fs, 'statSync').mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const meta = FileStorageService.describeFileRef('/uploads/ghost.png');
      expect(meta).toEqual({ name: 'ghost.png', ext: 'png', size: null });
      spy.mockRestore();
    });

    it('外部 URL → name/ext 从 URL 尾部提取，size null（不读本地磁盘）', () => {
      const statSpy = jest.spyOn(fs, 'statSync');
      const meta = FileStorageService.describeFileRef(
        'https://files.example.com/report.pdf',
      );
      expect(meta).toEqual({ name: 'report.pdf', ext: 'pdf', size: null });
      expect(statSpy).not.toHaveBeenCalled();
      statSpy.mockRestore();
    });

    it('无扩展名 → ext 空串', () => {
      const meta = FileStorageService.describeFileRef('/uploads/README');
      expect(meta.ext).toBe('');
    });
  });
});
