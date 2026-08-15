import { NextRequest, NextResponse } from "next/server";

/**
 * 同源 API 代理（运行时目标，替代 next.config.ts 构建期 rewrites）
 * ================================================================
 * API_PROXY_TARGET 改为**运行时**读取（部署时注入环境变量即可，同一镜像
 * 可部署任意环境）：compose 注入 http://server:3000、k8s 注入
 * http://vteam-server:3000、本地 dev 缺省 http://localhost:3000。
 *
 * 覆盖路径：
 * - /api/v1/*            → {target}/api/v1/*（透传）
 * - /uploads/*           → {target}/uploads/*（server 静态上传目录）
 * - /docs-site/*         → {target}/api/v1/docs-site/*（文档站，server 控制器）
 * 响应流式透传（SSE 聊天输出/长连接不受影响）；Set-Cookie 完整透传
 * （docs-site 首跳 query token 换 httpOnly cookie 依赖它）。
 */
const API_PROXY_TARGET =
  process.env.API_PROXY_TARGET ?? "http://localhost:3000";

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const destPath = pathname.startsWith("/docs-site")
    ? `/api/v1${pathname}`
    : pathname;
  const upstreamUrl = new URL(destPath + search, API_PROXY_TARGET);

  // 透传请求头（去掉 host，fetch 按目标地址设置）
  const headers = new Headers(req.headers);
  headers.delete("host");

  const upstream = await fetch(upstreamUrl.toString(), {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    // undici/Node fetch 要求：流式请求体（ReadableStream）必须显式声明 duplex
    duplex: "half",
    cache: "no-store",
  } as RequestInit);

  const resHeaders = new Headers(upstream.headers);
  // 完整透传 Set-Cookie（docs-site 首跳 query token 换 httpOnly cookie 依赖它）
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    resHeaders.append("set-cookie", c);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}

export const config = {
  matcher: ["/api/v1/:path*", "/uploads/:path*", "/docs-site/:path*"],
  runtime: "nodejs",
};
