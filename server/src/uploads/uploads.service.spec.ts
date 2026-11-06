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
    it('UUID 前缀 + 嵌入原始名（下载不再是一串编号）', () => {
      const name = FileStorageService.generateFilename('报告.PDF');
      expect(name).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__报告\.pdf$/,
      );
      // 还原 → 人类可读名
      expect(FileStorageService.displayNameFromStored(name)).toBe('报告.pdf');
    });

    it('无扩展名 → UUID + 原始名', () => {
      const name = FileStorageService.generateFilename('README');
      expect(name).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__README$/,
      );
    });

    it('路径穿越 / 隐藏文件 / 控制字符被清洗（只留 basename）', () => {
      const name = FileStorageService.generateFilename(
        '../../etc/pa\u0000sswd.docx',
      );
      expect(name).not.toContain('/');
      expect(name).not.toContain('..');
      expect(FileStorageService.displayNameFromStored(name)).toBe(
        'passwd.docx',
      );
      // 纯点开头被剥掉
      const hidden = FileStorageService.generateFilename('.env');
      expect(FileStorageService.displayNameFromStored(hidden)).toBe('env');
    });

    it('超长名按字节封顶（不会 ENAMETOOLONG）', () => {
      const long = `${'长'.repeat(200)}.docx`;
      const name = FileStorageService.generateFilename(long);
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThan(200);
      expect(name.endsWith('.docx')).toBe(true);
    });

    it('buildDownloadDisposition：中文原名进 filename*（RFC 5987），ASCII 兜底不留乱码', () => {
      const uuid = 'f8a2173c-3924-461d-b927-c4151f71756b';
      const header = FileStorageService.buildDownloadDisposition(
        `${uuid}__PR3359 回归测试报告 v8.1.docx`,
      );
      expect(header.startsWith('attachment; filename="')).toBe(true);
      // filename* 是 UTF-8 百分号编码 → 解码回来就是原始名
      const encoded = header.split("filename*=UTF-8''")[1];
      expect(decodeURIComponent(encoded)).toBe('PR3359 回归测试报告 v8.1.docx');
      // 兜底名必须是纯 ASCII（不能把中文直接塞进 filename=）
      const fallback = header.match(/filename="([^"]*)"/)?.[1] ?? '';
      // eslint-disable-next-line no-control-regex
      expect(fallback).toMatch(/^[\x20-\x7e]*$/);
    });

    it('buildDownloadDisposition：引号/括号等特殊字符不破坏头部', () => {
      const uuid = 'f8a2173c-3924-461d-b927-c4151f71756b';
      const header = FileStorageService.buildDownloadDisposition(
        `${uuid}__a"b(c).txt`,
      );
      // filename= 里不能出现裸引号
      expect(header).toContain('attachment; filename=');
      expect(header.match(/filename="([^"]*)"/)?.[1]).not.toContain('"');
      const encoded = header.split("filename*=UTF-8''")[1];
      expect(decodeURIComponent(encoded)).toBe('a"b(c).txt');
      expect(encoded).not.toContain('(');
    });

    it('displayNameFromStored 兼容老文件（纯 UUID 名原样返回）', () => {
      expect(
        FileStorageService.displayNameFromStored(
          'f8a2173c-3924-461d-b927-c4151f71756b.docx',
        ),
      ).toBe('f8a2173c-3924-461d-b927-c4151f71756b.docx');
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

    it('generateFilename 取 latin1 错位文件名的扩展名仍正确、原始名修复后嵌入磁盘名', () => {
      const garbled = Buffer.from('压缩包.zip', 'utf8').toString('latin1');
      const filename = FileStorageService.generateFilename(garbled);
      // 修复 latin1 错位后，原始名（含中文）嵌在 `<uuid>__` 之后
      expect(FileStorageService.displayNameFromStored(filename)).toBe(
        '压缩包.zip',
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
