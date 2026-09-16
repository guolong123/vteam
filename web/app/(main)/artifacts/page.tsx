"use client";

/**
 * /artifacts 瘦重定向页（docs-artifacts-merge T10，路由收敛）
 * ============================================================
 * 旧 1070 行产出物聚合实现已删除（T8 统一文档站 `/docs` 已完整承接：
 * 聚合查询/分类+类型+验收筛选/文档树/版本查看器/删除/SSE，数据源同为团队聚合端点）。
 * 本页只做一件事：effect 内读 `window.location.search`（SSR-safe，与旧页/看板页同模式）
 * 全量透传 searchParams，`router.replace('/docs?...')`。
 * - 无 teamId 也不拦截：统一页无 teamId 时渲染团队选择器（不强制跳 /teams）。
 * - `data-testid="artifacts-root"` 仅过渡期保留，不作为质量门（pages.spec 改断言 /docs 落地）。
 * - 未登录访问仍由 AppShell 守卫先跳 `/login`（guard.spec 不变）。
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ArtifactsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    const qs = typeof window !== "undefined" ? window.location.search : "";
    router.replace(`/docs${qs}`);
  }, [router]);

  return (
    <div
      data-testid="artifacts-root"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
        color: "#94A3B8",
        fontFamily: "var(--font-body, system-ui, sans-serif)",
      }}
    >
      正在前往文档站…
    </div>
  );
}
