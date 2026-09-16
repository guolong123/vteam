"use client";

/**
 * FilePreview — 合站富渲染矩阵（docs-artifacts-merge T9，Appendix B）
 * =============================================================
 * 单一导出组件，接缝 props 与合站页内联 `DocContentView` 一致：
 * `FilePreview({ version, type, title })`。合站页只 import，不内联。
 * - `type=text` → DocsMarkdown（显式 urlTransform，仅 http/https/mailto）。
 * - `md/markdown` 文件 → 取 fileUrl 文本后 DocsMarkdown；取失败回退下载卡。
 * - `txt/csv/json` → `<pre>`（256KB 截断 + 下载兜底）。
 * - 图片（沿用 IMAGE_EXTS，含 webp；svg 只许 `<img>`）→ 内嵌 `<img loading="lazy">`。
 * - `pdf` → `<iframe sandbox="allow-same-origin">`（无 allow-scripts；
 *   onError/超时回退下载卡）。
 * - `doc/docx/xls/xlsx`/未知 → 下载卡（文件名/大小/类型徽章，无预览库）。
 * - `/uploads` 引用 + `fileSize==null` → 不可访问降级（artifacts 页 P2 判定）。
 * 约束：零预览依赖、不做 HTML 注入渲染、不加 markdown HTML 插件、无 innerHTML/object/embed。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { DocsMarkdown } from "./docs-markdown";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 与合站页 DocContentView 接缝同形的版本载荷（结构化兼容，字段全可选除 contentRef）。 */
export interface FilePreviewVersion {
  contentRef: string;
  fileUrl?: string;
  fileName?: string;
  fileExt?: string;
  fileSize?: number | null;
  filePath?: string | null;
  sha256?: string | null;
}

export type FilePreviewType = "text" | "doc" | "file";

/** 图片内嵌集合（沿用 doc-explorer FileContentCard 的 IMAGE_EXTS）。 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** 纯文本预览集合（取文本后 `<pre>` 渲染）。 */
const TEXT_PREVIEW_EXTS = new Set(["txt", "csv", "json"]);

/** `<pre>` 字符截断上限（256KB）。 */
const PREVIEW_CHAR_LIMIT = 256 * 1024;

/** PDF iframe 加载超时（到期仍未 onLoad → 回退下载卡）。 */
const PDF_LOAD_TIMEOUT_MS = 15000;

/**
 * 显式 urlTransform 白名单：仅 http/https/mailto 放行，其余（含 javascript:、
 * data:、相对路径）一律返回 null（react-markdown 将省略 href，链接惰性不可点）。
 */
export function safeUrlTransform(url: string): string | null {
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  return null;
}

/** 从 URL/路径提取小写扩展名（与合站页同语义，minimal duplicate 不重构原页）。 */
function extractExtFromUrl(ref: string): string {
  const base = ref.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 字节数 → 人类可读（与合站页同语义）。 */
function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 引用是否可被浏览器访问（与合站页同语义）。 */
function isAccessibleFileRef(ref: string): boolean {
  return ref.startsWith("/uploads/") || /^https?:\/\//i.test(ref);
}

/* ------------------------------ 下载卡（复用合站页接缝卡片 markup） ------------------------------ */

function DownloadCard({
  version,
  fileUrl,
  ext,
  displayName,
  title,
}: {
  version: FilePreviewVersion;
  fileUrl: string;
  ext: string;
  displayName: string;
  title: string;
}) {
  const sizeLabel = formatBytes(version.fileSize ?? null);
  const canDownload = fileUrl.startsWith("/uploads/");
  return (
    <div data-testid="docs-content-view" data-render="file-card" style={{ display: "flex", flexDirection: "column", gap: space.md, ...baseFont }}>
      <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>{title}</div>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <a
          data-testid="docs-file-link"
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            color: "#0D9488",
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
            data-testid="docs-file-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: `1px ${space.sm}px`,
              borderRadius: radius.sm,
              backgroundColor: "rgba(13,148,136,0.10)",
              border: "1px solid rgba(13,148,136,0.22)",
              color: "#0D9488",
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
          data-testid="docs-file-download"
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
            backgroundColor: "#0D9488",
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

/* ------------------------------ 不可访问降级（P2 判定同合站页） ------------------------------ */

function InaccessibleRef({ version }: { version: FilePreviewVersion }) {
  return (
    <div data-testid="docs-content-view" data-render="inaccessible" style={{ display: "flex", flexDirection: "column", gap: space.sm, ...baseFont }}>
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

/* ------------------------------ md 文件：取文本后 DocsMarkdown ------------------------------ */

function MdFilePreview({
  version,
  fileUrl,
  ext,
  displayName,
  title,
}: {
  version: FilePreviewVersion;
  fileUrl: string;
  ext: string;
  displayName: string;
  title: string;
}) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ok"; text: string } | { status: "error" }>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(fileUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setState({ status: "ok", text });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [fileUrl]);
  if (state.status === "error") {
    return <DownloadCard version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }
  if (state.status === "loading") {
    return (
      <div data-testid="docs-content-view" data-render="md-file" style={{ fontSize: fontSize.md, color: neutral[400], ...baseFont }}>
        加载中…
      </div>
    );
  }
  return (
    <div data-testid="docs-content-view" data-render="md-file" style={baseFont}>
      <DocsMarkdown markdown={state.text} urlTransform={safeUrlTransform} />
    </div>
  );
}

/* ------------------------------ txt/csv/json：`<pre>` + 256KB 截断 + 下载兜底 ------------------------------ */

function TextFilePreview({
  version,
  fileUrl,
  ext,
  displayName,
  title,
}: {
  version: FilePreviewVersion;
  fileUrl: string;
  ext: string;
  displayName: string;
  title: string;
}) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ok"; text: string } | { status: "error" }>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(fileUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setState({ status: "ok", text });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [fileUrl]);
  if (state.status === "error") {
    return <DownloadCard version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }
  if (state.status === "loading") {
    return (
      <div data-testid="docs-content-view" data-render="text-preview" style={{ fontSize: fontSize.md, color: neutral[400], ...baseFont }}>
        加载中…
      </div>
    );
  }
  const truncated = state.text.length > PREVIEW_CHAR_LIMIT;
  const shown = truncated ? state.text.slice(0, PREVIEW_CHAR_LIMIT) : state.text;
  return (
    <div data-testid="docs-content-view" data-render="text-preview" style={{ display: "flex", flexDirection: "column", gap: space.sm, ...baseFont }}>
      <pre
        style={{
          margin: 0,
          padding: space.md,
          overflowX: "auto",
          borderRadius: radius.md,
          border: `1px solid ${neutral[200]}`,
          backgroundColor: neutral[50],
          fontSize: fontSize.sm,
          lineHeight: 1.6,
          color: neutral[800],
          fontFamily: fontFamily.mono,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {shown}
      </pre>
      {truncated && (
        <span style={{ fontSize: fontSize.xs, color: neutral[500] }}>
          内容过长，仅显示前 256KB，全文请下载查看。
        </span>
      )}
      <a
        data-testid="docs-file-download"
        href={fileUrl}
        {...(fileUrl.startsWith("/uploads/") ? { download: true } : {})}
        target="_blank"
        rel="noopener noreferrer"
        style={{ alignSelf: "flex-start", color: "#0D9488", fontSize: fontSize.sm, fontWeight: 500, textDecoration: "none", fontFamily: fontFamily.body }}
      >
        ↓ 下载{ext ? ` ${ext.toUpperCase()}` : ""}全文
      </a>
    </div>
  );
}

/* ------------------------------ pdf：沙箱 iframe + 失败回退 ------------------------------ */

function PdfPreview({
  version,
  fileUrl,
  ext,
  displayName,
  title,
}: {
  version: FilePreviewVersion;
  fileUrl: string;
  ext: string;
  displayName: string;
  title: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [fileUrl]);
  useEffect(() => {
    if (loaded || failed) return;
    const timer = setTimeout(() => setFailed(true), PDF_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [fileUrl, loaded, failed]);
  if (failed) {
    return <DownloadCard version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }
  return (
    <div data-testid="docs-content-view" data-render="pdf" style={{ display: "flex", flexDirection: "column", gap: space.sm, ...baseFont }}>
      <iframe
        data-testid="docs-pdf-frame"
        sandbox="allow-same-origin"
        src={fileUrl}
        title={title}
        onError={() => setFailed(true)}
        onLoad={() => setLoaded(true)}
        style={{ display: "block", width: "100%", height: 480, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, backgroundColor: neutral[50] }}
      />
    </div>
  );
}

/* ------------------------------ 主组件：渲染矩阵 ------------------------------ */

export function FilePreview({
  version,
  type,
  title,
}: {
  version: FilePreviewVersion;
  type: FilePreviewType;
  title: string;
}) {
  // text：contentRef 即正文 → DocsMarkdown（显式白名单 urlTransform）。
  if (type === "text") {
    return (
      <div data-testid="docs-content-view" data-render="text-md" style={baseFont}>
        <DocsMarkdown markdown={version.contentRef} urlTransform={safeUrlTransform} />
      </div>
    );
  }

  const fileUrl = version.fileUrl ?? version.contentRef;
  const ext = (version.fileExt || extractExtFromUrl(fileUrl)).toLowerCase();
  const displayName = version.fileName || fileUrl.split(/[\\/]/).pop() || title;
  // P2 判定（与合站页/孪生 artifacts 页同语义）：/uploads/ 前缀 + fileSize==null → 不可访问降级。
  const fileMissing = fileUrl.startsWith("/uploads/") && version.fileSize == null;
  const accessible = isAccessibleFileRef(fileUrl) && !fileMissing;

  if (!accessible) {
    return <InaccessibleRef version={version} />;
  }

  // 图片（含 webp；svg 只许 <img> 上下文，不做 innerHTML/object/embed）。
  if (IMAGE_EXTS.has(ext)) {
    return (
      <div data-testid="docs-content-view" data-render="image" style={{ display: "flex", flexDirection: "column", gap: space.sm, ...baseFont }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- 任意 uploads 图片 URL，无法走 next/image 优化 */}
        <img src={fileUrl} alt={displayName} loading="lazy" style={{ maxWidth: "100%", borderRadius: radius.md, border: `1px solid ${neutral[200]}` }} />
      </div>
    );
  }

  if (ext === "pdf") {
    return <PdfPreview version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }

  if (ext === "md" || ext === "markdown") {
    return <MdFilePreview version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }

  if (TEXT_PREVIEW_EXTS.has(ext)) {
    return <TextFilePreview version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }

  // doc/docx/xls/xlsx/未知 → 下载卡（零预览库）。
  return <DownloadCard version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
}
