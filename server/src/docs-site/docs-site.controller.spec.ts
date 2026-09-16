import { PrismaService } from '../prisma/prisma.service';
import { PrototypesService } from './prototypes.service';
import { DocsSiteController } from './docs-site.controller';

describe('DocsSiteController（docs-artifacts-merge T11：DB-only 原型端点）', () => {
  let controller: DocsSiteController;
  let prisma: {
    task: { findUnique: jest.Mock };
    teamUserMember: { findUnique: jest.Mock };
  };
  let prototypes: {
    listPrototypes: jest.Mock;
    readPrototype: jest.Mock;
  };

  const taskId = 't_0000000001';
  const teamId = 'tm_0000000001';
  const userId = 'u_admin';
  const user = { id: userId, username: 'admin', roleId: 'r_admin' };

  beforeEach(() => {
    prisma = {
      task: { findUnique: jest.fn() },
      teamUserMember: { findUnique: jest.fn() },
    };
    prototypes = {
      listPrototypes: jest.fn().mockResolvedValue([]),
      readPrototype: jest.fn(),
    };
    controller = new DocsSiteController(prisma as never, prototypes as never);
    // 成员校验通过默认
    prisma.task.findUnique.mockResolvedValue({ teamId });
    prisma.teamUserMember.findUnique.mockResolvedValue({ teamId, userId });
  });

  describe('prototypes 原型端点（26-原型TSX动态渲染）', () => {
    it('列表：成员校验通过 → { items: [{id, name, file}] }', async () => {
      prototypes.listPrototypes.mockResolvedValue([
        { id: 'my-proto', name: '登录页原型', file: 'my-proto/index.tsx' },
      ]);
      const result = await controller.prototypes(taskId, user as never);
      expect(prototypes.listPrototypes).toHaveBeenCalledWith(taskId);
      expect(result).toEqual({
        items: [
          { id: 'my-proto', name: '登录页原型', file: 'my-proto/index.tsx' },
        ],
      });
    });

    it('列表：无原型 → { items: [] }', async () => {
      const result = await controller.prototypes(taskId, user as never);
      expect(result).toEqual({ items: [] });
    });

    it('列表：非团队成员 → 403', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      const err = (await controller
        .prototypes(taskId, user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_SITE_FORBIDDEN');
    });

    it('内容：TSX 路径 → 返回 TSX 源码', async () => {
      prototypes.readPrototype.mockResolvedValue(
        'export default function P() {}',
      );
      const result = await controller.prototypeContent(
        taskId,
        'my-proto/index.tsx',
        user as never,
      );
      expect(prototypes.readPrototype).toHaveBeenCalledWith(
        taskId,
        'my-proto/index.tsx',
      );
      expect(result).toBe('export default function P() {}');
    });

    it('内容：旧 JSON 路径 → 返回 JSON', async () => {
      prototypes.readPrototype.mockResolvedValue('{"name":"x"}');
      const result = await controller.prototypeContent(
        taskId,
        'old.json',
        user as never,
      );
      expect(prototypes.readPrototype).toHaveBeenCalledWith(taskId, 'old.json');
      expect(result).toBe('{"name":"x"}');
    });

    it('内容：白名单外文件名（穿越）→ 404 复用 DOCS_DOC_NOT_FOUND', async () => {
      prototypes.readPrototype.mockResolvedValue(null);
      const err = (await controller
        .prototypeContent(taskId, '../../etc/passwd', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_DOC_NOT_FOUND');
    });

    it('内容：原型不存在 → 404', async () => {
      prototypes.readPrototype.mockResolvedValue(null);
      const err = (await controller
        .prototypeContent(taskId, 'ghost.json', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_DOC_NOT_FOUND');
    });

    it('内容：非团队成员 → 403', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      const err = (await controller
        .prototypeContent(taskId, 'my-proto/index.tsx', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_SITE_FORBIDDEN');
    });
  });
});
