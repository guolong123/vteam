"use client";

/**
 * 团队级统一文档站（docs-artifacts-merge T8，DB-only）
 * =============================================
 * 路由：/docs?teamId=&taskId=&doc=（团队外壳；无 teamId 渲染团队选择器，不强制跳 /teams）。
 * - 团队/任务双选择：团队列表经 teamsApi.list，任务下拉经 GET /tasks?teamId=（board 页同模式）。
 * - 筛选 chips：分类（全部 + ARTIFACT_CATEGORIES 七类 + 未分类）/ 类型 / 验收，
 *   artifacts 页 pill 范式（data-active 契约保留）。
 * - 数据源只准三处：GET /teams/:id/artifacts（T5 聚合端点，单查询）+
 *   GET /artifacts/:id + GET /artifacts/:id/versions/:version。不做逐任务聚合。
 * - 文档树：聚合端点当前无 parent/children 字段 → 平铺渲染（见 T8 证据的字段核查）。
 * - 内容区：FilePreview 富渲染矩阵（`src/features/docs-site/file-preview.tsx`，
 *   text→md、pdf 沙箱、office 下载卡等全部分支；本页只 import，不内联）。
 * - 版本查看器：全类型可用（artifacts 页切换范式 `‹ vN … ›`，testid 对齐）。
 * - 删除：复用 useDeleteArtifact 语义（hook 本体不动，成功后刷新本页聚合查询）。
 * - SSE：artifact.submitted → refetch（artifacts 页 useRealtimeEvents 模式）。
 * - ?doc= 深链：经 @/src/lib/artifact-slug docIdFor 逐行计算匹配（与 session 页同输入）；
 *   未知 doc → 内容区空态，绝不 404/throw。
 * - T10 消费：本文件默认导出即合站组件（薄别名直接 import）。
 * - T16 团队级原型 + 全宽布局：protos tab 常驻可用；已选具体任务时渲染
 *   `PrototypePanel taskId + initialProtoId`（任务级窄化）；task=all 时渲染
 *   `PrototypePanel teamId + tasks`（团队级：`GET /teams/:id/prototypes`
 *   主端点 + 逐任务聚合回退，条目自带 taskId/taskName，沙箱取选中条目 taskId；
 *   真正为空时面板内 `docs-proto-empty` 空态）。布局：PageWindow fluid 全宽；
 *   树 440px 两行（标题弹性行 + 任务名次行，分类/版本徽标保留）；
 *   树/查看器 `calc(100vh - 280px)` 视口填充 + 内部滚动，查看器头尾 pinned。
 * - data-testid：docs-shell / docs-team-picker / docs-team-option / docs-filter-bar /
 *   team-filter-select / task-filter-select / category-filter-option /
 *   type-filter-option / accepted-filter-option / docs-tree / docs-tree-item /
 *   docs-viewer-empty / docs-doc-missing / artifact-viewer / artifact-version-switch /
 *   artifact-version-timeline / docs-content-view / docs-delete-button /
 *   docs-loading / docs-error / docs-retry / docs-tab-bar / docs-tab-docs /
 *   docs-tab-protos / docs-proto-empty。
 */
import { useEffect, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import { ARTIFACT_CATEGORIES } from "@/src/lib/artifact-categories";
import { docIdFor } from "@/src/lib/artifact-slug";
import { useDeleteArtifact } from "@/src/features/docs-site/hooks";
import { FilePreview } from "@/src/features/docs-site/file-preview";
import { EmptyState, PageWindow } from "@/src/components/ui";
import {
  roleText,
  neutral,
  surface,
  border,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 原型面板（T14：旧任务页同款 dynamic ssr:false，首屏不进包） ------------------------------ */
const PrototypePanel = dynamic(
  () => import("@/src/features/docs-site/prototype-panel").then((m) => m.PrototypePanel),
  { ssr: false, loading: () => <div style={{ padding: space.xl, fontSize: fontSize.md, color: neutral[400], fontFamily: fontFamily.body }}>加载原型…</div> },
);

/* ------------------------------ 页面内扩展 token（不动 tokens.ts 基线） ------------------------------ */
/** 产出物 API 类型（对齐 ARTIFACT_TYPES：text/doc/file）。 */
type ArtifactApiType = "text" | "doc" | "file";

/**
 * 产出物类型三色（与 artifacts 页一致：结论文本=紫 / 文档=蓝 / 文件=绿）。
 */
const ARTIFACT_TYPE_THEME: Record<
  ArtifactApiType,
  { color: string; bg: string; border: string }
> = {
  text: { color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
  doc: { color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
  file: { color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
};

/** 类型中文名（三筛标签 / 类型徽章文案，与 artifacts 页同词）。 */
const ARTIFACT_TYPE_LABEL: Record<ArtifactApiType, string> = {
  text: "结论文本",
  doc: "文档",
  file: "文件",
};

/** 类型筛选项（key 对齐 API type 参数，all=不传）。 */
const TYPE_OPTIONS: { key: string; label: string; type?: ArtifactApiType }[] = [
  { key: "all", label: "全部" },
  { key: "text", label: "结论文本", type: "text" },
  { key: "doc", label: "文档", type: "doc" },
  { key: "file", label: "文件", type: "file" },
];

/** 验收状态筛选项（key 对齐 API accepted 参数 'true'/'false'，all=不传）。 */
const ACCEPTED_OPTIONS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "true", label: "已验收" },
  { key: "false", label: "未验收" },
];

/** 分类筛 key：all=不过滤；uncategorized=前端过滤 category==null；其余透传词表值。 */
const CATEGORY_ALL = "all";
const CATEGORY_UNCATEGORIZED = "uncategorized";
const UNCATEGORIZED_LABEL = "未分类";
const ALL_LABEL = "全部";

/* ------------------------------ API 数据模型（T5 冻结形状） ------------------------------ */
/** GET /tasks?teamId= 条目（任务下拉数据源）。 */
interface TaskItem {
  id: string;
  title: string;
}

/** GET /tasks?teamId= 分页响应。 */
interface TasksResponse {
  items: TaskItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /teams/:id/artifacts 列表项（= toArtifactListItem + taskName，见 T5 证据 §2）。 */
interface TeamArtifactItem {
  id: string;
  taskId: string;
  taskName: string | null;
  type: ArtifactApiType;
  title: string;
  category: string | null;
  currentVersion: number;
  acceptedFlag: boolean;
  authorAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  fileUrl?: string;
}

/** GET /teams/:id/artifacts 分页响应。 */
interface TeamArtifactsResponse {
  items: TeamArtifactItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** ArtifactVersionDto（GET /artifacts/:id/versions/:version）。 */
interface ArtifactVersionDto {
  id: string;
  artifactId: string;
  version: number;
  contentRef: string;
  filePath: string | null;
  sha256: string | null;
  acceptedFlag: boolean;
  authorAgentId: string | null;
  changeNote: string | null;
  createdAt: string;
  fileUrl?: string;
  fileName?: string;
  fileExt?: string;
  fileSize?: number | null;
}

/** GET /artifacts/:id：产出物详情 + 全版本列表（升序）。 */
interface ArtifactDetail {
  id: string;
  taskId: string;
  type: ArtifactApiType;
  title: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  versions: ArtifactVersionDto[];
}

/* ------------------------------ 工具函数（与 artifacts 页同语义） ------------------------------ */
/** ISO8601 → "YYYY-MM-DD HH:mm"（本地时区）。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------ 徽章组件 ------------------------------ */
/** 产出物类型徽章（text 紫 / doc 蓝 / file 绿）。 */
function ArtifactTypeBadge({ type }: { type: ArtifactApiType }) {
  const t = ARTIFACT_TYPE_THEME[type] ?? ARTIFACT_TYPE_THEME.text;
  return (
    <span
      data-testid="artifact-type-badge"
      data-type={type}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `2px ${space.sm}px`,
        borderRadius: radius.sm,
        backgroundColor: t.bg,
        border: `1px solid ${t.border}`,
        color: t.color,
        fontSize: fontSize.xs,
        fontWeight: 500,
        whiteSpace: "nowrap",
        fontFamily: fontFamily.body,
      }}
    >
      {ARTIFACT_TYPE_LABEL[type] ?? type}
    </span>
  );
}

/** 分类徽章：词表值原样展示；NULL → 「未分类」（灰）。 */
function CategoryBadge({ category }: { category: string | null }) {
  const label = category ?? UNCATEGORIZED_LABEL;
  const classified = category != null;
  return (
    <span
      data-testid="docs-category-badge"
      data-category={category ?? "uncategorized"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `2px ${space.sm}px`,
        borderRadius: radius.sm,
        backgroundColor: classified ? "rgba(13,148,136,0.10)" : neutral[100],
        border: `1px solid ${classified ? "rgba(13,148,136,0.22)" : neutral[200]}`,
        color: classified ? "#0D9488" : neutral[500],
        fontSize: fontSize.xs,
        fontWeight: 500,
        whiteSpace: "nowrap",
        fontFamily: fontFamily.body,
      }}
    >
      {label}
    </span>
  );
}

/* ------------------------------ 版本查看器（全类型，artifacts 页切换范式） ------------------------------ */
interface VersionViewerProps {
  artifactId: string;
  type: ArtifactApiType;
  title: string;
  onClose: () => void;
}

function VersionViewer({ artifactId, type, title, onClose }: VersionViewerProps) {
  // 当前选中版本：缺省 = currentVersion（detail 返回后可用）；点击版本切换更新
  const [activeVersion, setActiveVersion] = useState<number | null>(null);

  // 版本列表（版本切换 `‹ vN … ›` 数据源）
  const detailQuery = useQuery({
    queryKey: ["artifact-detail", artifactId],
    queryFn: () => api.get<ArtifactDetail>(`/artifacts/${artifactId}`),
  });

  const versions = detailQuery.data?.versions ?? [];
  const current = activeVersion ?? detailQuery.data?.currentVersion ?? null;

  // 单版本详情（内容预览 / 元信息）
  const versionQuery = useQuery({
    queryKey: ["artifact-version", artifactId, current],
    queryFn: () => api.get<ArtifactVersionDto>(`/artifacts/${artifactId}/versions/${current}`),
    enabled: !!current,
  });

  const isDetailError = detailQuery.isError || versionQuery.isError;
  const detailError = (detailQuery.error ?? versionQuery.error) as unknown;

  return (
    <section
      data-testid="artifact-viewer"
      data-artifact-id={artifactId}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        backgroundColor: "var(--color-surface)",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        overflow: "hidden",
        ...baseFont,
      }}
    >
      {/* 查看器头部：类型徽章 + 标题 + 版本切换 + 收起 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          gap: space.md,
          padding: `${space.md}px ${space.xl}px`,
          borderBottom: `1px solid ${neutral[200]}`,
          backgroundColor: neutral[50],
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <ArtifactTypeBadge type={type} />
          <span
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          {/* 版本切换：‹ vN … ›，当前/选中版高亮 */}
          <div
            aria-label="版本切换"
            data-testid="artifact-version-switch"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.pill,
              padding: `${space.xs}px ${space.sm}px`,
              fontSize: fontSize.xs,
              color: neutral[500],
            }}
          >
            <span aria-hidden style={{ color: neutral[300] }}>‹</span>
            {versions.length === 0 ? (
              <span style={{ color: neutral[400] }}>…</span>
            ) : (
              versions.map((v) => {
                const isActive = v.version === current;
                return (
                  <button
                    key={v.version}
                    type="button"
                    data-version={v.version}
                    data-active={isActive ? "true" : "false"}
                    onClick={() => setActiveVersion(v.version)}
                    style={{
                      padding: "1px 7px",
                      borderRadius: radius.pill,
                      border: "none",
                      backgroundColor: isActive ? roleText.product : "transparent",
                      color: isActive ? "#FFFFFF" : neutral[500],
                      fontWeight: isActive ? 600 : 400,
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    v{v.version}
                  </button>
                );
              })
            )}
            <span aria-hidden style={{ color: neutral[300] }}>›</span>
          </div>
          <button
            type="button"
            aria-label="收起"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              borderRadius: radius.sm,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[500],
              fontSize: fontSize.md,
              lineHeight: 1,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* 内容区：经 FilePreview 富矩阵渲染（text→md / pdf 沙箱 / office 下载卡）；纵向填充 + 内部滚动，头尾元信息常驻 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: `${space.xl}px`,
          fontSize: fontSize.md,
          lineHeight: 1.7,
          color: neutral[700],
          fontFamily: fontFamily.body,
        }}
      >
        {isDetailError ? (
          <div role="alert" style={{ color: "#DC2626", fontSize: fontSize.md }}>
            {isApiError(detailError) ? detailError.message : "加载版本内容失败"}
          </div>
        ) : versionQuery.isPending ? (
          <span style={{ color: neutral[400] }}>加载中…</span>
        ) : versionQuery.data ? (
          <FilePreview version={versionQuery.data} type={type} title={title} />
        ) : null}
      </div>

      {/* 底部元信息：当前版本 + 版本时间线（当前版本在前） */}
      <div
        data-testid="artifact-version-timeline"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          gap: space.md,
          padding: `${space.md}px ${space.xl}px`,
          borderTop: `1px dashed ${neutral[200]}`,
          fontSize: fontSize.xs,
          color: neutral[400],
        }}
      >
        <span>
          当前版本：<strong style={{ color: neutral[600] }}>v{current ?? "?"}</strong>
          {versionQuery.data?.changeNote ? ` · ${versionQuery.data.changeNote}` : ""}
        </span>
        <span style={{ textAlign: "right" }}>
          {[...versions]
            .reverse()
            .map((v) => `v${v.version} · ${formatTime(v.createdAt)}`)
            .join("　→　") || "暂无版本历史"}
        </span>
      </div>
    </section>
  );
}

/* ------------------------------ 文档树行（平铺；删除沿 doc-explorer 交互） ------------------------------ */
interface DocTreeRowProps {
  item: TeamArtifactItem;
  docSlug: string;
  active: boolean;
  onSelect: () => void;
  onDeleted: (deletedId: string) => void;
}

function DocTreeRow({ item, docSlug, active, onSelect, onDeleted }: DocTreeRowProps) {
  const [hover, setHover] = useState(false);
  // 复用 useDeleteArtifact 语义（hook 本体不动）：行所属 taskId 作用域 + 成功后刷新聚合查询
  const deleteMutation = useDeleteArtifact(item.taskId);
  const queryClient = useQueryClient();

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`确定删除文档「${item.title}」？`)) return;
    deleteMutation.mutate(item.id, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["team-artifacts"] });
        onDeleted(item.id);
      },
    });
  };

  return (
    <div
      data-testid="docs-tree-item"
      data-doc-id={docSlug}
      data-artifact-id={item.id}
      data-active={active ? "true" : "false"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        borderRadius: radius.md,
        border: `1px solid ${active ? roleText.product : neutral[200]}`,
        backgroundColor: active ? "rgba(13,148,136,0.08)" : "var(--color-surface)",
        padding: `${space.sm}px ${space.md}px`,
        ...baseFont,
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        style={{
          display: "flex",
          minWidth: 0,
          flex: 1,
          flexDirection: "column",
          gap: 2,
          border: "none",
          background: "transparent",
          padding: 0,
          textAlign: "left",
          cursor: "pointer",
          fontFamily: fontFamily.body,
        }}
      >
        <span style={{ display: "flex", minWidth: 0, alignItems: "center", gap: space.sm }}>
          <ArtifactTypeBadge type={item.type} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: fontSize.md,
              fontWeight: active ? 600 : 500,
              color: active ? "#0D9488" : neutral[700],
            }}
          >
            {item.title}
          </span>
        </span>
        <span style={{ display: "flex", minWidth: 0, alignItems: "center", gap: space.sm }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: fontSize.xs,
              color: neutral[400],
            }}
          >
            {item.taskName ?? ""}
          </span>
          <CategoryBadge category={item.category} />
          <span
            style={{
              flexShrink: 0,
              fontSize: fontSize.xs,
              fontWeight: 600,
              color: neutral[500],
              backgroundColor: neutral[200],
              padding: "1px 6px",
              borderRadius: radius.pill,
            }}
          >
            v{item.currentVersion}
          </span>
        </span>
      </button>
      <button
        type="button"
        data-testid="docs-delete-button"
        aria-label={`删除 ${item.title}`}
        onClick={handleDelete}
        disabled={deleteMutation.isPending}
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.sm,
          border: "none",
          cursor: deleteMutation.isPending ? "default" : "pointer",
          backgroundColor: hover ? "rgba(220,38,38,0.10)" : "transparent",
          color: hover ? "#DC2626" : neutral[300],
          opacity: hover ? 1 : 0,
          transition: "opacity .15s, background-color .15s, color .15s",
          fontSize: fontSize.sm,
          lineHeight: 1,
        }}
      >
        <span aria-hidden>🗑</span>
      </button>
    </div>
  );
}

/* ------------------------------ 筛选 pill（artifacts 页范式，data-active 保留） ------------------------------ */
function FilterPills({
  testId,
  options,
  activeKey,
  onChange,
}: {
  testId: string;
  options: { key: string; label: string }[];
  activeKey: string;
  onChange: (key: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
      {options.map((opt) => {
        const isActive = opt.key === activeKey;
        return (
          <button
            key={opt.key}
            type="button"
            data-testid={testId}
            data-key={opt.key}
            data-active={isActive ? "true" : "false"}
            onClick={() => onChange(opt.key)}
            style={{
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${isActive ? "#0D9488" : neutral[200]}`,
              backgroundColor: isActive ? "#0D9488" : "var(--color-surface)",
              color: isActive ? "#FFFFFF" : neutral[600],
              fontSize: fontSize.md,
              fontWeight: isActive ? 600 : 400,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              transition: "background-color .15s ease, color .15s ease",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ 页面（AppShell 内容区；T10 薄别名直接 import 本默认导出） ------------------------------ */
export default function DocsUnifiedPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  const router = useRouter();

  // URL 状态：?teamId=&taskId=&doc=（effect 内读 window，避免 SSR 水合不一致；artifacts 页同模式）
  const [teamId, setTeamId] = useState<string | null>(null);
  const [urlReady, setUrlReady] = useState(false);
  // 筛选状态（默认全部；taskId=all/缺省 = 全团队）
  const [taskKey, setTaskKey] = useState("all");
  const [typeKey, setTypeKey] = useState("all");
  const [categoryKey, setCategoryKey] = useState(CATEGORY_ALL);
  const [acceptedKey, setAcceptedKey] = useState("all");
  // 选中文档（?doc= slug；null = 未选）
  const [docSlug, setDocSlug] = useState<string | null>(null);
  // 文档/原型双 tab（T14 回补：testid 沿用旧任务页契约；?proto= 存在即激活原型 tab，
  // 与 ?doc= 共存时初始以 ?proto= 为准，挂载后以最后点击为准）
  const [tab, setTab] = useState<"docs" | "protos">("docs");
  const [protoParam, setProtoParam] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setTeamId(q.get("teamId"));
    const tk = q.get("taskId");
    if (tk) setTaskKey(tk);
    const d = q.get("doc");
    if (d) setDocSlug(d);
    const p = q.get("proto");
    if (p) {
      setProtoParam(p);
      setTab("protos");
    }
    setUrlReady(true);
  }, []);

  /** URL 驱动：筛选/选择变化 → replace 查询串（链接可分享；proto 透传保留）。 */
  const syncUrl = (next: { teamId?: string | null; taskId?: string; doc?: string | null; proto?: string | null }) => {
    const q = new URLSearchParams(window.location.search);
    const t = next.teamId !== undefined ? next.teamId : teamId;
    if (t) q.set("teamId", t);
    else q.delete("teamId");
    const tk = next.taskId !== undefined ? next.taskId : taskKey;
    if (tk && tk !== "all") q.set("taskId", tk);
    else q.delete("taskId");
    const d = next.doc !== undefined ? next.doc : docSlug;
    if (d) q.set("doc", d);
    else q.delete("doc");
    const p = next.proto !== undefined ? next.proto : protoParam;
    if (p) q.set("proto", p);
    else q.delete("proto");
    const qs = q.toString();
    router.replace(`/docs${qs ? `?${qs}` : ""}`);
  };

  // 团队列表：团队选择器 + 团队名数据源（teamsApi.list，团队选择器无 teamId 时用）
  const teamsQuery = useQuery({
    queryKey: ["docs-teams"],
    queryFn: () => teamsApi.list({ page: 1, pageSize: 100 }),
    enabled: !!userId,
  });
  const teams: TeamDto[] = teamsQuery.data?.items ?? [];
  const teamName = teams.find((t) => t.id === teamId)?.name;

  // 任务列表：任务下拉数据源（GET /tasks?teamId=，board 页同模式）
  const tasksQuery = useQuery({
    queryKey: ["docs-tasks", teamId],
    queryFn: () =>
      api.get<TasksResponse>("/tasks", {
        query: { teamId: teamId!, page: 1, pageSize: 100 },
      }),
    enabled: !!userId && !!teamId,
  });
  const tasks = tasksQuery.data?.items ?? [];

  // 原型数量徽标：已选具体任务 → 任务级计数；全团队 → 团队级计数（T16 团队级原型 tab）。
  const protoCountQuery = useQuery({
    queryKey: ["docs-proto-count", taskKey],
    queryFn: () => api.get<{ items: unknown[] }>(`/docs-site/${taskKey}/prototypes`),
    enabled: !!userId && taskKey !== "all",
    retry: false,
  });
  const teamProtoCountQuery = useQuery({
    queryKey: ["team-proto-count", teamId],
    queryFn: () => api.get<{ items: unknown[] }>(`/teams/${teamId}/prototypes`),
    enabled: !!userId && !!teamId && taskKey === "all",
    retry: false,
  });
  const taskProtoCount = Array.isArray(protoCountQuery.data?.items) ? protoCountQuery.data.items.length : undefined;
  const teamProtoCount = Array.isArray(teamProtoCountQuery.data?.items) ? teamProtoCountQuery.data.items.length : undefined;
  const protoCount = taskKey === "all" ? teamProtoCount : taskProtoCount;

  // 聚合查询：ONE 团队端点查询（分类/类型/验收走请求参数；未分类走前端过滤）
  const teamArtifactsQuery = useQuery({
    queryKey: ["team-artifacts", teamId, taskKey, typeKey, categoryKey, acceptedKey] as const,
    queryFn: () =>
      api.get<TeamArtifactsResponse>(`/teams/${teamId}/artifacts`, {
        query: {
          taskId: taskKey === "all" ? undefined : taskKey,
          type: typeKey === "all" ? undefined : typeKey,
          category: categoryKey === CATEGORY_ALL || categoryKey === CATEGORY_UNCATEGORIZED ? undefined : categoryKey,
          accepted: acceptedKey === "all" ? undefined : acceptedKey,
          page: 1,
          pageSize: 100,
        },
      }),
    enabled: !!userId && !!teamId,
  });

  const { data, isPending, isError, error, refetch } = teamArtifactsQuery;
  const rawItems = data?.items ?? [];
  // 未分类（category IS NULL）无服务端过滤参数 → 前端过滤（仍是单查询）
  const items =
    categoryKey === CATEGORY_UNCATEGORIZED ? rawItems.filter((a) => a.category == null) : rawItems;

  // SSE 实时刷新：artifact.submitted → 重取聚合列表（artifacts 页模式，不做 taskId 过滤）
  useRealtimeEvents({ onArtifactSubmitted: () => { refetch(); } });

  // ?doc= 解析：逐行 docIdFor(title, id, 全量) 匹配（与 session 页同输入）；未知 → 空态
  const slugBases = items.map((a) => ({ id: a.id, title: a.title }));
  const slugOf = (a: TeamArtifactItem) => docIdFor(a.title, a.id, slugBases);
  const selected = docSlug ? items.find((a) => slugOf(a) === docSlug) ?? null : null;
  const docMissing = docSlug != null && items.length > 0 && selected == null;

  // 筛选联动：任一变化 → 清除选中（选中项可能已不在结果集；artifacts 页同模式）
  const handleTeamChange = (v: string) => {
    setTeamId(v || null);
    setTaskKey("all");
    setDocSlug(null);
    setProtoParam(null);
    syncUrl({ teamId: v || null, taskId: "all", doc: null, proto: null });
  };
  const handleTaskChange = (v: string) => {
    setTaskKey(v);
    setDocSlug(null);
    setProtoParam(null);
    syncUrl({ taskId: v, doc: null, proto: null });
  };
  const handleTypeChange = (v: string) => {
    setTypeKey(v);
    setDocSlug(null);
    syncUrl({ doc: null });
  };
  const handleCategoryChange = (v: string) => {
    setCategoryKey(v);
    setDocSlug(null);
    syncUrl({ doc: null });
  };
  const handleAcceptedChange = (v: string) => {
    setAcceptedKey(v);
    setDocSlug(null);
    syncUrl({ doc: null });
  };
  const handleSelect = (slug: string) => {
    setDocSlug(slug);
    syncUrl({ doc: slug });
  };
  // tab 切换：只切显隐 + 落 URL 快照（?doc=/?proto= 双保留，筛选/选择全保留）。
  // 原型 tab 团队级可用（T16）：task=all 时列全团队原型，不再设 disabled。
  const handleTabDocs = () => {
    setTab("docs");
    syncUrl({});
  };
  const handleTabProtos = () => {
    setTab("protos");
    syncUrl({});
  };
  const handleCloseViewer = () => {
    setDocSlug(null);
    syncUrl({ doc: null });
  };
  const handleDeleted = (deletedId: string) => {
    if (selected?.id === deletedId) handleCloseViewer();
    else refetch();
  };

  // 分类 chips 选项：全部 + 七类（import 词表）+ 未分类（仅这两枚 UI 标签可驻留本文件）
  const categoryOptions = [
    { key: CATEGORY_ALL, label: ALL_LABEL },
    ...ARTIFACT_CATEGORIES.map((c) => ({ key: c, label: c })),
    { key: CATEGORY_UNCATEGORIZED, label: UNCATEGORIZED_LABEL },
  ];

  return (
    <PageWindow
      testId="docs-shell"
      fluid
      style={{ backgroundColor: neutral[100], ...baseFont }}
    >
      {/* 头部：团队名 + 文档站标题 */}
      <div
        data-testid="docs-title"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
          {teamId ? (teamName ? `${teamName} · 文档站` : "文档站") : "文档站"}
        </div>
      </div>

      {/* 无 teamId → 团队选择器（不强制跳 /teams） */}
      {!urlReady || !userId ? (
        <div data-testid="docs-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
          加载中…
        </div>
      ) : !teamId ? (
        <div data-testid="docs-team-picker" style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          <div style={{ fontSize: fontSize.md, color: neutral[600] }}>选择一个团队查看其文档站</div>
          {teamsQuery.isPending ? (
            <div style={{ fontSize: fontSize.md, color: neutral[400] }}>加载团队中…</div>
          ) : teamsQuery.isError ? (
            <div data-testid="docs-error" role="alert" style={{ fontSize: fontSize.md, color: "#DC2626" }}>
              {isApiError(teamsQuery.error) ? teamsQuery.error.message : "加载团队失败"}
            </div>
          ) : teams.length === 0 ? (
            <EmptyState
              title="暂无团队"
              description="你还没有加入任何团队，先创建或加入团队后再查看文档"
              icon={<span aria-hidden>▤</span>}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              {teams.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-testid="docs-team-option"
                  data-team-id={t.id}
                  onClick={() => handleTeamChange(t.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: space.md,
                    padding: `${space.md}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>{t.name}</span>
                  <span aria-hidden style={{ color: neutral[300] }}>▸</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div data-testid="docs-tab-bar" style={{ display: "flex", height: 44, flexShrink: 0, alignItems: "center", gap: 4, borderBottom: `1px solid ${border}`, backgroundColor: surface, padding: `0 ${space.lg}px` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: radius.md, border: `1px solid ${border}`, backgroundColor: neutral[100], padding: 2 }} role="tablist" aria-label="文档站内容">
              <button type="button" role="tab" aria-selected={tab === "docs"} data-testid="docs-tab-docs" data-active={tab === "docs" ? "true" : "false"} onClick={handleTabDocs} style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: radius.sm, padding: "6px 12px", fontSize: fontSize.md, fontWeight: 500, cursor: "pointer", border: "none", fontFamily: fontFamily.body, transition: "background .15s, color .15s", ...(tab === "docs" ? { backgroundColor: surface, color: neutral[900], boxShadow: "0 1px 2px rgba(15,23,42,.06)" } : { backgroundColor: "transparent", color: neutral[500] }) }}>
                <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h16M6 20V8l6-4 6 4v12M10 20v-6h4v6" /></svg>文档
              </button>
              <button type="button" role="tab" aria-selected={tab === "protos"} data-testid="docs-tab-protos" data-active={tab === "protos" ? "true" : "false"} onClick={handleTabProtos} style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: radius.sm, padding: "6px 12px", fontSize: fontSize.md, fontWeight: 500, border: "none", fontFamily: fontFamily.body, transition: "background .15s, color .15s", cursor: "pointer", ...(tab === "protos" ? { backgroundColor: surface, color: neutral[900], boxShadow: "0 1px 2px rgba(15,23,42,.06)" } : { backgroundColor: "transparent", color: neutral[500] }) }}>
                <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>原型
                {typeof protoCount === "number" && protoCount > 0 && <span style={{ borderRadius: radius.pill, backgroundColor: neutral[200], padding: "0 6px", fontSize: 10, fontWeight: 600, lineHeight: "16px", color: neutral[600] }}>{protoCount}</span>}
              </button>
            </div>
          </div>
          {tab === "docs" ? (
          <>
          {/* 筛选栏：团队/任务双选择 + 分类/类型/验收 chips */}
          <div
            data-testid="docs-filter-bar"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              flexWrap: "wrap",
            }}
          >
            {/* 团队选择 */}
            <select
              data-testid="team-filter-select"
              value={teamId}
              onChange={(e) => handleTeamChange(e.target.value)}
              disabled={teamsQuery.isPending || teams.length === 0}
              style={{
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                color: neutral[700],
                fontSize: fontSize.md,
                fontFamily: fontFamily.body,
                cursor: teamsQuery.isPending || teams.length === 0 ? "default" : "pointer",
                maxWidth: 240,
              }}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            {/* 任务下拉（该团队任务列表；all = 全团队） */}
            <select
              data-testid="task-filter-select"
              value={taskKey}
              onChange={(e) => handleTaskChange(e.target.value)}
              disabled={tasksQuery.isPending || tasks.length === 0}
              style={{
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                color: neutral[700],
                fontSize: fontSize.md,
                fontFamily: fontFamily.body,
                cursor: tasksQuery.isPending || tasks.length === 0 ? "default" : "pointer",
                maxWidth: 240,
              }}
            >
              <option value="all">全部任务</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>

            {/* 分类 chips（全部 + 七类 + 未分类） */}
            <FilterPills
              testId="category-filter-option"
              options={categoryOptions}
              activeKey={categoryKey}
              onChange={handleCategoryChange}
            />

            {/* 类型筛（全部/结论文本/文档/文件） */}
            <FilterPills
              testId="type-filter-option"
              options={TYPE_OPTIONS}
              activeKey={typeKey}
              onChange={handleTypeChange}
            />

            {/* 验收状态筛（全部/已验收/未验收） */}
            <FilterPills
              testId="accepted-filter-option"
              options={ACCEPTED_OPTIONS}
              activeKey={acceptedKey}
              onChange={handleAcceptedChange}
            />
          </div>

          {/* 主体：文档树（左）+ 内容查看（右）；双栏视口填充 + 各自内部滚动 */}
          <div
            style={{
              display: "flex",
              gap: space.lg,
              alignItems: "stretch",
              flex: 1,
              minHeight: 0,
            }}
          >
            {/* 文档树：聚合端点无层级字段 → 平铺 */}
            <div
              data-testid="docs-tree"
              style={{
                width: 440,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                gap: space.sm,
                minHeight: 400,
                height: "calc(100vh - 280px)",
                overflow: "auto",
              }}
            >
              {isPending ? (
                <div data-testid="docs-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
                  加载中…
                </div>
              ) : isError ? (
                <div
                  data-testid="docs-error"
                  role="alert"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: space.md,
                    padding: `${space.xxl}px`,
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
                    {isApiError(error) ? error.message : "加载文档失败"}
                  </div>
                  <button
                    type="button"
                    data-testid="docs-retry"
                    onClick={() => refetch()}
                    style={{
                      padding: `${space.sm}px ${space.lg}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: "var(--color-surface)",
                      color: neutral[600],
                      fontSize: fontSize.md,
                      fontWeight: 500,
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    重试
                  </button>
                </div>
              ) : tasks.length === 0 ? (
                <EmptyState
                  title="暂无任务"
                  description="该团队下还没有任务，创建任务后即可产出文档"
                  icon={<span aria-hidden>▤</span>}
                />
              ) : items.length === 0 ? (
                <EmptyState
                  title="暂无产出物"
                  description="当前筛选条件下没有文档，调整筛选或等待 Agent 产出"
                  icon={<span aria-hidden>◌</span>}
                />
              ) : (
                items.map((item) => {
                  const slug = slugOf(item);
                  return (
                    <DocTreeRow
                      key={item.id}
                      item={item}
                      docSlug={slug}
                      active={selected?.id === item.id}
                      onSelect={() => handleSelect(slug)}
                      onDeleted={handleDeleted}
                    />
                  );
                })
              )}
            </div>

            {/* 内容查看：选中文档 → 版本查看器；未选 → 空态；未知 doc → 空态（不抛错） */}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 400, height: "calc(100vh - 280px)" }}>
              {isPending || isError ? null : docMissing ? (
                <div data-testid="docs-doc-missing">
                  <EmptyState
                    title="未找到文档"
                    description={`链接中的文档标识「${docSlug}」在当前筛选中不存在，可能已被删除或筛选条件已变化`}
                    icon={<span aria-hidden>◌</span>}
                  />
                </div>
              ) : !selected ? (
                <div data-testid="docs-viewer-empty">
                  <EmptyState
                    title="选择一篇文档"
                    description="从左侧文档树选择一篇文档查看内容与版本历史"
                    icon={<span aria-hidden>▤</span>}
                  />
                </div>
              ) : (
                <VersionViewer
                  key={selected.id}
                  artifactId={selected.id}
                  type={selected.type}
                  title={selected.title}
                  onClose={handleCloseViewer}
                />
              )}
            </div>
          </div>
          </>
          ) : (
            <div style={{ display: "flex", minHeight: 400, height: "calc(100vh - 280px)", flex: 1, flexDirection: "column", overflow: "hidden", border: `1px solid ${neutral[200]}`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)" }}>
              {taskKey !== "all" ? (
                <PrototypePanel key={`${taskKey}:${protoParam ?? ""}`} taskId={taskKey} initialProtoId={protoParam ?? undefined} />
              ) : (
                <PrototypePanel key={`team:${teamId}:${protoParam ?? ""}`} teamId={teamId ?? undefined} tasks={tasks} initialProtoId={protoParam ?? undefined} />
              )}
            </div>
          )}
        </>
      )}
    </PageWindow>
  );
}
