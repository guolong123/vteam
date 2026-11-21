"use client";

/**
 * /docs/file —— 文档站通用文件预览入口。
 *
 * 聊天里上传的附件（/uploads/...）本身不是 artifact，无法走 /docs?doc=；
 * 这里直接接收 url/name/ext/size 四元组并复用文档站的 FilePreview 矩阵
 * （docx/pdf/xlsx/图片/文本等），聊天附件卡点击即跳到这里预览，而不是强制下载。
 */
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { FilePreview } from "@/src/features/docs-site/file-preview";
import { docIdFor } from "@/src/lib/artifact-slug";
import type { ArtifactsResponse } from "@/src/components/tasks/task-detail-types";
import { fontSize, fontFamily, neutral, space, radius } from "@/src/theme/tokens";

/**
 * 有产出物归属时，把 `/docs/file?…` **重定向**到文档站对应文档（2026-11-20）。
 *
 * 兜底路径：正常情况下消息附件已经直接指向 `/docs/:taskId?doc=`，不会再走本页。
 * 但历史链接/旧消息（附件里没有 artifactId）或外部直接打开时仍会到这里——
 * 此时若能从 artifactId 算出文档站 slug，就跳过去，让两个入口最终落到**同一界面**，
 * 避免用户看到"简陋的独立预览页"（用户多次反馈）。
 *
 * 算不出来（缺 taskId / 该任务没有产出物列表）→ 留本页正常预览（不阻断）。
 */
async function resolveDocsHref(
  queryClient: QueryClient,
  artifactId: string,
  taskId: string,
): Promise<string | null> {
  try {
    const data = await queryClient.fetchQuery({
      queryKey: ["task", taskId, "artifacts"],
      queryFn: () =>
        api.get<ArtifactsResponse>(`/tasks/${taskId}/artifacts`, {
          query: { pageSize: 100 },
        }),
    });
    const items = (data?.items ?? []) as { id: string; title: string }[];
    const target = items.find((a) => a.id === artifactId);
    if (!target) return null;
    return `/docs/${taskId}?doc=${encodeURIComponent(docIdFor(target.title, target.id, items))}`;
  } catch {
    return null;
  }
}

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
  const artifactId = params.get("artifactId") ?? "";
  const artifactTaskId = params.get("taskId") ?? "";
  /** 重定向判定中：先不渲染预览，避免"闪一下简陋页再跳走"。 */
  const [redirecting, setRedirecting] = useState(
    () => Boolean(artifactId && artifactTaskId),
  );
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!artifactId || !artifactTaskId) return;
    let cancelled = false;
    void (async () => {
      const href = await resolveDocsHref(queryClient, artifactId, artifactTaskId);
      if (cancelled) return;
      if (href) {
        router.replace(href);
        return;
      }
      // 算不出文档站地址 → 放弃重定向，留在本页正常预览
      setRedirecting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId, artifactTaskId, queryClient, router]);

  const url = params.get("url") ?? "";
  const name = params.get("name") ?? "文件预览";
  const ext = params.get("ext") ?? "";
  const sizeRaw = params.get("size");
  const size = sizeRaw !== null && sizeRaw !== "" ? Number(sizeRaw) : 0;

  if (redirecting) {
    return (
      <div
        data-testid="docs-file-redirecting"
        style={{ padding: space.xl, color: neutral[500], fontFamily: fontFamily.body }}
      >
        正在打开文档…
      </div>
    );
  }

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
