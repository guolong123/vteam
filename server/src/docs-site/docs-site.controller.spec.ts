import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PrismaService } from '../prisma/prisma.service';
import { PrototypesService } from './prototypes.service';
import {
  DocsSiteController,
  TeamPrototypesController,
} from './docs-site.controller';

describe('DocsSiteController（docs-artifacts-merge T11：DB-only 原型端点）', () => {
  let controller: DocsSiteController;
  let teamController: TeamPrototypesController;
  let prisma: {
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    teamUserMember: { findUnique: jest.Mock };
  };
  let prototypes: {
    listPrototypes: jest.Mock;
    listPrototypesByTeam: jest.Mock;
    readPrototype: jest.Mock;
  };

  const taskId = 't_0000000001';
  const teamId = 'tm_0000000001';
  const userId = 'u_admin';
  const user = { id: userId, username: 'admin', roleId: 'r_admin' };

  beforeEach(() => {
    prisma = {
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      teamUserMember: { findUnique: jest.fn() },
    };
    prototypes = {
      listPrototypes: jest.fn().mockResolvedValue([]),
      listPrototypesByTeam: jest.fn().mockResolvedValue([]),
      readPrototype: jest.fn(),
    };
    controller = new DocsSiteController(prisma as never, prototypes as never);
    teamController = new TeamPrototypesController(
      prisma as never,
      prototypes as never,
    );
    // 成员校验通过默认
    prisma.task.findUnique.mockResolvedValue({ teamId });
    prisma.team.findUnique.mockResolvedValue({ id: teamId });
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

  describe('GET /teams/:id/prototypes（T15 团队级原型聚合）', () => {
    it('成员直通：团队存在 + 成员 → 转发 listPrototypesByTeam 并回 { items }', async () => {
      prototypes.listPrototypesByTeam.mockResolvedValue([
        {
          id: 'login',
          name: '登录页',
          file: 'login/index.tsx',
          artifactId: 'art_1',
          taskId: 't_0000000001',
          taskName: '任务一',
        },
        {
          id: 'pay',
          name: '支付页',
          file: 'pay/index.tsx',
          artifactId: 'art_2',
          taskId: 't_0000000002',
          taskName: '任务二',
        },
      ]);
      const result = await teamController.teamPrototypes(teamId, user as never);
      expect(prototypes.listPrototypesByTeam).toHaveBeenCalledWith(teamId);
      expect(result).toEqual({
        items: [
          {
            id: 'login',
            name: '登录页',
            file: 'login/index.tsx',
            artifactId: 'art_1',
            taskId: 't_0000000001',
            taskName: '任务一',
          },
          {
            id: 'pay',
            name: '支付页',
            file: 'pay/index.tsx',
            artifactId: 'art_2',
            taskId: 't_0000000002',
            taskName: '任务二',
          },
        ],
      });
    });

    it('空团队 → { items: [] }', async () => {
      const result = await teamController.teamPrototypes(teamId, user as never);
      expect(result).toEqual({ items: [] });
    });

    it('未知团队 → 404 TEAM_NOT_FOUND（不调 service）', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      const err = (await teamController
        .teamPrototypes('tm_missing', user as never)
        .catch((e: unknown) => e)) as {
        status?: number;
        response?: { code?: string };
      };
      expect(err.status).toBe(404);
      expect(err.response?.code).toBe('TEAM_NOT_FOUND');
      expect(prototypes.listPrototypesByTeam).not.toHaveBeenCalled();
    });

    it('非成员 → 403 PERMISSION_TEAM_NOT_MEMBER（不调 service）', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      const err = (await teamController
        .teamPrototypes(teamId, user as never)
        .catch((e: unknown) => e)) as {
        status?: number;
        response?: { code?: string };
      };
      expect(err.status).toBe(403);
      expect(err.response?.code).toBe('PERMISSION_TEAM_NOT_MEMBER');
      expect(prototypes.listPrototypesByTeam).not.toHaveBeenCalled();
    });

    it('路由注册：裸挂载 GET teams/:id/prototypes（与 artifacts 团队路由同形）', () => {
      expect(Reflect.getMetadata(PATH_METADATA, TeamPrototypesController)).toBe(
        '/',
      );
      expect(
        Reflect.getMetadata(PATH_METADATA, teamController.teamPrototypes),
      ).toBe('teams/:id/prototypes');
      expect(
        Reflect.getMetadata(METHOD_METADATA, teamController.teamPrototypes),
      ).toBe(RequestMethod.GET);
    });
  });
});
