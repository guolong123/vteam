"use client";
import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/authStore";
import { DocExplorer } from "@/src/features/docs-site/doc-explorer";
import { neutral, surface, border, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const PrototypePanel = dynamic(
  () => import("@/src/features/docs-site/prototype-panel").then((m) => m.PrototypePanel),
  { ssr: false, loading: () => <div style={{ padding: space.xl, fontSize: fontSize.md, color: neutral[400], fontFamily: fontFamily.body }}>加载原型…</div> },
);

/* 品牌蓝（对齐 roleText.product，双主题下保持可读） */
const ACCENT = "#2563EB";
const ACCENT_BG = "rgba(37,99,235,0.10)";

export default function DocsPage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params?.taskId ?? "";
  const user = useAuthStore((s) => s.user);
  const searchParams = useSearchParams();
  const initialDocId = searchParams.get("doc") ?? undefined;
  const initialProtoId = searchParams.get("proto") ?? undefined;
  const [tab, setTab] = useState<"docs" | "protos">(() => (searchParams.get("proto") ? "protos" : "docs"));
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.get<{ id: string; title: string; status: string }>(`/tasks/${taskId}`),
    enabled: !!taskId && !!user?.id,
    retry: false,
  });
  const protoCountQuery = useQuery({
    queryKey: ["docs-proto-count", taskId],
    queryFn: () => api.get<{ items: unknown[] }>(`/docs-site/${taskId}/prototypes`),
    enabled: !!taskId && !!user?.id,
    retry: false,
  });
  const protoCount = Array.isArray(protoCountQuery.data?.items) ? protoCountQuery.data.items.length : undefined;
  const crumb = tab === "docs" ? "文档" : "原型";
  return (
    <div data-testid="docs-shell" style={{ display: "flex", minHeight: 0, flex: 1, flexDirection: "column", overflow: "hidden", backgroundColor: surface, fontFamily: fontFamily.body, WebkitFontSmoothing: "antialiased" }}>
      <nav aria-label="面包屑" style={{ display: "flex", height: 36, flexShrink: 0, alignItems: "center", gap: 6, borderBottom: `1px solid ${border}`, backgroundColor: surface, padding: `0 ${space.lg}px`, fontSize: fontSize.xs }}>
        <Link href={`/tasks/${taskId}`} data-testid="docs-back-to-task" style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: radius.sm, color: neutral[500], textDecoration: "none", transition: "color .15s", fontFamily: fontFamily.body }}>
          <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          返回任务
        </Link>
        <span style={{ color: neutral[300] }} aria-hidden>/</span>
        <span data-testid="docs-task-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500, color: neutral[700] }} title={taskQuery.data?.title ?? taskId}>{taskQuery.data?.title ?? taskId}</span>
        <span style={{ color: neutral[300] }} aria-hidden>/</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: neutral[500] }}>{crumb}</span>
        <span className="hidden sm:inline-flex" style={{ marginLeft: "auto", alignItems: "center", gap: 6, borderRadius: radius.pill, border: `1px solid ${border}`, backgroundColor: neutral[50], padding: "2px 10px", fontSize: 11, fontWeight: 500, color: neutral[500] }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "#3B82F6" }} />文档站
        </span>
      </nav>
      <div data-testid="docs-tab-bar" style={{ display: "flex", height: 44, flexShrink: 0, alignItems: "center", gap: 4, borderBottom: `1px solid ${border}`, backgroundColor: surface, padding: `0 ${space.lg}px` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: radius.md, border: `1px solid ${border}`, backgroundColor: neutral[100], padding: 2 }} role="tablist" aria-label="文档站内容">
          <button type="button" role="tab" aria-selected={tab === "docs"} data-testid="docs-tab-docs" data-active={tab === "docs" ? "true" : "false"} onClick={() => setTab("docs")} style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: radius.sm, padding: "6px 12px", fontSize: fontSize.md, fontWeight: 500, cursor: "pointer", border: "none", fontFamily: fontFamily.body, transition: "background .15s, color .15s", ...(tab === "docs" ? { backgroundColor: surface, color: neutral[900], boxShadow: "0 1px 2px rgba(15,23,42,.06)" } : { backgroundColor: "transparent", color: neutral[500] }) }}>
            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h16M6 20V8l6-4 6 4v12M10 20v-6h4v6" /></svg>文档
          </button>
          <button type="button" role="tab" aria-selected={tab === "protos"} data-testid="docs-tab-protos" data-active={tab === "protos" ? "true" : "false"} onClick={() => setTab("protos")} style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: radius.sm, padding: "6px 12px", fontSize: fontSize.md, fontWeight: 500, cursor: "pointer", border: "none", fontFamily: fontFamily.body, transition: "background .15s, color .15s", ...(tab === "protos" ? { backgroundColor: surface, color: neutral[900], boxShadow: "0 1px 2px rgba(15,23,42,.06)" } : { backgroundColor: "transparent", color: neutral[500] }) }}>
            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>原型
            {typeof protoCount === "number" && protoCount > 0 && <span style={{ borderRadius: radius.pill, backgroundColor: neutral[200], padding: "0 6px", fontSize: 10, fontWeight: 600, lineHeight: "16px", color: neutral[600] }}>{protoCount}</span>}
          </button>
        </div>
      </div>
      <div style={{ display: "flex", minHeight: 0, flex: 1, flexDirection: "column", overflow: "hidden" }}>
        {tab === "docs" ? <DocExplorer taskId={taskId} initialDocId={initialDocId} /> : <PrototypePanel taskId={taskId} initialProtoId={initialProtoId} />}
      </div>
    </div>
  );
}