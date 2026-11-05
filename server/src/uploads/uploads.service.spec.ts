import * as fs from 'node:fs';
import { FILE_SIZE_LIMIT } from './uploads.constants';
import { FileStorageService, StoredFile } from './uploads.service';

describe('FileStorageService（文件存储基础：文件名生成 / 不限类型 / multer 策略 / 元数据）', () => {
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
      expect(name).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/,
      );
      expect(name).not.toContain('报告');
    });

    it('无扩展名 → 纯 UUID', () => {
      const name = FileStorageService.generateFilename('README');
      expect(name).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('类型不限（取消扩展名白名单，任意扩展名/无扩展名均可上传）', () => {
    it.each([
      'a.pdf',
      'b.docx',
      'c.zip',
      'd.tar.gz',
      'e.html',
      'f.svg',
      'g.exe',
      'h.sh',
      'i',
      'j.',
      '.hidden',
    ])('任意文件 %s 都有合法落盘文件名（不被拦截）', (originalname) => {
      const filename = FileStorageService.generateFilename(originalname);
      expect(filename).toBeTruthy();
      expect(filename).not.toContain('/');
      expect(filename).not.toContain('\\');
    });

    it('multer options 不再挂 fileFilter（类型判断交给模型侧，控制面恒放行）', () => {
      const options = FileStorageService.buildMulterOptions();
      expect(Object.keys(options)).not.toContain('fileFilter');
    });

    it('不再导出白名单校验入口（assertAllowed 已移除）', () => {
      expect(
        (FileStorageService as unknown as Record<string, unknown>)
          .assertAllowed,
      ).toBeUndefined();
    });
  });

  describe('buildMulterOptions（diskStorage 策略）', () => {
    it('组装 storage / limits(20MB)，不挂 fileFilter', () => {
      const options = FileStorageService.buildMulterOptions();
      expect(options.storage).toBeDefined();
      expect(options.limits).toEqual({ fileSize: FILE_SIZE_LIMIT });
      expect(Object.keys(options)).not.toContain('fileFilter');
    });

    it('大小上限为 20MB（与前端/worker 对齐）', () => {
      expect(FILE_SIZE_LIMIT).toBe(20 * 1024 * 1024);
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

    it('中文文件名被 busboy 按 latin1 解码（乱码）→ 响应 name 还原为正确中文', () => {
      // 模拟浏览器提交 UTF-8 字节、busboy 默认 latin1 解码后的 originalname
      const garbled = Buffer.from('需求文档（终版）.PDF', 'utf8').toString(
        'latin1',
      );
      const file: StoredFile = {
        fieldname: 'file',
        originalname: garbled,
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 2048,
        destination: '/tmp/uploads',
        filename: 'abc-123.pdf',
        path: '/tmp/uploads/abc-123.pdf',
      };
      const meta = new FileStorageService().describe(file);
      expect(meta.name).toBe('需求文档（终版）.PDF');
      expect(meta.ext).toBe('pdf');
    });

    it('generateFilename 取 latin1 错位文件名的扩展名仍正确、磁盘名只有 UUID+ext', () => {
      const garbled = Buffer.from('压缩包.zip', 'utf8').toString('latin1');
      const filename = FileStorageService.generateFilename(garbled);
      expect(filename).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/,
      );
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
        FileStorageService.normalizeFileRef(
          'https://files.example.com/report.pdf',
        ),
      ).toBe('https://files.example.com/report.pdf');
      expect(
        FileStorageService.normalizeFileRef('http://localhost:3000/x.png'),
      ).toBe('http://localhost:3000/x.png');
    });

    it('worker 工作区原始路径 → 提取 basename 归一为 /uploads/<basename>', () => {
      expect(
        FileStorageService.normalizeFileRef(
          '/data/workspace/tasks/t_1/report.PDF',
        ),
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
      expect(
        FileStorageService.normalizeFileRef('/data/tasks/t_1/README'),
      ).toBe('/data/tasks/t_1/README');
      expect(FileStorageService.normalizeFileRef('')).toBe('');
    });
  });

  describe('readUploadedFile（归档内容读取：/uploads 落盘文件 + 内联正文）', () => {
    const originalUploadDir = process.env.UPLOAD_DIR;

    afterEach(() => {
      if (originalUploadDir === undefined) {
        delete process.env.UPLOAD_DIR;
      } else {
        process.env.UPLOAD_DIR = originalUploadDir;
      }
      jest.restoreAllMocks();
    });

    it('/uploads/<name> → 读控制面落盘文件（既有行为不变）', async () => {
      const dir = 'uploads-test-tmp';
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/abc.md`, '落盘正文', 'utf8');
      process.env.UPLOAD_DIR = dir;

      const buffer =
        await FileStorageService.readUploadedFile('/uploads/abc.md');
      expect(buffer.toString('utf8')).toBe('落盘正文');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('内联正文（text 类产出物：contentRef 存的就是正文）→ 直接返回字节', async () => {
      const body = '# 产出物正文\n\n第一段内容。\n\n- 列表项\n';
      const buffer = await FileStorageService.readUploadedFile(body);
      expect(buffer.toString('utf8')).toBe(body);
    });

    it('内联正文：短正文（无换行无空格）也能读到（不判死）', async () => {
      const buffer = await FileStorageService.readUploadedFile('已完成');
      expect(buffer.toString('utf8')).toBe('已完成');
    });

    it('内联正文：正文里出现「像文件名」的片段（如 "见 issue.update"）仍按正文返回', async () => {
      // normalizeFileRef 会把这类正文映射成 /uploads/<basename> → 判读顺序必须先判内联正文
      const body = '## 1. permission 拒绝\n\n- 见 issue.update 的处理\n';
      const buffer = await FileStorageService.readUploadedFile(body);
      expect(buffer.toString('utf8')).toBe(body);
    });

    it('worker 工作区原始路径（文件引用形态）→ 读不到就报错（不被当成正文返回）', async () => {
      await expect(
        FileStorageService.readUploadedFile(
          '/data/vteam-worker/tasks/t_1/docs/a.md',
        ),
      ).rejects.toThrow();
    });

    it('形如 name.ext 的文件引用 → 读不到就报错（不被当成正文返回）', async () => {
      await expect(
        FileStorageService.readUploadedFile('docs/a.md'),
      ).rejects.toThrow();
      await expect(
        FileStorageService.readUploadedFile('a.md'),
      ).rejects.toThrow();
    });
  });

  describe('isInlineContentRef（contentRef 是内联正文还是文件引用）', () => {
    it('绝对路径 / Windows 盘符 / URL → 文件引用', () => {
      expect(FileStorageService.isInlineContentRef('/uploads/abc.md')).toBe(
        false,
      );
      expect(
        FileStorageService.isInlineContentRef('/data/workspace/a.md'),
      ).toBe(false);
      expect(FileStorageService.isInlineContentRef('C:\\ws\\a.md')).toBe(false);
      expect(
        FileStorageService.isInlineContentRef('https://x.example.com/a.md'),
      ).toBe(false);
    });

    it('带扩展名的文件名（含相对路径）→ 文件引用', () => {
      expect(FileStorageService.isInlineContentRef('a.md')).toBe(false);
      expect(FileStorageService.isInlineContentRef('docs/a.md')).toBe(false);
    });

    it('其余（多行正文 / 短句 / 中文正文）→ 内联正文', () => {
      expect(FileStorageService.isInlineContentRef('# 标题\n正文')).toBe(true);
      expect(FileStorageService.isInlineContentRef('已完成')).toBe(true);
      expect(FileStorageService.isInlineContentRef('设计稿见 design.md')).toBe(
        false,
      );
      expect(FileStorageService.isInlineContentRef('')).toBe(false);
    });
  });

  describe('describeFileRef（归一化 fileRef 派生展示元数据，FILE-02）', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('/uploads/ 引用 → name=basename + ext，size 读磁盘（文件存在）', () => {
      const spy = jest
        .spyOn(fs, 'statSync')
        .mockReturnValue({ size: 4096 } as never);
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
