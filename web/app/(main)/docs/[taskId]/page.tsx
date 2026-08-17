"use client";

/**
 * 文档站视图（is_0000000024 v4 深度集成）
 * =============================================================
 * v4（art_0000000039）：组件内嵌 web，无代理/无独立进程/无 query token。
 * - /docs/[taskId] 直接渲染 DocExplorer（移植自 prototype-viewer）：
 *   registry（GET /docs-site/:taskId/registry）+ 文档正文（/docs-site/:taskId/prd/<file>）
 *   均经标准 JWT Authorization（api.get / fetch Bearer 头）；
 * - 顶部薄壳提供任务上下文（返回任务链接 + 标题）+ 文档站标识；
 * - 实时性：registry 30s refetchInterval（AC-1 新口径，与 is_0000000020 同模式）。
 */
import { useState, type CSSProperties } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/authStore";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";
import { DocExplorer } from "@/src/components/docs/doc-explorer";

// is_0000000037：原型 tab 懒加载（仅进入原型 tab 才拉取 registry/原型 chunk，文档 tab 首屏不受影响）
const PrototypePanel = dynamic(
  () => import("@/src/components/docs/prototype-panel").then((m) => m.PrototypePanel),
  { ssr: false, loading: () => <div style={{ padding: space.xl, color: neutral[400], fontFamily: fontFamily.body }}>加载原型…</div> },
);

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export default function DocsPage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params?.taskId ?? "";
  const user = useAuthStore((s) => s.user);
  // is_0000000036：?doc=<slug> 初始定位到具体文档（产出物 doc 点击携带）
  const searchParams = useSearchParams();
  const initialDocId = searchParams.get("doc") ?? undefined;
  // is_0000000037：文档 | 原型 tab
  const [tab, setTab] = useState<"docs" | "protos">("docs");

  // 任务上下文标题（返回入口 + 顶部标题）
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () =>
      api.get<{ id: string; title: string; status: string }>(`/tasks/${taskId}`),
    enabled: !!taskId && !!user?.id,
    retry: false,
  });

  return (
    <div
      data-testid="docs-shell"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: neutral[50],
        marginLeft: -80,
        ...baseFont,
      }}
    >
      {/* 薄壳头部：返回任务 + 任务上下文 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.md,
          padding: `${space.md}px ${space.xl}px ${space.md}px 80px`,
          backgroundColor: neutral[50],
          borderBottom: `1px solid ${neutral[200]}`,
          flexShrink: 0,
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

      {/* 文档 | 原型 tab（is_0000000037） */}
      <div
        data-testid="docs-tab-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.xs,
          padding: `${space.sm}px 80px 0`,
          backgroundColor: neutral[50],
          borderBottom: `1px solid ${neutral[200]}`,
          flexShrink: 0,
        }}
      >
        {(
          [
            { key: "docs", label: "文档" },
            { key: "protos", label: "原型" },
          ] as const
        ).map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              data-testid={`docs-tab-${t.key}`}
              data-active={active ? "true" : "false"}
              onClick={() => setTab(t.key)}
              style={{
                padding: `${space.sm + 2}px ${space.lg}px`,
                border: "none",
                background: "none",
                borderBottom: active ? `2px solid #2563EB` : `2px solid transparent`,
                color: active ? "#1D4ED8" : neutral[500],
                fontSize: fontSize.md,
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* 内容区：文档阅读器（v4 内嵌渲染，initialDocId 定位）或 原型面板（懒加载） */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", paddingLeft: 80 }}>
        {tab === "docs" ? <DocExplorer taskId={taskId} initialDocId={initialDocId} /> : <PrototypePanel taskId={taskId} />}
      </div>
    </div>
  );
}
