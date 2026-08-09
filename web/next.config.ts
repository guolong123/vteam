import type { NextConfig } from "next";

/**
 * 联调配置（Task 20）：将 /api/v1 请求代理到本地 NestJS server。
 * - web dev server 端口 3001，server 端口 3000（见 tasks 文档）。
 * - 代理后同源，浏览器请求无 CORS 问题；token 由前端 api.ts 以 Bearer 注入。
 * - 生产部署时可通过 NEXT_PUBLIC_API_BASE_URL 指向独立后端域名（见 lib/api.ts）。
 */
const API_PROXY_TARGET =
  process.env.API_PROXY_TARGET ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  // Docker 部署铁律（Phase 5 D4）：仅影响 next build 产物，与 dev 无冲突
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${API_PROXY_TARGET}/api/v1/:path*`,
      },
      // 上传文件静态访问：/uploads/* → server 静态服务（uploads 目录磁盘存储，见 server/src/uploads）
      {
        source: "/uploads/:path*",
        destination: `${API_PROXY_TARGET}/uploads/:path*`,
      },
    ];
  },
};

export default nextConfig;
