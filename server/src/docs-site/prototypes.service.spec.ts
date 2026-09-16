import { PrototypesService } from './prototypes.service';

describe('PrototypesService（docs-artifacts-merge T11：DB 直读原型，artifactVersion + readUploadedFile）', () => {
  let service: PrototypesService;
  let prisma: {
    artifactVersion: { findMany: jest.Mock };
  };

  const taskId = 't_0000000001';

  beforeEach(() => {
    prisma = {
      artifactVersion: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new PrototypesService(prisma as never);
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
});
