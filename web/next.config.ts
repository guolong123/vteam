import type { NextConfig } from "next";

/**
 * 联调配置（Task 20）：/api/v1、/uploads 的同源代理。
 * - 代理逻辑在 middleware.ts（**运行时**读取 API_PROXY_TARGET 环境变量），
 *   替代构建期 rewrites——同一镜像可部署任意环境（compose 注入
 *   http://server:3000、k8s 注入 http://vteam-server:3000、本地 dev 缺省
 *   http://localhost:3000），无需按环境重新构建镜像。
 * - is_0000000024 v4：文档站不代理（组件内嵌，api.get 直连），middleware 已移除 /docs-site。
 * - 生产部署时可通过 NEXT_PUBLIC_API_BASE_URL 指向独立后端域名（见 lib/api.ts）。
 */
const nextConfig: NextConfig = {
  // Docker 部署铁律（Phase 5 D4）：仅影响 next build 产物，与 dev 无冲突
  output: "standalone",
};

export default nextConfig;
