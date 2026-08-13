"use client";

/**
 * 产出物管理聚合页（Phase 3 T12）
 * =============================================
 * 路由：/artifacts?pid=，与 /board?pid= 同模式（父子层级：项目 → 产出物）。
 * - 项目上下文：URL ?pid= 必填，缺省且已登录 → 重定向 /projects（禁止回退 seed）。
 * - 数据架构（项目级聚合）：GET /projects/:pid/tasks 拿任务列表（下拉数据源 + 任务名映射），
 *   对每个任务 GET /tasks/:id/artifacts（T6 任务级端点，无项目级总接口 → 前端循环聚合，
 *   数量少可接受）→ 聚合全部产出物并附 taskName。
 * - 三筛：任务下拉（全部/单任务）、类型筛（全部/结论文本/文档/文件，ARTIFACT_TYPES text/doc/file）、
 *   验收状态筛（全部/已验收/未验收，acceptedFlag 基于 currentVersion）；默认全部；
 *   筛选联动 → queryKey 变化 → 重新 fetch（与 board 页状态筛选同模式，参数走后端过滤）。
 * - 列表项：类型徽章（artifactTypeTheme：text 紫 / doc 蓝 / file 绿）+ 标题 + 所属任务 +
 *   版本（v{n}）+ 作者（authorAgentId → AgentAvatar + 角色名，无则「系统」）+ 验收状态徽章
 *   （已验收绿「已验收」/ 未验收灰「未验收」）+ 时间。
 * - 版本查看器：点击行展开（inline 文档流，无浮层）→ GET /artifacts/:id 拿版本列表 →
 *   版本切换 `‹ v2 v1 ›`（当前/选中版高亮）→ GET /artifacts/:id/versions/:version 详情 →
 *   版本时间线（v2 · 时间 → v1 · 时间，当前版本在前）。
 * - 文件视图（FILE-02）：doc/file 版本渲染可点击下载链接/按钮（href=后端归一化 fileUrl，
 *   同源 /uploads/ 触发 download）+ 图片类型（png/jpg/jpeg/gif）内嵌预览 + 扩展名/大小徽章；
 *   不可访问引用（原始路径未归一化）降级为纯文本展示。
 * - 空态：无任务 / 无产出物 → EmptyState。
 * - 页面内扩展 token（artifactTypeTheme + 验收状态色 + 作者角色解析），不动 tokens.ts 基线。
 * - data-testid：artifacts-root / artifacts-title / artifacts-filter-bar / task-filter-select /
 *   type-filter-option / accepted-filter-option / artifact-row / artifact-type-badge /
 *   artifact-accepted-badge / artifact-viewer / artifact-version-switch /
 *   artifact-file-link / artifact-file-download / artifact-image-preview / artifact-file-badge /
 *   artifact-version-timeline / artifacts-loading / artifacts-error / artifacts-retry。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { AgentAvatar, EmptyState } from "@/src/components/ui";
import {
  type RoleKey,
  roles,
  roleText,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 页面内扩展 token（不动 tokens.ts 基线） ------------------------------ */
/** 产出物 API 类型（对齐 ARTIFACT_TYPES：text/doc/file）。 */
type ArtifactApiType = "text" | "doc" | "file";

/**
 * 产出物类型三色（语义对齐原型 task-detail artifactTypeTheme）：
 * 结论文本=紫 / 文档=蓝 / 文件=绿。
 */
const ARTIFACT_TYPE_THEME: Record<
  ArtifactApiType,
  { color: string; bg: string; border: string }
> = {
  text: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  doc: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  file: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
};

/** 类型中文名（三筛标签 / 类型徽章文案）。 */
const ARTIFACT_TYPE_LABEL: Record<ArtifactApiType, string> = {
  text: "结论文本",
  doc: "文档",
  file: "文件",
};

/** 验收状态二色：已验收=绿 / 未验收=灰（对齐 statusColors 已完成/已归档语义）。 */
const ACCEPTED_THEME = {
  accepted: { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  rejected: { color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
} as const;

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

/** seed 模板 Agent id → 角色 key（对齐 board 页 AGENT_ID_ROLE 范式）。 */
const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_project_manager: "project_manager",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

/* ------------------------------ API 数据模型（T6/T14 契约） ------------------------------ */
/** GET /projects/:pid/tasks 条目（仅取下拉/任务名所需字段）。 */
interface TaskItem {
  id: string;
  projectId: string;
  title: string;
}

/** GET /projects/:pid/tasks 分页响应。 */
interface TasksResponse {
  items: TaskItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /projects 分页响应（仅取项目名供标题）。 */
interface ProjectsResponse {
  items: { id: string; name: string }[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /tasks/:id/artifacts 列表项（对齐 toArtifactListItem）。 */
interface ArtifactItem {
  id: string;
  taskId: string;
  type: ArtifactApiType;
  title: string;
  currentVersion: number;
  acceptedFlag: boolean;
  authorAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 聚合后的列表项（附带所属任务名，供列表「所属任务」列）。 */
interface ArtifactRowItem extends ArtifactItem {
  taskName: string;
}

/** GET /tasks/:id/artifacts 分页响应。 */
interface ArtifactsResponse {
  items: ArtifactItem[];
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
  /** FILE-02：doc/file 版本后端归一化派生（可访问 URL / 展示名 / 扩展名 / 磁盘字节数）。 */
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

/* ------------------------------ 工具函数 ------------------------------ */
/** ISO8601 → "YYYY-MM-DD HH:mm"（本地时区，对齐原型 Artifact.time 格式）。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 字节数 → 人类可读（B/KB/MB）；null/非法 → null（不显示大小徽章）。 */
function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 从 URL/路径提取小写扩展名（`/uploads/a.PDF` → `pdf`；无扩展名 → 空串）。 */
function extractExtFromUrl(ref: string): string {
  const base = ref.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 可内嵌预览的图片扩展名（png/jpg/jpeg/gif，其余类型仅链接/下载）。 */
const PREVIEW_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif"]);

/** 引用是否可被浏览器访问（控制面静态服务 /uploads/ 或完整 http(s) URL）。 */
function isAccessibleFileRef(ref: string): boolean {
  return ref.startsWith("/uploads/") || /^https?:\/\//i.test(ref);
}

/** authorAgentId（如 a_product）→ RoleKey；未知/自定义 Agent 返回 null（渲染「系统」）。 */
function resolveAuthorRole(agentId: string | null): RoleKey | null {
  if (!agentId) return null;
  const direct = AGENT_ID_ROLE[agentId];
  if (direct) return direct;
  const rest = agentId.startsWith("a_") ? agentId.slice(2) : agentId;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
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

/** 验收状态徽章：已验收=绿「已验收」/ 未验收=灰「未验收」。 */
function AcceptedBadge({ accepted }: { accepted: boolean }) {
  const t = accepted ? ACCEPTED_THEME.accepted : ACCEPTED_THEME.rejected;
  return (
    <span
      data-testid="artifact-accepted-badge"
      data-accepted={accepted ? "true" : "false"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: t.bg,
        border: `1px solid ${t.border}`,
        color: t.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        fontFamily: fontFamily.body,
      }}
    >
      <span
        aria-hidden
        style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: t.color, flexShrink: 0 }}
      />
      {accepted ? "已验收" : "未验收"}
    </span>
  );
}

/** 作者：authorAgentId → AgentAvatar + 角色名；无/未知 Agent → 「系统」。 */
function AuthorCell({ authorAgentId }: { authorAgentId: string | null }) {
  const role = resolveAuthorRole(authorAgentId);
  if (!role) {
    return (
      <span
        data-testid="artifact-author"
        style={{ fontSize: fontSize.xs, color: neutral[400], whiteSpace: "nowrap", fontFamily: fontFamily.body }}
      >
        系统
      </span>
    );
  }
  return (
    <span
      data-testid="artifact-author"
      data-role={role}
      style={{ display: "inline-flex", alignItems: "center", gap: space.xs, whiteSpace: "nowrap" }}
    >
      <AgentAvatar role={role} size="sm" dot={false} style={{ width: 18, height: 18, fontSize: 8 }} />
      <span style={{ color: roleText[role], fontWeight: 500, fontSize: fontSize.xs }}>{roles[role].label}</span>
    </span>
  );
}

/* ------------------------------ 文件视图（doc/file 产出物，FILE-02） ------------------------------ */
/**
 * doc/file 版本内容区：可访问引用 → 图片内嵌预览 + 下载链接/按钮 + 扩展名/大小徽章；
 * 不可访问引用（原始路径未归一化）→ 降级为旧纯文本展示。
 */
function ArtifactFileView({ version }: { version: ArtifactVersionDto }) {
  const fileUrl = version.fileUrl ?? version.contentRef;
  const ext = version.fileExt || extractExtFromUrl(fileUrl);
  const displayName =
    version.fileName || fileUrl.split(/[\\/]/).pop() || fileUrl;
  const sizeLabel = formatBytes(version.fileSize ?? null);
  // P2：/uploads/ 前缀 + fileSize==null（后端 statSync 失败信号）→ 磁盘文件实际不存在，
  // URL 虽可解析但点击 404 → 并入不可访问判定走纯文本降级
  const fileMissing = fileUrl.startsWith("/uploads/") && version.fileSize == null;
  const accessible = isAccessibleFileRef(fileUrl) && !fileMissing;
  const isImage = PREVIEW_IMAGE_EXTS.has(ext);
  // 同源 /uploads/ 引用可触发浏览器 download；外部 URL download 无效 → 仅新标签打开
  const canDownload = fileUrl.startsWith("/uploads/");

  if (!accessible) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, fontSize: fontSize.sm, color: neutral[500] }}>
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>▤</span>
          文件引用：{version.filePath ?? version.contentRef}
        </span>
        {version.sha256 && (
          <span style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono }}>
            sha256: {version.sha256.slice(0, 16)}…
          </span>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      {isImage && (
        <img
          data-testid="artifact-image-preview"
          src={fileUrl}
          alt={displayName}
          loading="lazy"
          style={{
            maxWidth: "100%",
            maxHeight: 240,
            objectFit: "contain",
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: neutral[50],
          }}
        />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <a
          data-testid="artifact-file-link"
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            color: "#2563EB",
            fontSize: fontSize.sm,
            fontWeight: 500,
            textDecoration: "none",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>▤</span>
          {displayName}
        </a>
        {ext && (
          <span
            data-testid="artifact-file-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: `1px ${space.sm}px`,
              borderRadius: radius.sm,
              backgroundColor: "#EFF6FF",
              border: "1px solid #BFDBFE",
              color: "#2563EB",
              fontSize: fontSize.xs,
              fontWeight: 500,
              fontFamily: fontFamily.body,
            }}
          >
            {ext.toUpperCase()}
          </span>
        )}
        {sizeLabel && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: `1px ${space.sm}px`,
              borderRadius: radius.sm,
              backgroundColor: neutral[50],
              border: `1px solid ${neutral[200]}`,
              color: neutral[500],
              fontSize: fontSize.xs,
              fontFamily: fontFamily.mono,
            }}
          >
            {sizeLabel}
          </span>
        )}
        <a
          data-testid="artifact-file-download"
          href={fileUrl}
          {...(canDownload ? { download: true } : {})}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `3px ${space.md}px`,
            borderRadius: radius.sm,
            border: "none",
            backgroundColor: "#2563EB",
            color: "#FFFFFF",
            fontSize: fontSize.sm,
            fontWeight: 500,
            textDecoration: "none",
            cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>↓</span>
          下载
        </a>
      </div>
      {version.sha256 && (
        <span style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono }}>
          sha256: {version.sha256.slice(0, 16)}…
        </span>
      )}
    </div>
  );
}

/* ------------------------------ 版本查看器（点击行展开，inline 文档流） ------------------------------ */
interface VersionViewerProps {
  artifactId: string;
  type: ArtifactApiType;
  title: string;
  onClose: () => void;
}

function VersionViewer({ artifactId, type, title, onClose }: VersionViewerProps) {
  // 当前选中版本：缺省 = currentVersion（detail 返回后可用）；点击版本切换更新
  const [activeVersion, setActiveVersion] = useState<number | null>(null);

  // 版本列表（版本切换 `‹ v2 v1 ›` 数据源）
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
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: shadow.sm,
        overflow: "hidden",
        marginTop: space.sm,
        ...baseFont,
      }}
    >
      {/* 查看器头部：类型徽章 + 标题 + 版本切换 + 收起 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
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
          {/* 版本切换：‹ v2 v1 ›，当前/选中版高亮 */}
          <div
            aria-label="版本切换"
            data-testid="artifact-version-switch"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              backgroundColor: "#FFFFFF",
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
              backgroundColor: "#FFFFFF",
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

      {/* 内容区：text → contentRef 正文预览；doc/file → 可访问文件视图（链接/下载/图片预览，FILE-02） */}
      <div
        style={{
          minHeight: 96,
          maxHeight: 320,
          overflow: "auto",
          padding: `${space.xl}px`,
          fontSize: fontSize.md,
          lineHeight: 1.7,
          color: neutral[700],
          whiteSpace: "pre-wrap",
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
          type === "text" ? (
            versionQuery.data.contentRef
          ) : (
            <ArtifactFileView version={versionQuery.data} />
          )
        ) : null}
      </div>

      {/* 底部元信息：当前版本 + 版本时间线（当前版本在前） */}
      <div
        data-testid="artifact-version-timeline"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
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

/* ------------------------------ 列表行 ------------------------------ */
interface ArtifactRowProps {
  item: ArtifactRowItem;
  expanded: boolean;
  onToggle: () => void;
}

function ArtifactRow({ item, expanded, onToggle }: ArtifactRowProps) {
  return (
    <div
      data-testid="artifact-row"
      data-artifact-id={item.id}
      data-expanded={expanded ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: expanded ? "#FFFFFF" : neutral[50],
        border: `1px solid ${expanded ? roleText.product : neutral[200]}`,
        borderRadius: radius.md,
        boxShadow: expanded ? shadow.sm : "none",
        ...baseFont,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
          border: "none",
          background: "transparent",
          padding: `${space.md}px ${space.lg}px`,
          display: "flex",
          alignItems: "center",
          gap: space.md,
          fontFamily: fontFamily.body,
        }}
      >
        <ArtifactTypeBadge type={item.type} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: fontSize.md,
            fontWeight: 600,
            color: neutral[800],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.title}
        </span>
        <span
          style={{
            flexShrink: 0,
            maxWidth: 180,
            fontSize: fontSize.xs,
            color: neutral[400],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          所属任务：{item.taskName}
        </span>
        <span
          data-testid="artifact-version"
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
        <span style={{ flexShrink: 0 }}>
          <AuthorCell authorAgentId={item.authorAgentId} />
        </span>
        <span style={{ flexShrink: 0 }}>
          <AcceptedBadge accepted={item.acceptedFlag} />
        </span>
        <span style={{ flexShrink: 0, fontSize: fontSize.xs, color: neutral[400], whiteSpace: "nowrap" }}>
          {formatTime(item.createdAt)}
        </span>
        <span aria-hidden style={{ flexShrink: 0, fontSize: fontSize.sm, color: neutral[300], transition: "transform .15s ease", transform: expanded ? "rotate(90deg)" : "none" }}>
          ▸
        </span>
      </button>
      {expanded && (
        <VersionViewer
          key={item.id}
          artifactId={item.id}
          type={item.type}
          title={item.title}
          onClose={onToggle}
        />
      )}
    </div>
  );
}

/* ------------------------------ 页面（AppShell 内容区） ------------------------------ */
export default function ArtifactsPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  const router = useRouter();

  // pid：URL ?pid= 必填；无 pid 且已登录 → 重定向 /projects（effect 内读 window，避免 SSR 水合不一致）
  const [pid, setPid] = useState<string | null>(null);
  // 三筛状态（默认全部）
  const [taskKey, setTaskKey] = useState("all");
  const [typeKey, setTypeKey] = useState("all");
  const [acceptedKey, setAcceptedKey] = useState("all");
  // 版本查看器展开（当前选中产出物 id；null = 全部收起）
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const urlPid = new URLSearchParams(window.location.search).get("pid");
    if (urlPid) {
      setPid(urlPid);
    } else if (userId) {
      router.replace("/projects");
    }
  }, [userId, router]);

  // 项目名：复用 ["projects"] 缓存（与 board 页同 key 共享），缺失回退固定标题
  const projectName = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectsResponse>("/projects"),
    enabled: !!userId && !!pid,
  }).data?.items.find((p) => p.id === pid)?.name;

  // 聚合查询：任务列表 → 对目标任务循环请求产出物（任务下拉过滤目标集合，type/accepted 走请求参数）
  const artifactsQuery = useQuery({
    queryKey: ["artifacts", pid, taskKey, typeKey, acceptedKey] as const,
    queryFn: async () => {
      const tasksResp = await api.get<TasksResponse>(`/projects/${pid}/tasks`, {
        query: { page: 1, pageSize: 100 },
      });
      const tasks = tasksResp.items;
      const targetTasks = taskKey === "all" ? tasks : tasks.filter((t) => t.id === taskKey);
      const results = await Promise.all(
        targetTasks.map(async (task) => {
          const resp = await api.get<ArtifactsResponse>(`/tasks/${task.id}/artifacts`, {
            query: {
              type: typeKey === "all" ? undefined : typeKey,
              accepted: acceptedKey === "all" ? undefined : acceptedKey,
              page: 1,
              pageSize: 100,
            },
          });
          return resp.items.map((a) => ({ ...a, taskName: task.title }));
        })
      );
      return { tasks, items: results.flat() as ArtifactRowItem[] };
    },
    enabled: !!userId && !!pid,
  });

  const { data, isPending, isError, error, refetch } = artifactsQuery;
  const tasks = data?.tasks ?? [];
  const items = data?.items ?? [];

  // SSE 实时刷新：任何任务提交产出物（artifact.submitted，task scope）→ 重取整个聚合列表
  // （复用 useRealtimeEvents 全局单例连接，不新增连接；不做 taskId 过滤——聚合页语义，刷新全部）
  useRealtimeEvents({ onArtifactSubmitted: () => { refetch(); } });

  // 筛选联动：任务/类型/验收任一变化 → 收起展开的查看器（选中项可能已不在结果集）
  const handleTaskChange = (v: string) => {
    setTaskKey(v);
    setSelectedId(null);
  };
  const handleTypeChange = (v: string) => {
    setTypeKey(v);
    setSelectedId(null);
  };
  const handleAcceptedChange = (v: string) => {
    setAcceptedKey(v);
    setSelectedId(null);
  };

  return (
    <div
      data-testid="artifacts-root"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[100],
        ...baseFont,
      }}
    >
      {/* 头部：项目名 + 产出物管理 */}
      <div
        data-testid="artifacts-title"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
          padding: `${space.lg}px ${space.xl}px 0`,
        }}
      >
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>
          {projectName ? `${projectName} · 产出物管理` : "产出物管理"}
        </div>
      </div>

      {/* 三筛：任务下拉 + 类型筛 + 验收状态筛 */}
      <div
        data-testid="artifacts-filter-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.md,
          flexWrap: "wrap",
          padding: `${space.lg}px ${space.xl}px 0`,
        }}
      >
        {/* 任务下拉（该项目任务列表） */}
        <select
          data-testid="task-filter-select"
          value={taskKey}
          onChange={(e) => handleTaskChange(e.target.value)}
          disabled={isPending || tasks.length === 0}
          style={{
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "#FFFFFF",
            color: neutral[700],
            fontSize: fontSize.md,
            fontFamily: fontFamily.body,
            cursor: isPending || tasks.length === 0 ? "default" : "pointer",
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

        {/* 类型筛（全部/结论文本/文档/文件） */}
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          {TYPE_OPTIONS.map((opt) => {
            const isActive = opt.key === typeKey;
            return (
              <button
                key={opt.key}
                type="button"
                data-testid="type-filter-option"
                data-key={opt.key}
                data-active={isActive ? "true" : "false"}
                onClick={() => handleTypeChange(opt.key)}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.pill,
                  border: `1px solid ${isActive ? "#2563EB" : neutral[200]}`,
                  backgroundColor: isActive ? "#2563EB" : "#FFFFFF",
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

        {/* 验收状态筛（全部/已验收/未验收） */}
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          {ACCEPTED_OPTIONS.map((opt) => {
            const isActive = opt.key === acceptedKey;
            return (
              <button
                key={opt.key}
                type="button"
                data-testid="accepted-filter-option"
                data-key={opt.key}
                data-active={isActive ? "true" : "false"}
                onClick={() => handleAcceptedChange(opt.key)}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.pill,
                  border: `1px solid ${isActive ? "#2563EB" : neutral[200]}`,
                  backgroundColor: isActive ? "#2563EB" : "#FFFFFF",
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
      </div>

      {/* 产出物列表（聚合 + 行内展开版本查看器） */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: space.xl,
          display: "flex",
          flexDirection: "column",
          gap: space.sm,
        }}
      >
        {isPending ? (
          <div data-testid="artifacts-loading" style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>
            加载中…
          </div>
        ) : isError ? (
          <div
            data-testid="artifacts-error"
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
              {isApiError(error) ? error.message : "加载产出物失败"}
            </div>
            <button
              type="button"
              data-testid="artifacts-retry"
              onClick={() => refetch()}
              style={{
                padding: `${space.sm}px ${space.lg}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "#FFFFFF",
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
            description="该项目下还没有任务，创建任务后即可产出文档"
            icon={<span aria-hidden>▤</span>}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="暂无产出物"
            description="当前筛选条件下没有产出物，调整筛选或等待 Agent 产出"
            icon={<span aria-hidden>◌</span>}
          />
        ) : (
          items.map((item) => (
            <ArtifactRow
              key={item.id}
              item={item}
              expanded={selectedId === item.id}
              onToggle={() => setSelectedId(selectedId === item.id ? null : item.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
