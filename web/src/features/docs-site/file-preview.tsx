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
 * - `docx` → docx-preview 渲染（懒加载，浏览器原生不支持 office ⇒ 前端库解析）。
 * - `xlsx/xls/xlsm` → SheetJS 解析后按表格渲染（多 sheet 切换、行/列封顶）。
 * - 两类失败均回退下载卡（不阻塞阅读）；`doc/xls` 老二进制格式仍走下载卡。
 * - `/uploads` 引用 + `fileSize==null` → 不可访问降级（artifacts 页 P2 判定）。
 * 约束：零预览依赖、不做 HTML 注入渲染、不加 markdown HTML 插件、无 innerHTML/object/embed。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
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
 * Office 预览集合（浏览器**不原生支持** OOXML，必须前端库解析）：
 * - docx → `docx-preview`（Apache-2.0）渲染成 HTML；
 * - xlsx/xls/xlsm → `xlsx`（SheetJS，Apache-2.0）解析后由 React 渲成表格。
 * 老二进制 `.doc`（Word 97）不在支持范围 → 回退下载卡。
 * 两个库都**动态 import**：不打进首屏 bundle，只在真的打开 office 文件时才加载。
 */
const DOCX_PREVIEW_EXTS = new Set(["docx"]);
const SHEET_PREVIEW_EXTS = new Set(["xlsx", "xls", "xlsm"]);

/** office 文件预览体积上限（超过直接给下载卡，避免在浏览器里卡死）。 */
const OFFICE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** 表格预览封顶：最多 200 行 × 40 列（超出提示"仅预览前 N 行"）。 */
const SHEET_MAX_ROWS = 200;
const SHEET_MAX_COLS = 40;

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
          {...(canDownload ? { download: displayName || true } : {})}
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
        {...(fileUrl.startsWith("/uploads/") ? { download: displayName || true } : {})}
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
    <div data-testid="docs-content-view" data-render="pdf" style={{ display: "flex", flexDirection: "column", gap: space.sm, height: "100%", minHeight: 0, ...baseFont }}>
      <iframe
        data-testid="docs-pdf-frame"
        sandbox="allow-same-origin"
        src={fileUrl}
        title={title}
        onError={() => setFailed(true)}
        onLoad={() => setLoaded(true)}
        style={{
          display: "block",
          width: "100%",
          // 与 office 预览一致：铺满内容区高度（滚动交给 PDF 阅读器自身）
          flex: "1 1 auto",
          minHeight: 320,
          border: `1px solid ${neutral[200]}`,
          borderRadius: radius.md,
          backgroundColor: neutral[50],
        }}
      />
    </div>
  );
}

/* ------------------------------ Office：Word（docx-preview） ------------------------------ */

/** office 预览的公共外壳：标题行 + 状态（加载/失败）+ 内容容器。 */
function OfficeShell({
  title,
  status,
  children,
}: {
  title: string;
  status: "loading" | "ready" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid="docs-content-view"
      data-render="office"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        // 撑满内容区（父链：docs 内容区 flex:1 → capture 包裹层 height:100% →
        // 这里的 height:100%）。office 预览是"看整页"的场景，下面留一大片空白
        // 是纯浪费（2026-11-06 用户反馈：下面还有很多空间，要铺满）。
        height: "100%",
        minHeight: 0,
        ...baseFont,
      }}
    >
      {status === "loading" && (
        <div data-testid="docs-office-loading" style={{ fontSize: fontSize.sm, color: neutral[500] }}>
          正在解析「{title}」…
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Word 预览：`docx-preview.renderAsync` 把 docx 渲染成 DOM（分页样式近似 Word）。
 * 失败（非 docx / 加密 / 解析异常）→ 回退下载卡，不阻塞阅读。
 */
function DocxFilePreview({
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        if ((version.fileSize ?? 0) > OFFICE_PREVIEW_MAX_BYTES) {
          throw new Error("文件过大，不做预览");
        }
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const { renderAsync } = await import("docx-preview");
        const host = hostRef.current;
        if (!host || cancelled) return;
        host.replaceChildren();
        await renderAsync(buf, host, undefined, {
          className: "vteam-docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
        });
        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUrl, version.fileSize]);

  if (status === "error") {
    return <DownloadCard version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }
  return (
    <OfficeShell title={title} status={status}>
      <div
        ref={hostRef}
        data-testid="docs-docx-body"
        style={{
          border: `1px solid ${neutral[200]}`,
          borderRadius: radius.md,
          padding: space.md,
          backgroundColor: neutral[50],
          // 填满剩余高度，滚动发生在预览内部（头部的标题/页签保持可见）
          flex: "1 1 auto",
          minHeight: 0,
          overflow: "auto",
        }}
      />
    </OfficeShell>
  );
}

/* ------------------------------ Office：Excel（SheetJS） ------------------------------ */

interface SheetTable {
  name: string;
  rows: string[][];
  totalRows: number;
}

/**
 * Excel 预览：SheetJS 解析 → **由 React 渲染表格**（不用 `sheet_to_html` 的
 * innerHTML 注入，单元格内容始终是文本节点，无 XSS 面）。多 sheet 可切换，
 * 行/列封顶（防超大表卡死浏览器）。
 */
function SheetFilePreview({
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
  const [sheets, setSheets] = useState<SheetTable[] | null>(null);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setFailed(false);
    setActive(0);
    (async () => {
      try {
        if ((version.fileSize ?? 0) > OFFICE_PREVIEW_MAX_BYTES) {
          throw new Error("文件过大，不做预览");
        }
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const XLSX = await import("xlsx");
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const parsed: SheetTable[] = wb.SheetNames.slice(0, 20).map((name) => {
          const ws = wb.Sheets[name];
          const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
            header: 1,
            raw: false,
            defval: "",
            blankrows: false,
          });
          return {
            name,
            rows: raw
              .slice(0, SHEET_MAX_ROWS)
              .map((row) => (row ?? []).slice(0, SHEET_MAX_COLS).map((cell) => String(cell ?? ""))),
            totalRows: raw.length,
          };
        });
        if (!cancelled) setSheets(parsed);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUrl, version.fileSize]);

  if (failed) {
    return <DownloadCard version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }
  if (sheets === null) {
    return (
      <OfficeShell title={title} status="loading">
        <span />
      </OfficeShell>
    );
  }
  if (sheets.length === 0) {
    return <DownloadCard version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
  }

  const sheet = sheets[Math.min(active, sheets.length - 1)];
  return (
    <OfficeShell title={title} status="ready">
      {sheets.length > 1 && (
        <div style={{ display: "flex", gap: space.xs, flexWrap: "wrap" }}>
          {sheets.map((item, index) => (
            <button
              key={item.name}
              type="button"
              data-testid="docs-sheet-tab"
              onClick={() => setActive(index)}
              style={{
                padding: `2px ${space.sm}px`,
                borderRadius: radius.sm,
                border: `1px solid ${index === active ? "#0D9488" : neutral[200]}`,
                backgroundColor: index === active ? "rgba(13,148,136,0.10)" : "#FFF",
                color: index === active ? "#0D9488" : neutral[600],
                fontSize: fontSize.xs,
                fontFamily: fontFamily.body,
                cursor: "pointer",
              }}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      <div data-testid="docs-sheet-body" style={{ overflow: "auto", flex: "1 1 auto", minHeight: 0, border: `1px solid ${neutral[200]}`, borderRadius: radius.md }}>
        <table style={{ borderCollapse: "collapse", fontSize: fontSize.xs, fontFamily: fontFamily.mono, width: "100%" }}>
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr key={rowIndex} style={{ backgroundColor: rowIndex === 0 ? neutral[50] : "#FFF" }}>
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    style={{
                      border: `1px solid ${neutral[200]}`,
                      padding: `2px ${space.sm}px`,
                      whiteSpace: "pre-wrap",
                      maxWidth: 320,
                      verticalAlign: "top",
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.totalRows > sheet.rows.length && (
        <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>
          仅预览前 {sheet.rows.length} 行（共 {sheet.totalRows} 行），完整内容请下载查看。
        </div>
      )}
    </OfficeShell>
  );
}

/* ------------------------------ 主组件：渲染矩阵 ------------------------------ */

/**
 * 下载/展示文件名：优先原始名，**老数据**回退到「标题 + 扩展名」。
 *
 * 背景（2026-11-06 缺陷）：产出物落盘时用的是 `<uuid>.<ext>`，原始名没持久化，
 * 于是下载下来是一串编号。新数据已把原始名嵌进磁盘名（`<uuid>__<原名>`），
 * 服务端 describeFileRef 会还原；但**历史文件**磁盘名仍是裸 UUID，事后无法还原，
 * 这里用产出物标题（就是用户看到的那个名字）+ 扩展名兜底。
 */
const BARE_UUID_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/i;

function humanFileName(
  fileName: string | undefined,
  title: string,
  fileUrl: string,
  ext: string,
): string {
  const raw = fileName || fileUrl.split(/[\\/]/).pop() || "";
  if (BARE_UUID_NAME.test(raw)) {
    const e = ext || raw.split(".").pop() || "";
    const base = (title || "").trim();
    if (base) return e ? `${base}.${e}` : base;
  }
  return raw || title || "";
}

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
  const displayName = humanFileName(version.fileName, title, fileUrl, ext);
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

  if (DOCX_PREVIEW_EXTS.has(ext)) {
    return (
      <DocxFilePreview
        version={version}
        fileUrl={fileUrl}
        ext={ext}
        displayName={displayName}
        title={title}
      />
    );
  }

  if (SHEET_PREVIEW_EXTS.has(ext)) {
    return (
      <SheetFilePreview
        version={version}
        fileUrl={fileUrl}
        ext={ext}
        displayName={displayName}
        title={title}
      />
    );
  }

  // 未知 / 老二进制格式（doc、xls 以外的 .doc）/ 无预览分支 → 下载卡。
  return <DownloadCard version={version} fileUrl={fileUrl} ext={ext} displayName={displayName} title={title} />;
}
