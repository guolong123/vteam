import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { JWT_TOKEN_TYPE } from '../auth/auth.constants';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  DOCS_SITE_ERRORS,
  DOCS_SITE_MODES,
  DocsSiteMode,
  resolveDocsRoot,
} from './docs-site.constants';
import { DocsMirrorService } from './docs-mirror.service';

/** docs-site 会话 cookie 名（httpOnly，短 TTL，仅存 docs-site 域内）。 */
export const DOCS_SITE_COOKIE = 'docs_site_token';

/** 一次性 query token 换 cookie 后的重定向目标（去 token 的干净 URL）。 */
const SHELL_CLEAN_PATH = '/docs-site/';

/** query token 换 cookie 的 cookie TTL（毫秒，15min，安全窗口）。 */
const DOCS_SITE_COOKIE_TTL_MS = 15 * 60 * 1000;

/**
 * F4+F2 文档站端点（is_0000000024 · art_0000000030 v3 安全模式）。
 *
 * 鉴权（一次性 token → httpOnly cookie）：
 * - 工具经整页导航进入（F3 壳 `/docs-site/:taskId/?task=<taskId>&token=<jwt>`，
 *   浏览器整页导航无法带 Authorization 头）→ 首跳 query token **仅此一次**；
 * - server 校验通过 → **Set-Cookie（httpOnly/SameSite=Lax/短 TTL 15min）+ 302
 *   重定向去掉 query token**（干净 URL `/docs-site/:taskId/`）；
 * - 后续 registry/prd/<file> 请求**从 cookie 鉴权**（同源自动携带，URL 不再出现 token）；
 * - Authorization 头优先（API 直调兼容），query 仅整页导航首跳用；
 * - token 只短暂存在于首跳 URL；落地进 httpOnly cookie 防 JS 读取，短 TTL 限窗口；
 *   query token 不落日志（服务端不记录 query，见 controller 日志说明）。
 *
 * 端点：
 * - GET /docs-site/:taskId        → 工具页 HTML（dev 代理 upstream / static 读构建产物）
 * - GET /docs-site/:taskId/registry → 动态 DocDef[]（任务 doc 产出物）
 * - GET /docs-site/:taskId/prd/<file> → 镜像 .md 内容（taskId 子树白名单）
 * 路径均为 /api/v1 前缀（main.ts 全局前缀）；controller 不打印 query（token 脱敏）。
 */
@Controller('docs-site')
export class DocsSiteController {
  private readonly docsRoot: string;
  private readonly mode: DocsSiteMode;
  private readonly upstream: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mirror: DocsMirrorService,
    config: ConfigService,
  ) {
    const root = config.get<string>('MD_DOCS_ROOT');
    this.docsRoot = root?.trim() ? root.trim() : resolveDocsRoot();
    this.mode =
      (config.get<string>('MD_DOCS_MODE') ?? 'dev') === 'static'
        ? DOCS_SITE_MODES.static
        : DOCS_SITE_MODES.dev;
    const upstream = config.get<string>('MD_DOCS_UPSTREAM');
    this.upstream = upstream?.trim() || 'http://127.0.0.1:5173';
  }

  /**
   * 工具页入口 GET /docs-site/:taskId。
   * - 带 query token（首跳）：校验 → Set-Cookie + 302 去 token → 干净 URL；
   * - cookie 已就位：cookie 鉴权 → 返回工具页 HTML；
   * - Authorization 头优先（API 直调）。
   */
  @Get(':taskId')
  @Public()
  async shell(
    @Param('taskId') taskId: string,
    @Query('token') queryToken: string | undefined,
    @Query('task') taskHint: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // 首跳 query token 换 cookie：校验通过 → Set-Cookie + 302 去 token（干净 URL）
    if (queryToken) {
      await this.assertAuthorized(taskId, {
        headerToken: extractBearer(req),
        queryToken,
        cookieToken: undefined,
      });
      res.setHeader(
        'Set-Cookie',
        serializeDocsSiteCookie(queryToken, DOCS_SITE_COOKIE_TTL_MS),
      );
      // 302 到干净 URL：/docs-site/:taskId/（不含 query token；task 提示保留在 hash 由工具读取）
      const clean = `${SHELL_CLEAN_PATH}${encodeURIComponent(taskId)}/${taskHint ? `?task=${encodeURIComponent(taskHint)}` : ''}`;
      res.redirect(302, clean);
      return;
    }

    // 非首跳：cookie 或 Authorization 鉴权后返回工具页
    await this.assertAuthorized(taskId, {
      headerToken: extractBearer(req),
      queryToken: undefined,
      cookieToken: req.cookies?.[DOCS_SITE_COOKIE] as string | undefined,
    });
    if (this.mode === 'static') {
      await this.serveStaticShell(res);
      return;
    }
    await this.proxyUpstream(req, res);
  }

  /** 动态注册表 GET /docs-site/:taskId/registry → DocDef[]。 */
  @Get(':taskId/registry')
  @Public()
  async registry(
    @Param('taskId') taskId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    await this.assertAuthorized(taskId, {
      headerToken: extractBearer(req),
      queryToken: undefined,
      cookieToken: req.cookies?.[DOCS_SITE_COOKIE] as string | undefined,
    });
    return this.mirror.buildRegistry(taskId);
  }

  /** 镜像文档内容 GET /docs-site/:taskId/prd/:file。 */
  @Get(':taskId/prd/:file')
  @Public()
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  async prd(
    @Param('taskId') taskId: string,
    @Param('file') file: string,
    @Req() req: Request,
  ): Promise<string> {
    await this.assertAuthorized(taskId, {
      headerToken: extractBearer(req),
      queryToken: undefined,
      cookieToken: req.cookies?.[DOCS_SITE_COOKIE] as string | undefined,
    });
    const content = await this.mirror.readMirrorDoc(taskId, file);
    if (content === null) {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.DOC_NOT_FOUND,
        message: `文档不存在: ${file}`,
      });
    }
    return content;
  }

  /** 鉴权：taskId 白名单 → token 校验（Authorization 优先 → cookie → query）→ 项目成员。 */
  private async assertAuthorized(
    taskId: string,
    tokens: { headerToken?: string; queryToken?: string; cookieToken?: string },
  ): Promise<void> {
    if (!/^t_[a-zA-Z0-9_]+$/.test(taskId)) {
      throw new BadRequestException({
        code: DOCS_SITE_ERRORS.PATH_OUT_OF_BOUNDS,
        message: '非法 taskId',
      });
    }
    // Authorization 头优先（API 直调）；其次 cookie（首跳换 cookie 后的常规链路）；
    // query token 仅整页导航首跳用（shell 已处理换 cookie，此处兜底兼容降级方案）
    const token =
      tokens.headerToken ??
      tokens.cookieToken ??
      tokens.queryToken;
    if (!token) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '缺少访问凭证（Authorization 头 / cookie / 首跳 ?token=）',
      });
    }
    let payload: { sub: string; type?: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string; type?: string }>(token, {
        secret: process.env.JWT_SECRET ?? 'dev-secret',
      });
    } catch {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '访问凭证无效或已过期',
      });
    }
    if (payload.type !== JWT_TOKEN_TYPE.ACCESS) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '仅接受 access token',
      });
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const member = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: task.projectId, userId: payload.sub },
      },
    });
    if (!member) {
      throw new ForbiddenException({
        code: DOCS_SITE_ERRORS.FORBIDDEN,
        message: '您不是该项目成员，无权访问该任务文档站',
      });
    }
  }

  /** static 模式：读构建产物 index.html（prototype-viewer dist → docs-root/site/index.html）。 */
  private async serveStaticShell(res: Response): Promise<void> {
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const html = await readFile(join(this.docsRoot, 'site', 'index.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.DOC_NOT_FOUND,
        message:
          '文档站静态产物未构建（MD_DOCS_MODE=static 需先 build prototype-viewer 到 docs-root/site）',
      });
    }
  }

  /** dev 模式：代理 upstream（回环）— 返回工具页 HTML 与静态资源。 */
  private async proxyUpstream(req: Request, res: Response): Promise<void> {
    // 目标：upstream 根 + 去掉 /api/v1/docs-site/:taskId 前缀的余下路径
    const rest = req.originalUrl
      .replace(/^\/api\/v1\/docs-site\/[^/?]+/, '')
      .replace(/^\/docs-site\/[^/?]+/, '');
    const upstreamUrl = `${this.upstream}${rest || '/'}`;
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          accept: req.headers.accept ?? 'text/html',
        },
        redirect: 'manual',
      });
      const body = await upstreamRes.arrayBuffer();
      res.status(upstreamRes.status);
      const ct = upstreamRes.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      res.send(Buffer.from(body));
    } catch (err) {
      throw new NotFoundException({
        code: DOCS_SITE_ERRORS.NOT_CONFIGURED,
        message: `文档站 upstream 不可达（${this.upstream}）：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

/** 从 Authorization 头提取 Bearer token。 */
function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  return undefined;
}

/** 序列化 docs-site 会话 cookie（httpOnly/SameSite=Lax/短 TTL）。 */
function serializeDocsSiteCookie(token: string, ttlMs: number): string {
  const attrs = [
    `${DOCS_SITE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/docs-site',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  return attrs.join('; ');
}
