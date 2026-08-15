import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocsMirrorService } from './docs-mirror.service';

describe('DocsMirrorService（is_0000000024 F1 镜像导出层）', () => {
  let service: DocsMirrorService;
  let root: string;
  let prisma: {
    artifactVersion: { findMany: jest.Mock };
    task: { findMany: jest.Mock };
  };

  const taskId = 't_0000000001';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-mirror-'));
    prisma = {
      artifactVersion: { findMany: jest.fn() },
      task: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new DocsMirrorService(prisma as never, {
      get: (k: string) => (k === 'MD_DOCS_ROOT' ? root : undefined),
    } as never);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('syncTask', () => {
    it('doc 产出物当前版本 → 写镜像 <root>/<taskId>/<slug>.md（纯正文，无 frontmatter）', async () => {
      // 写一个 uploads 文件（模拟 saveTextFile 落盘）
      const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-mirror-uploads-'));
      const file = path.join(uploadsDir, 'uuid-1.md');
      fs.writeFileSync(file, '# 需求文档\n正文内容');
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          version: 2,
          contentRef: `/uploads/uuid-1.md`,
          artifact: { id: 'art_1', title: '需求文档', currentVersion: 2 },
        },
        // 历史版本（非当前）不入站
        {
          version: 1,
          contentRef: `/uploads/uuid-0.md`,
          artifact: { id: 'art_1', title: '需求文档', currentVersion: 2 },
        },
      ]);
      // 让 readUploadedFile 读到 uploads 文件：mock resolveUploadDir 指向临时目录不现实，
      // 改为直接构造 /uploads 读取——这里通过 spy 覆盖 readUploadedFile
      const readSpy = jest
        .spyOn(require('../uploads/uploads.service').FileStorageService, 'readUploadedFile')
        .mockImplementation(async (ref: string) => {
          const base = ref.split('/').pop();
          return fs.promises.readFile(path.join(uploadsDir, base as string));
        });
      try {
        await service.syncTask(taskId);
        // docIdFor('需求文档', 'art_1') → slug='doc'（弱）→ 追加 artifact 后缀 → 'doc-art1'
        const expected = path.join(root, taskId, 'doc-art1.md');
        expect(fs.existsSync(expected)).toBe(true);
        const content = fs.readFileSync(expected, 'utf8');
        expect(content).toBe('# 需求文档\n正文内容');
        // 无 frontmatter（原型工具不剥离，注册表提供元数据）
        expect(content).not.toMatch(/^---/);
      } finally {
        readSpy.mockRestore();
        fs.rmSync(uploadsDir, { recursive: true, force: true });
      }
    });

    it('toSlug / docIdFor：中文 → 兜底 + artifact 后缀，英文 → ASCII slug', () => {
      expect(service.toSlug('需求文档')).toBe('doc');
      expect(service.toSlug('Architecture Design')).toBe('architecture-design');
      expect(service.toSlug('')).toBe('doc');
      expect(service.docIdFor('需求文档', 'art_1')).toBe('doc-art1');
      expect(service.docIdFor('Architecture', 'art_2')).toBe('architecture');
    });

    it('text/file 产出物不入镜像（只处理 type=doc 的当前版本）', async () => {
      // 无 doc 产出物 → 镜像目录为空
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      await service.syncTask(taskId);
      const dir = path.join(root, taskId);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.readdirSync(dir)).toHaveLength(0);
    });
  });

  describe('readMirrorDoc', () => {
    it('白名单外文件名（路径穿越）→ null', async () => {
      await expect(service.readMirrorDoc(taskId, '../../etc/passwd')).resolves.toBeNull();
      await expect(service.readMirrorDoc(taskId, 'a/b.md')).resolves.toBeNull();
      await expect(service.readMirrorDoc(taskId, '中文.md')).resolves.toBeNull();
    });

    it('合法文件名且文件存在 → 返回内容', async () => {
      const dir = path.join(root, taskId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'doc.md'), '# hello');
      const content = await service.readMirrorDoc(taskId, 'doc.md');
      expect(content).toBe('# hello');
    });

    it('文件不存在 → null', async () => {
      await expect(service.readMirrorDoc(taskId, 'ghost.md')).resolves.toBeNull();
    });
  });

  describe('buildRegistry', () => {
    it('仅当前版本 doc 产出物 → DocDef[]（id=slug、file=<slug>.md、name=title）', async () => {
      prisma.artifactVersion.findMany.mockResolvedValue([
        { version: 2, contentRef: '/uploads/uuid-1.md', artifact: { id: 'art_1', title: '需求文档', currentVersion: 2 } },
        { version: 1, contentRef: '/uploads/uuid-0.md', artifact: { id: 'art_1', title: '需求文档', currentVersion: 2 } },
        { version: 1, contentRef: '/uploads/uuid-2.md', artifact: { id: 'art_2', title: 'Architecture', currentVersion: 1 } },
        // file 型非 .md 不入站
        { version: 1, contentRef: '/uploads/uuid-3.png', artifact: { id: 'art_3', title: '截图', currentVersion: 1 } },
      ]);
      const registry = await service.buildRegistry(taskId);
      expect(registry).toHaveLength(2);
      expect(registry[0]).toMatchObject({ id: 'doc-art1', name: '需求文档', file: 'doc-art1.md' });
      expect(registry[1]).toMatchObject({ id: 'architecture', name: 'Architecture', file: 'architecture.md' });
    });
  });
});
