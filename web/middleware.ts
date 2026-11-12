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
 * （is_0000000024 v4：文档站不代理——组件内嵌，registry/prd 经 api.get 直连 server。）
 * 响应流式透传（SSE 聊天输出/长连接不受影响）；Set-Cookie 完整透传。
 */
const API_PROXY_TARGET =
  process.env.API_PROXY_TARGET ?? "http://localhost:3000";

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const upstreamUrl = new URL(pathname + search, API_PROXY_TARGET);

  // 透传请求头（去掉 host，fetch 按目标地址设置）
  const headers = new Headers(req.headers);
  headers.delete("host");

  /**
   * 客户端断连必须传导到上游，否则 SSE / 大文件等长响应会变成"孤儿流"：
   * undici 的响应 ReadableStream 与 socket 一直被持有，NextResponse 也不会
   * 主动 cancel 它 —— 每次浏览器刷新/切页强杀 EventSource 都留一份缓冲，
   * 长跑容器 RSS 随时间单调增长、重启归零。
   *
   * 更重要的是：Next 15.5 standalone 启动时把 globalThis.fetch 换成了
   * createDedupeFetch(createPatchedFetcher(...))（patch-fetch.js:902-904）。
   * dedupe-fetch.js:80-90 里 **`options.signal` 是唯一的 opt-out 开关**——
   * 没传 signal 时，GET 响应会走 cloneResponse() → response.body.tee()，
   * 第二分支被塞进 React cache() 数组且永不消费，且 clone-response.js 只给
   * 第一分支注册了 FinalizationRegistry。SSE 是无限流 ⇒ tee 的第二分支队列
   * 无上限累积 ⇒ 这是 2.14GiB 增长的主因。`cache: "no-store"` 挡不住它。
   * 传 req.signal 一举两得：断连 abort 上游 + 直接绕过整条 dedupe/tee 路径。
   */
  const signal = req.signal;
  const isBodyless = ["GET", "HEAD"].includes(req.method);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: isBodyless ? undefined : req.body,
      // undici/Node fetch 要求：流式请求体（ReadableStream）必须显式声明 duplex
      duplex: "half",
      cache: "no-store",
      signal,
    } as RequestInit);
  } catch (err) {
    // fetch 失败（上游不可达 / 被 abort）时，请求体流也需显式释放，
    // 避免 duplex 上传流残留占用 undici 连接池与堆缓冲。
    if (req.body && !isBodyless) {
      await req.body.cancel().catch(() => undefined);
    }
    // 客户端自己断开导致的 abort：无需响应，也别把异常抛给 adapter
    if (signal.aborted) {
      return new NextResponse(null, { status: 499 });
    }
    // 上游异常收敛为结构化 502，避免 adapter 的 error 路径残留资源
    return new NextResponse(
      JSON.stringify({
        code: "UPSTREAM_UNAVAILABLE",
        message: err instanceof Error ? err.message : String(err),
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  // 竞态窗口：fetch 已返回但客户端同时断开 —— 主动取消上游响应体，
  // 且**不再**把已废弃的流交给 NextResponse 继续引用。
  if (signal.aborted) {
    await upstream.body?.cancel().catch(() => undefined);
    return new NextResponse(null, { status: 499 });
  }

  const resHeaders = new Headers(upstream.headers);
  // undici 的 Headers 通常已含 set-cookie，先删再按 getSetCookie() 逐个 append，
  // 避免同一 cookie 被下发两次。
  resHeaders.delete("set-cookie");
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
  matcher: ["/api/v1/:path*", "/uploads/:path*"],
  runtime: "nodejs",
};
