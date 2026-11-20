"use client";

/**
 * /docs/file —— 文档站通用文件预览入口。
 *
 * 聊天里上传的附件（/uploads/...）本身不是 artifact，无法走 /docs?doc=；
 * 这里直接接收 url/name/ext/size 四元组并复用文档站的 FilePreview 矩阵
 * （docx/pdf/xlsx/图片/文本等），聊天附件卡点击即跳到这里预览，而不是强制下载。
 */
import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FilePreview } from "@/src/features/docs-site/file-preview";
import { fontSize, fontFamily, neutral, space, radius } from "@/src/theme/tokens";

function FilePreviewContent() {
  const params = useSearchParams();
  const router = useRouter();
  /**
   * 返回（2026-11-20 修订）：不再指向 `/docs`（无 teamId 时是"选择一个团队"的简陋
   * 列表页——用户明确反馈"返回时返回到了一个简陋的文档站"）。
   * 有应用内历史就 back（回到发起点，通常是会话页）；直接打开/刷新则回看板。
   */
  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/board");
  };
  const url = params.get("url") ?? "";
  const name = params.get("name") ?? "文件预览";
  const ext = params.get("ext") ?? "";
  const sizeRaw = params.get("size");
  const size = sizeRaw !== null && sizeRaw !== "" ? Number(sizeRaw) : 0;

  if (!url) {
    return (
      <div style={{ padding: space.xl, color: neutral[500], fontFamily: fontFamily.body }}>
        缺少文件地址（url 参数）。
      </div>
    );
  }

  return (
    <div
      data-testid="docs-file-preview-root"
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: space.md,
        padding: space.lg,
        fontFamily: fontFamily.body,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <button
          type="button"
          data-testid="docs-file-back"
          onClick={handleBack}
          style={{
            border: "none",
            background: "none",
            padding: 0,
            color: "#0D9488",
            fontSize: fontSize.sm,
            cursor: "pointer",
            fontFamily: fontFamily.body,
            textDecoration: "none",
          }}
        >
          ← 返回
        </button>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        <a
          href={url}
          download={name}
          style={{ marginLeft: "auto", color: "#0D9488", fontSize: fontSize.sm, textDecoration: "none", border: `1px solid ${neutral[200]}`, borderRadius: radius.sm, padding: "2px 10px" }}
        >
          下载原件
        </a>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          border: `1px solid ${neutral[200]}`,
          borderRadius: radius.md,
          backgroundColor: "var(--color-surface)",
          padding: space.md,
        }}
      >
        <FilePreview
          version={{
            contentRef: url,
            fileUrl: url,
            fileName: name,
            fileExt: ext,
            fileSize: Number.isFinite(size) ? size : 0,
          }}
          type="file"
          title={name}
        />
      </div>
    </div>
  );
}

export default function DocsFilePreviewPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: space.xl, color: neutral[500], fontFamily: fontFamily.body }}>
          加载中…
        </div>
      }
    >
      <FilePreviewContent />
    </Suspense>
  );
}
