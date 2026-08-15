import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { DocsMirrorService } from './docs-mirror.service';
import {
  DOCS_SITE_COOKIE,
  DocsSiteController,
} from './docs-site.controller';

describe('DocsSiteController（is_0000000024 F4+F2 鉴权代理）', () => {
  let controller: DocsSiteController;
  let prisma: {
    task: { findUnique: jest.Mock };
    projectMember: { findUnique: jest.Mock };
  };
  let jwt: { verifyAsync: jest.Mock };
  let mirror: {
    buildRegistry: jest.Mock;
    readMirrorDoc: jest.Mock;
  };

  const taskId = 't_0000000001';
  const projectId = 'p_0000000001';
  const userId = 'u_admin';
  const accessToken = 'jwt-access-token';
  const validPayload = { sub: userId, type: 'access' };

  const reqWithHeader = (token: string) =>
    ({ headers: { authorization: `Bearer ${token}` }, cookies: {} }) as never;
  const reqWithCookie = (token: string) =>
    ({ headers: {}, cookies: { [DOCS_SITE_COOKIE]: token } }) as never;
  const reqEmpty = () => ({ headers: {}, cookies: {} }) as never;
  const resMock = () => {
    const res: Record<string, jest.Mock> = {
      setHeader: jest.fn(),
      redirect: jest.fn(),
      send: jest.fn(),
      status: jest.fn().mockReturnThis(),
      set: jest.fn(),
    };
    return res as never;
  };

  beforeEach(() => {
    prisma = {
      task: { findUnique: jest.fn() },
      projectMember: { findUnique: jest.fn() },
    };
    jwt = { verifyAsync: jest.fn() };
    mirror = {
      buildRegistry: jest.fn().mockResolvedValue([]),
      readMirrorDoc: jest.fn(),
    };
    controller = new DocsSiteController(
      prisma as never,
      jwt as never,
      mirror as never,
      { get: (k: string) => (k === 'MD_DOCS_MODE' ? 'dev' : 'http://127.0.0.1:5173') } as never,
    );
    // 鉴权通过默认
    jwt.verifyAsync.mockResolvedValue(validPayload);
    prisma.task.findUnique.mockResolvedValue({ projectId });
    prisma.projectMember.findUnique.mockResolvedValue({ projectId, userId });
  });

  describe('鉴权（art_0000000030 v3：query token 换 cookie）', () => {
    it('首跳带 query token：校验通过 → Set-Cookie(httpOnly/短TTL) + 302 去 token 到干净 URL', async () => {
      const res = resMock();
      await controller.shell(taskId, accessToken, taskId, reqEmpty(), res);

      expect(jwt.verifyAsync).toHaveBeenCalledWith(accessToken, expect.anything());
      // Set-Cookie：httpOnly + SameSite=Lax + 短 TTL（15min → 900s Max-Age）
      const setCookie = (res as Record<string, jest.Mock>).setHeader.mock.calls[0][1] as string;
      expect(setCookie).toContain(`${DOCS_SITE_COOKIE}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Max-Age=900');
      // 302 到干净 URL（无 token query）
      expect((res as Record<string, jest.Mock>).redirect).toHaveBeenCalledWith(
        302,
        `/docs-site/${taskId}/?task=${taskId}`,
      );
    });

    it('cookie 就位：registry 从 cookie 鉴权通过，不校验 query token', async () => {
      mirror.buildRegistry.mockResolvedValue([{ id: 'doc1', name: '文档1' }]);
      const result = await controller.registry(taskId, reqWithCookie(accessToken));
      expect(jwt.verifyAsync).toHaveBeenCalledWith(accessToken, expect.anything());
      expect(prisma.projectMember.findUnique).toHaveBeenCalledWith({
        where: { projectId_userId: { projectId, userId } },
      });
      expect(result).toEqual([{ id: 'doc1', name: '文档1' }]);
    });

    it('Authorization 头优先（API 直调）', async () => {
      mirror.readMirrorDoc.mockResolvedValue('# 内容');
      const result = await controller.prd(taskId, 'a.md', reqWithHeader(accessToken));
      expect(jwt.verifyAsync).toHaveBeenCalledWith(accessToken, expect.anything());
      expect(result).toBe('# 内容');
    });

    it('无任何凭证 → 401', async () => {
      await expect(controller.registry(taskId, reqEmpty())).rejects.toThrow();
      const err: { response?: { code?: string } } = await controller
        .registry(taskId, reqEmpty())
        .catch((e: unknown) => e as { response?: { code?: string } });
      expect(err.response?.code).toBe('AUTH_UNAUTHORIZED');
    });

    it('token 校验失败 → 401', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('invalid'));
      await expect(controller.registry(taskId, reqWithCookie('bad'))).rejects.toThrow();
    });

    it('refresh token → 401（仅接受 access）', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: userId, type: 'refresh' });
      const err: { response?: { code?: string } } = await controller
        .registry(taskId, reqWithCookie(accessToken))
        .catch((e: unknown) => e as { response?: { code?: string } });
      expect(err.response?.code).toBe('AUTH_UNAUTHORIZED');
    });

    it('任务不存在 → 404', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      const err: { response?: { code?: string } } = await controller
        .registry(taskId, reqWithCookie(accessToken))
        .catch((e: unknown) => e as { response?: { code?: string } });
      expect(err.response?.code).toBe('DOCS_TASK_NOT_FOUND');
    });

    it('非项目成员 → 403', async () => {
      prisma.projectMember.findUnique.mockResolvedValue(null);
      const err: { response?: { code?: string } } = await controller
        .registry(taskId, reqWithCookie(accessToken))
        .catch((e: unknown) => e as { response?: { code?: string } });
      expect(err.response?.code).toBe('DOCS_SITE_FORBIDDEN');
    });

    it('非法 taskId（路径穿越/非 t_ 前缀）→ 400', async () => {
      const err: { response?: { code?: string } } = await controller
        .registry('../etc', reqWithCookie(accessToken))
        .catch((e: unknown) => e as { response?: { code?: string } });
      expect(err.response?.code).toBe('DOCS_PATH_OUT_OF_BOUNDS');
    });
  });

  describe('prd 内容端点', () => {
    it('文档不存在 → 404', async () => {
      mirror.readMirrorDoc.mockResolvedValue(null);
      const err: { response?: { code?: string } } = (await controller
        .prd(taskId, 'ghost.md', reqWithCookie(accessToken))
        .catch((e: unknown) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe('DOCS_DOC_NOT_FOUND');
    });

    it('正常读取镜像内容', async () => {
      mirror.readMirrorDoc.mockResolvedValue('# 正文\n内容');
      const result = await controller.prd(taskId, 'doc-1.md', reqWithCookie(accessToken));
      expect(mirror.readMirrorDoc).toHaveBeenCalledWith(taskId, 'doc-1.md');
      expect(result).toBe('# 正文\n内容');
    });
  });
});
