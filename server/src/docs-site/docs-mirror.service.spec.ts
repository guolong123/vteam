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
      artifactVersion: { findMany: jest.fn().mockResolvedValue([]) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new DocsMirrorService(
      prisma as never,
      {
        get: (k: string) => (k === 'MD_DOCS_ROOT' ? root : undefined),
      } as never,
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('syncTask', () => {
    it('doc 产出物当前版本 → 写镜像 <root>/<taskId>/<slug>.md（纯正文，无 frontmatter）', async () => {
      // 写一个 uploads 文件（模拟 saveTextFile 落盘）
      const uploadsDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'docs-mirror-uploads-'),
      );
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
        .spyOn(
          require('../uploads/uploads.service').FileStorageService,
          'readUploadedFile',
        )
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

  describe('prototype.json 原型镜像（25-原型DSL动态渲染方案）', () => {
    const uploadsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'docs-mirror-protos-'),
    );

    afterEach(() => {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    });

    function mockUploads(entries: Array<{ ref: string; body: string }>) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      for (const e of entries) {
        fs.writeFileSync(
          path.join(uploadsDir, e.ref.split('/').pop() as string),
          e.body,
        );
      }
      prisma.artifactVersion.findMany.mockResolvedValue(
        entries.map((e, i) => ({
          version: 1,
          contentRef: e.ref,
          artifact: {
            id: `art_proto_${i}`,
            title: `原型${i}`,
            currentVersion: 1,
          },
        })),
      );
      return jest
        .spyOn(
          require('../uploads/uploads.service').FileStorageService,
          'readUploadedFile',
        )
        .mockImplementation(async (ref: string) => {
          const base = ref.split('/').pop();
          return fs.promises.readFile(path.join(uploadsDir, base as string));
        });
    }

    it('file 型 *.prototype.json → 写 <root>/<taskId>/prototypes/<文件名去后缀>.json（原文镜像）', async () => {
      const spy = mockUploads([
        {
          ref: '/uploads/my-proto.prototype.json',
          body: '{"id":"my-proto","name":"登录页原型"}',
        },
      ]);
      try {
        await service.syncTask(taskId);
        const file = path.join(root, taskId, 'prototypes', 'my-proto.json');
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toBe(
          '{"id":"my-proto","name":"登录页原型"}',
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('重建时清理旧 prototypes（与 .md 一致：整目录删除重建）', async () => {
      const spy = mockUploads([
        { ref: '/uploads/a.prototype.json', body: '{"name":"A"}' },
      ]);
      try {
        await service.syncTask(taskId);
        expect(
          fs.existsSync(path.join(root, taskId, 'prototypes', 'a.json')),
        ).toBe(true);
        // 模拟已删除产出物：再次同步无原型 → 旧原型文件被清掉
        spy.mockRestore();
        prisma.artifactVersion.findMany.mockResolvedValue([]);
        await service.syncTask(taskId);
        expect(
          fs.existsSync(path.join(root, taskId, 'prototypes', 'a.json')),
        ).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('非 *.prototype.json（.md / 普通 .json / 图片）不写入 prototypes', async () => {
      const spy = mockUploads([
        { ref: '/uploads/normal.json', body: '{"a":1}' },
        { ref: '/uploads/pic.png', body: 'x' },
      ]);
      try {
        await service.syncTask(taskId);
        const protoDir = path.join(root, taskId, 'prototypes');
        expect(fs.existsSync(protoDir)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('原型与 .md 镜像共存于 <root>/<taskId>/ 下', async () => {
      const spy = mockUploads([
        { ref: '/uploads/guide.md', body: '# 说明' },
        { ref: '/uploads/dash.prototype.json', body: '{"name":"Dashboard"}' },
      ]);
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          version: 1,
          contentRef: '/uploads/guide.md',
          artifact: { id: 'art_md', title: 'Guide', currentVersion: 1 },
        },
        {
          version: 1,
          contentRef: '/uploads/dash.prototype.json',
          artifact: { id: 'art_p', title: 'Dash', currentVersion: 1 },
        },
      ]);
      try {
        await service.syncTask(taskId);
        const dir = path.join(root, taskId);
        expect(fs.existsSync(path.join(dir, 'guide.md'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'prototypes', 'dash.json'))).toBe(
          true,
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('TSX 原型镜像（26-原型TSX动态渲染）', () => {
    const uploadsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'docs-mirror-tsx-'),
    );

    afterEach(() => {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    });

    function mockUploads(entries: Array<{ ref: string; body: string }>) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      for (const e of entries) {
        fs.writeFileSync(
          path.join(uploadsDir, e.ref.split('/').pop() as string),
          e.body,
        );
      }
      prisma.artifactVersion.findMany.mockResolvedValue(
        entries.map((e, i) => ({
          version: 1,
          contentRef: e.ref,
          artifact: {
            id: `art_tsx_${i}`,
            title: `TSX原型${i}`,
            currentVersion: 1,
          },
        })),
      );
      return jest
        .spyOn(
          require('../uploads/uploads.service').FileStorageService,
          'readUploadedFile',
        )
        .mockImplementation(async (ref: string) => {
          const base = ref.split('/').pop();
          return fs.promises.readFile(path.join(uploadsDir, base as string));
        });
    }

    it('file 型 *.tsx → 写 <root>/<taskId>/prototypes/<slug>/index.tsx', async () => {
      const tsxContent =
        'export const meta = { name: "登录页" };\nexport default function Login() { return <div>Login</div>; }';
      const spy = mockUploads([
        { ref: '/uploads/login-page.tsx', body: tsxContent },
      ]);
      try {
        await service.syncTask(taskId);
        const file = path.join(
          root,
          taskId,
          'prototypes',
          'login-page',
          'index.tsx',
        );
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toBe(tsxContent);
      } finally {
        spy.mockRestore();
      }
    });

    it('TSX 与 .md 和旧 DSL JSON 共存', async () => {
      const spy = mockUploads([
        { ref: '/uploads/guide.md', body: '# Guide' },
        {
          ref: '/uploads/dashboard.tsx',
          body: 'export default function Dash() { return <div/>; }',
        },
        { ref: '/uploads/old-proto.prototype.json', body: '{"name":"Old"}' },
      ]);
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          version: 1,
          contentRef: '/uploads/guide.md',
          artifact: { id: 'art_md', title: 'Guide', currentVersion: 1 },
        },
        {
          version: 1,
          contentRef: '/uploads/dashboard.tsx',
          artifact: { id: 'art_tsx', title: 'Dash', currentVersion: 1 },
        },
        {
          version: 1,
          contentRef: '/uploads/old-proto.prototype.json',
          artifact: { id: 'art_old', title: 'Old', currentVersion: 1 },
        },
      ]);
      try {
        await service.syncTask(taskId);
        const dir = path.join(root, taskId);
        expect(fs.existsSync(path.join(dir, 'guide.md'))).toBe(true);
        expect(
          fs.existsSync(path.join(dir, 'prototypes', 'dashboard', 'index.tsx')),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(dir, 'prototypes', 'old-proto.json')),
        ).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('重建时清理旧 TSX 原型目录', async () => {
      const spy = mockUploads([{ ref: '/uploads/a.tsx', body: '<div/>' }]);
      try {
        await service.syncTask(taskId);
        expect(
          fs.existsSync(
            path.join(root, taskId, 'prototypes', 'a', 'index.tsx'),
          ),
        ).toBe(true);
        spy.mockRestore();
        prisma.artifactVersion.findMany.mockResolvedValue([]);
        await service.syncTask(taskId);
        expect(fs.existsSync(path.join(root, taskId, 'prototypes', 'a'))).toBe(
          false,
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('listPrototypes / readPrototype（T6 DB 直读：artifactVersion + readUploadedFile）', () => {
    function mockProtoRows(
      entries: Array<{
        ref: string;
        body: string;
        artifactId?: string;
        title?: string;
        version?: number;
        currentVersion?: number;
      }>,
    ) {
      prisma.artifactVersion.findMany.mockResolvedValue(
        entries.map((e, i) => ({
          version: e.version ?? 1,
          contentRef: e.ref,
          artifact: {
            id: e.artifactId ?? `art_proto_${i}`,
            title: e.title ?? `原型${i}`,
            currentVersion: e.currentVersion ?? 1,
          },
        })),
      );
      const bodies = new Map(entries.map((e) => [e.ref, e.body]));
      return jest
        .spyOn(
          require('../uploads/uploads.service').FileStorageService,
          'readUploadedFile',
        )
        .mockImplementation(async (ref: string) => {
          const body = bodies.get(ref);
          if (body === undefined) {
            throw new Error(`ENOENT: ${ref}`);
          }
          return Buffer.from(body, 'utf8');
        });
    }

    it('listPrototypes：无原型行 → 空数组', async () => {
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      expect(await service.listPrototypes(taskId)).toEqual([]);
    });

    it('listPrototypes：TSX 行 → [{id, name, file: "<slug>/index.tsx", artifactId}]（name 从 meta 导出）', async () => {
      const spy = mockProtoRows([
        {
          ref: '/uploads/login.tsx',
          body: 'export const meta = { name: "登录页" };\nexport default function Login() {}',
          artifactId: 'art_tsx_0',
          title: '登录页原型',
        },
      ]);
      try {
        expect(await service.listPrototypes(taskId)).toEqual([
          {
            id: 'login',
            metaId: undefined,
            name: '登录页',
            file: 'login/index.tsx',
            artifactId: 'art_tsx_0',
          },
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('listPrototypes：TSX meta 含 id → metaId 透出', async () => {
      const spy = mockProtoRows([
        {
          ref: '/uploads/p1.tsx',
          body: 'export const meta = { id: "p1", name: "P1" };',
          artifactId: 'art_tsx_1',
          title: 'P1',
        },
      ]);
      try {
        expect(await service.listPrototypes(taskId)).toEqual([
          {
            id: 'p1',
            metaId: 'p1',
            name: 'P1',
            file: 'p1/index.tsx',
            artifactId: 'art_tsx_1',
          },
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('listPrototypes：TSX 行无 meta 导出 → name 回退 slug', async () => {
      const spy = mockProtoRows([
        {
          ref: '/uploads/dash.tsx',
          body: 'export default function Dash() {}',
          artifactId: 'art_tsx_2',
          title: 'Dash',
        },
      ]);
      try {
        expect(await service.listPrototypes(taskId)).toEqual([
          {
            id: 'dash',
            metaId: undefined,
            name: 'dash',
            file: 'dash/index.tsx',
            artifactId: 'art_tsx_2',
          },
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('listPrototypes：TSX uploads 读取失败 → 仍列出 slug 兜底', async () => {
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          version: 1,
          contentRef: '/uploads/gone.tsx',
          artifact: { id: 'art_gone', title: 'Gone', currentVersion: 1 },
        },
      ]);
      const spy = jest
        .spyOn(
          require('../uploads/uploads.service').FileStorageService,
          'readUploadedFile',
        )
        .mockRejectedValue(new Error('ENOENT'));
      try {
        expect(await service.listPrototypes(taskId)).toEqual([
          {
            id: 'gone',
            metaId: undefined,
            name: 'gone',
            file: 'gone/index.tsx',
            artifactId: 'art_gone',
          },
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('listPrototypes：TSX + 旧 JSON 共存 → 合并列表并排序', async () => {
      const spy = mockProtoRows([
        {
          ref: '/uploads/alpha.tsx',
          body: 'export const meta = { name: "Alpha" }',
          artifactId: 'art_alpha',
          title: 'Alpha',
        },
        {
          ref: '/uploads/beta.prototype.json',
          body: '{"name":"Beta"}',
          artifactId: 'art_beta',
          title: 'Beta',
        },
      ]);
      try {
        const items = await service.listPrototypes(taskId);
        expect(items).toEqual([
          {
            id: 'alpha',
            metaId: undefined,
            name: 'Alpha',
            file: 'alpha/index.tsx',
            artifactId: 'art_alpha',
          },
          { id: 'beta', name: 'Beta', file: 'beta.json', artifactId: 'art_beta' },
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('listPrototypes：非当前版本 / 非原型后缀行被忽略', async () => {
      const spy = mockProtoRows([
        {
          ref: '/uploads/old.tsx',
          body: 'export const meta = { name: "Old" }',
          artifactId: 'art_old',
          title: 'Old',
          version: 1,
          currentVersion: 2,
        },
        {
          ref: '/uploads/guide.md',
          body: '# Guide',
          artifactId: 'art_md',
          title: 'Guide',
        },
        {
          ref: '/uploads/pic.png',
          body: 'x',
          artifactId: 'art_png',
          title: 'Pic',
        },
      ]);
      try {
        expect(await service.listPrototypes(taskId)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('listPrototypes：旧 JSON 解析失败 → 跳过该行', async () => {
      const spy = mockProtoRows([
        {
          ref: '/uploads/bad.prototype.json',
          body: 'not-json{{{',
          artifactId: 'art_bad',
          title: 'Bad',
        },
      ]);
      try {
        expect(await service.listPrototypes(taskId)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('readPrototype：TSX 路径 <slug>/index.tsx → 返回 uploads 字节', async () => {
      const spy = mockProtoRows([
        {
          ref: '/uploads/my-proto.tsx',
          body: 'export default function P() {}',
          artifactId: 'art_p',
          title: 'MyProto',
        },
      ]);
      try {
        expect(await service.readPrototype(taskId, 'my-proto/index.tsx')).toBe(
          'export default function P() {}',
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('readPrototype：旧 JSON 路径 <slug>.json → 返回 uploads 字节', async () => {
      const spy = mockProtoRows([
        {
          ref: '/uploads/old-proto.prototype.json',
          body: '{"name":"x"}',
          artifactId: 'art_old',
          title: 'Old',
        },
      ]);
      try {
        expect(await service.readPrototype(taskId, 'old-proto.json')).toBe(
          '{"name":"x"}',
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('readPrototype：uploads 缺失 → null', async () => {
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          version: 1,
          contentRef: '/uploads/gone.tsx',
          artifact: { id: 'art_gone', title: 'Gone', currentVersion: 1 },
        },
      ]);
      const spy = jest
        .spyOn(
          require('../uploads/uploads.service').FileStorageService,
          'readUploadedFile',
        )
        .mockRejectedValue(new Error('ENOENT'));
      try {
        expect(await service.readPrototype(taskId, 'gone/index.tsx')).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('readPrototype：白名单外文件名（路径穿越）→ null', async () => {
      await expect(
        service.readPrototype(taskId, '../../etc/passwd'),
      ).resolves.toBeNull();
      await expect(
        service.readPrototype(taskId, 'a/b/c.json'),
      ).resolves.toBeNull();
      await expect(
        service.readPrototype(taskId, '中文.json'),
      ).resolves.toBeNull();
      await expect(
        service.readPrototype(taskId, '../x/index.tsx'),
      ).resolves.toBeNull();
    });

    it('readPrototype：合法路径无 DB 行 → null', async () => {
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      expect(await service.readPrototype(taskId, 'ghost/index.tsx')).toBeNull();
      expect(await service.readPrototype(taskId, 'ghost.json')).toBeNull();
    });
  });

  describe('readMirrorDoc', () => {
    it('白名单外文件名（路径穿越）→ null', async () => {
      await expect(
        service.readMirrorDoc(taskId, '../../etc/passwd'),
      ).resolves.toBeNull();
      await expect(service.readMirrorDoc(taskId, 'a/b.md')).resolves.toBeNull();
      await expect(
        service.readMirrorDoc(taskId, '中文.md'),
      ).resolves.toBeNull();
    });

    it('合法文件名且文件存在 → 返回内容', async () => {
      const dir = path.join(root, taskId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'doc.md'), '# hello');
      const content = await service.readMirrorDoc(taskId, 'doc.md');
      expect(content).toBe('# hello');
    });

    it('文件不存在 → null', async () => {
      await expect(
        service.readMirrorDoc(taskId, 'ghost.md'),
      ).resolves.toBeNull();
    });
  });

  describe('buildRegistry', () => {
    it('当前版本产出物全入注册表 → DocDef[]（md 直渲、png 附 fileExt/fileUrl）', async () => {
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          version: 2,
          contentRef: '/uploads/uuid-1.md',
          artifact: { id: 'art_1', title: '需求文档', currentVersion: 2 },
        },
        {
          version: 1,
          contentRef: '/uploads/uuid-0.md',
          artifact: { id: 'art_1', title: '需求文档', currentVersion: 2 },
        },
        {
          version: 1,
          contentRef: '/uploads/uuid-2.md',
          artifact: { id: 'art_2', title: 'Architecture', currentVersion: 1 },
        },
        // 非 md 文件同样入注册表（附 fileExt/fileUrl 供前端决定渲染/下载）
        {
          version: 1,
          contentRef: '/uploads/uuid-3.png',
          artifact: { id: 'art_3', title: '截图', currentVersion: 1 },
        },
      ]);
      const registry = await service.buildRegistry(taskId);
      expect(registry).toHaveLength(3);
      expect(registry[0]).toMatchObject({
        id: 'doc-art1',
        name: '需求文档',
        file: 'doc-art1.md',
      });
      expect(registry[0]).not.toHaveProperty('fileExt');
      expect(registry[0]).not.toHaveProperty('fileUrl');
      expect(registry[1]).toMatchObject({
        id: 'architecture',
        name: 'Architecture',
        file: 'architecture.md',
      });
      expect(registry[1]).not.toHaveProperty('fileExt');
      expect(registry[2]).toMatchObject({
        id: 'doc-art3',
        name: '截图',
        kind: '任务产出物',
        file: 'doc-art3',
        order: 3,
        artifactId: 'art_3',
        fileExt: 'png',
        fileUrl: '/uploads/uuid-3.png',
      });
    });
  });
});
