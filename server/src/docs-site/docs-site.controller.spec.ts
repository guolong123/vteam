import { PrismaService } from '../prisma/prisma.service';
import { DocsMirrorService } from './docs-mirror.service';
import { DocsSiteController } from './docs-site.controller';

describe('DocsSiteController（is_0000000024 v4 深度集成：registry/prd 纯数据端点）', () => {
  let controller: DocsSiteController;
  let prisma: {
    task: { findUnique: jest.Mock };
    projectMember: { findUnique: jest.Mock };
  };
  let mirror: {
    buildRegistry: jest.Mock;
    readMirrorDoc: jest.Mock;
    listPrototypes: jest.Mock;
    readPrototype: jest.Mock;
  };

  const taskId = 't_0000000001';
  const projectId = 'p_0000000001';
  const userId = 'u_admin';
  const user = { id: userId, username: 'admin', roleId: 'r_admin' };

  beforeEach(() => {
    prisma = {
      task: { findUnique: jest.fn() },
      projectMember: { findUnique: jest.fn() },
    };
    mirror = {
      buildRegistry: jest.fn().mockResolvedValue([]),
      readMirrorDoc: jest.fn(),
      listPrototypes: jest.fn().mockResolvedValue([]),
      readPrototype: jest.fn(),
    };
    controller = new DocsSiteController(prisma as never, mirror as never);
    // 成员校验通过默认
    prisma.task.findUnique.mockResolvedValue({ projectId });
    prisma.projectMember.findUnique.mockResolvedValue({ projectId, userId });
  });

  describe('registry 数据端点', () => {
    it('成员校验通过 → 返回动态 DocDef[]（镜像 buildRegistry）', async () => {
      mirror.buildRegistry.mockResolvedValue([{ id: 'doc1', name: '文档1', file: 'doc1.md' }]);
      const result = await controller.registry(taskId, user as never);
      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: taskId },
        select: { projectId: true },
      });
      expect(prisma.projectMember.findUnique).toHaveBeenCalledWith({
        where: { projectId_userId: { projectId, userId } },
      });
      expect(result).toEqual([{ id: 'doc1', name: '文档1', file: 'doc1.md' }]);
    });

    it('任务不存在 → 404', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      const err = (await controller
        .registry(taskId, user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_TASK_NOT_FOUND');
    });

    it('非项目成员 → 403', async () => {
      prisma.projectMember.findUnique.mockResolvedValue(null);
      const err = (await controller
        .registry(taskId, user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_SITE_FORBIDDEN');
    });

    it('非法 taskId（路径穿越/非 t_ 前缀）→ 400', async () => {
      const err = (await controller
        .registry('../etc', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_PATH_OUT_OF_BOUNDS');
    });
  });

  describe('prd 内容端点', () => {
    it('成员校验通过 + 正常读取镜像内容', async () => {
      mirror.readMirrorDoc.mockResolvedValue('# 正文\n内容');
      const result = await controller.prd(taskId, 'doc-1.md', user as never);
      expect(mirror.readMirrorDoc).toHaveBeenCalledWith(taskId, 'doc-1.md');
      expect(result).toBe('# 正文\n内容');
    });

    it('文档不存在 → 404', async () => {
      mirror.readMirrorDoc.mockResolvedValue(null);
      const err = (await controller
        .prd(taskId, 'ghost.md', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_DOC_NOT_FOUND');
    });

    it('非项目成员 → 403', async () => {
      prisma.projectMember.findUnique.mockResolvedValue(null);
      const err = (await controller
        .prd(taskId, 'doc-1.md', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_SITE_FORBIDDEN');
    });
  });

  describe('prototypes 原型端点（25-原型DSL动态渲染方案）', () => {
    it('列表：成员校验通过 → { items: [{id, name, file}] }', async () => {
      mirror.listPrototypes.mockResolvedValue([
        { id: 'my-proto', name: '登录页原型', file: 'my-proto.json' },
      ]);
      const result = await controller.prototypes(taskId, user as never);
      expect(mirror.listPrototypes).toHaveBeenCalledWith(taskId);
      expect(result).toEqual({ items: [{ id: 'my-proto', name: '登录页原型', file: 'my-proto.json' }] });
    });

    it('列表：无原型 → { items: [] }', async () => {
      const result = await controller.prototypes(taskId, user as never);
      expect(result).toEqual({ items: [] });
    });

    it('列表：非项目成员 → 403', async () => {
      prisma.projectMember.findUnique.mockResolvedValue(null);
      const err = (await controller
        .prototypes(taskId, user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_SITE_FORBIDDEN');
    });

    it('内容：成员校验通过 + 正常读取 DSL JSON', async () => {
      mirror.readPrototype.mockResolvedValue('{"name":"x"}');
      const result = await controller.prototypeContent(taskId, 'my-proto.json', user as never);
      expect(mirror.readPrototype).toHaveBeenCalledWith(taskId, 'my-proto.json');
      expect(result).toBe('{"name":"x"}');
    });

    it('内容：白名单外文件名（穿越）→ 404 复用 DOCS_DOC_NOT_FOUND', async () => {
      mirror.readPrototype.mockResolvedValue(null);
      const err = (await controller
        .prototypeContent(taskId, '../../etc/passwd', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_DOC_NOT_FOUND');
    });

    it('内容：原型不存在 → 404', async () => {
      mirror.readPrototype.mockResolvedValue(null);
      const err = (await controller
        .prototypeContent(taskId, 'ghost.json', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_DOC_NOT_FOUND');
    });

    it('内容：非项目成员 → 403', async () => {
      prisma.projectMember.findUnique.mockResolvedValue(null);
      const err = (await controller
        .prototypeContent(taskId, 'my-proto.json', user as never)
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_SITE_FORBIDDEN');
    });
  });
});
