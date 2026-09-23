"use client";

/**
 * DocExportButtons — 文档版本头部的导出动作（导出 PDF / 下载原始 MD）
 * =====================================================================
 * - 支持判定：`text` 类型恒可；`file` 类型仅 `md`/`markdown` 扩展名可（对齐
 *   `resolveMarkdownSource`）。
 * - 忙态互斥：同一时刻仅一个动作；忙时两钮禁用，活动钮显示加载文案。
 * - 反馈：`role="status"`（成功，3s 自动消失）/ `role="alert"`（失败，驻留至下次操作）。
 * - 内联样式对齐查看器头部（tokens 取色），无新 CSS / 无 Tailwind 依赖。
 */
import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { isApiError } from "@/lib/errors";
import { fontSize, fontFamily, neutral, radius, space } from "@/src/theme/tokens";
import { downloadTextAsFile, exportNodeToPdf, resolveMarkdownSource } from "./doc-export";

/** 导出所需的版本载荷（结构化兼容 ArtifactVersionDto）。 */
export interface DocExportVersion {
  version: number;
  contentRef: string;
  fileUrl?: string;
  fileName?: string;
  fileExt?: string;
}

export interface DocExportButtonsProps {
  /** PDF 截图目标（版本内容包裹节点）。 */
  captureRef: RefObject<HTMLElement | null>;
  type: "text" | "doc" | "file";
  version: DocExportVersion;
  /** 产出物标题（缺省文件名来源）。 */
  title: string;
}

type Busy = "pdf" | "md" | null;
type Status = { kind: "success" | "error"; text: string } | null;

/** 成功/失败状态色（与查看器错误红一致）。 */
const SUCCESS_COLOR = "#059669";
const ERROR_COLOR = "#DC2626";

/** 从版本/标题派生安全文件基名：优先人类可读标题（fileName 常为 UUID），去扩展名 + 非法字符替换 + `-vN` 后缀。 */
function exportBaseName(version: DocExportVersion, title: string): string {
  const raw = (title || version.fileName) || "document";
  const withoutExt = raw.replace(/\.[^.]+$/, "");
  const sanitized = withoutExt
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
  const base = sanitized || "document";
  return `${base}-v${version.version}`;
}

/** 错误文案：ApiError → Error → 兜底。 */
function messageOf(err: unknown, fallback: string): string {
  if (isApiError(err)) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function DocExportButtons({ captureRef, type, version, title }: DocExportButtonsProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState<Status>(null);

  const ext = (version.fileExt ?? "").toLowerCase();
  const canExport = type === "text" || ext === "md" || ext === "markdown";
  const base = exportBaseName(version, title);

  // 成功反馈 3s 自动消失；错误驻留至下一次操作。
  useEffect(() => {
    if (status?.kind !== "success") return;
    const timer = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(timer);
  }, [status]);

  const handlePdf = async () => {
    if (busy) return;
    const node = captureRef.current;
    if (!node) {
      setStatus({ kind: "error", text: "导出 PDF 失败，请稍后重试" });
      return;
    }
    setBusy("pdf");
    setStatus(null);
    try {
      await exportNodeToPdf(node, `${base}.pdf`);
      setStatus({ kind: "success", text: "已导出 PDF" });
    } catch (err) {
      setStatus({ kind: "error", text: messageOf(err, "导出 PDF 失败，请稍后重试") });
    } finally {
      setBusy(null);
    }
  };

  const handleMd = async () => {
    if (busy) return;
    setBusy("md");
    setStatus(null);
    try {
      const markdown = await resolveMarkdownSource(type, version);
      if (!markdown) {
        setStatus({ kind: "error", text: "下载 Markdown 失败" });
        return;
      }
      downloadTextAsFile(markdown, `${base}.md`);
      setStatus({ kind: "success", text: "已下载 Markdown" });
    } catch (err) {
      setStatus({ kind: "error", text: messageOf(err, "下载 Markdown 失败") });
    } finally {
      setBusy(null);
    }
  };

  const buttonStyle = (disabled: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    padding: "3px 10px",
    border: `1px solid ${neutral[200]}`,
    background: "var(--color-surface)",
    color: neutral[600],
    borderRadius: radius.sm,
    cursor: disabled ? (canExport ? "default" : "not-allowed") : "pointer",
    fontFamily: fontFamily.body,
    fontSize: fontSize.sm,
    whiteSpace: "nowrap",
    opacity: canExport ? 1 : 0.5,
  });

  const disabled = busy !== null || !canExport;
  const disabledTitle = canExport ? undefined : "仅 Markdown 文档支持导出";

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: space.sm }}>
      <button
        type="button"
        data-testid="docs-export-pdf"
        onClick={handlePdf}
        disabled={disabled}
        title={disabledTitle}
        style={buttonStyle(disabled)}
      >
        {busy === "pdf" ? "导出中…" : "导出 PDF"}
      </button>
      <button
        type="button"
        data-testid="docs-download-md"
        onClick={handleMd}
        disabled={disabled}
        title={disabledTitle}
        style={buttonStyle(disabled)}
      >
        {busy === "md" ? "准备中…" : "下载 MD"}
      </button>
      {status && (
        <span
          role={status.kind === "error" ? "alert" : "status"}
          data-testid="docs-export-status"
          data-kind={status.kind}
          style={{
            fontFamily: fontFamily.body,
            fontSize: fontSize.xs,
            color: status.kind === "error" ? ERROR_COLOR : SUCCESS_COLOR,
            whiteSpace: "nowrap",
          }}
        >
          {status.text}
        </span>
      )}
    </div>
  );
}
