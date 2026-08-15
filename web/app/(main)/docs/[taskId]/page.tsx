"use client";

/**
 * 文档站视图（is_0000000024 · 集成 md-docs 产出物文档查看工具）
 * =============================================================
 * 架构决策（art_0000000026 §2-④/§4）：同源代理 + 整页渲染，不用 iframe。
 * - 本页为「薄壳路由」：提供任务上下文（标题 + 返回任务入口），随后整页导航到
 *   server 鉴权同源代理 `/docs-site/:taskId/`（经 next.config.ts rewrites 转发，
 *   同源 cookie/query token 由 server DocsSiteController 校验）。
 * - 鉴权传递：平台认证为 Bearer token（authStore 内存态，非 cookie），浏览器整页
 *   导航无法携带 Authorization 头 → 以 `?token=` query 透传，server docs-site 控制器
 *   从 query 读取（依赖刘二开 server 侧支持 token 读取，见实现说明）。
 * - 整页渲染后 md-docs 自身文档树导航在其页面内；浏览器回退保留任务上下文。
 */
import { useEffect, type CSSProperties } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, getAuthToken } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/authStore";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export default function DocsPage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params?.taskId ?? "";
  const user = useAuthStore((s) => s.user);

  // 任务上下文标题（返回入口 + 顶部标题）
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () =>
      api.get<{ id: string; title: string; status: string }>(`/tasks/${taskId}`),
    enabled: !!taskId && !!user?.id,
    retry: false,
  });

  // 整页渲染：挂载后跳转同源 docs-site 代理（任务模式标识 ?task= + token 鉴权，server 控制器校验）
  useEffect(() => {
    if (!taskId) return;
    const token = getAuthToken();
    const params = new URLSearchParams({ task: taskId });
    if (token) params.set("token", token);
    window.location.replace(`/docs-site/${encodeURIComponent(taskId)}/?${params.toString()}`);
  }, [taskId]);

  return (
    <div
      data-testid="docs-shell"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        ...baseFont,
      }}
    >
      {/* 薄壳头部：返回任务 + 任务上下文 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.md,
          padding: `${space.md}px ${space.xl}px`,
          backgroundColor: "#FFFFFF",
          borderBottom: `1px solid ${neutral[200]}`,
        }}
      >
        <Link
          href={`/tasks/${taskId}`}
          data-testid="docs-back-to-task"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            color: "#2563EB",
            fontSize: fontSize.md,
            fontWeight: 500,
            textDecoration: "none",
            fontFamily: fontFamily.body,
            flexShrink: 0,
          }}
        >
          ← 返回任务
        </Link>
        <span aria-hidden style={{ color: neutral[300] }}>·</span>
        <span
          data-testid="docs-task-title"
          style={{
            fontSize: fontSize.md,
            fontWeight: 600,
            color: neutral[800],
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {taskQuery.data?.title ?? taskId}
        </span>
        <span
          style={{
            flexShrink: 0,
            fontSize: fontSize.xs,
            color: neutral[400],
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.pill,
            padding: "1px 10px",
          }}
        >
          文档站
        </span>
      </div>

      {/* 整页渲染中转（跳转 /docs-site/:taskId/ 前短暂展示） */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: neutral[400],
          fontSize: fontSize.md,
        }}
      >
        正在加载文档站…
      </div>
    </div>
  );
}
