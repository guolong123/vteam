"use client";

/**
 * ArtifactDocModal：计划类产出物弹窗（计划子 Tab 点击「产出物 · vN」行弹出）。
 *
 * 与 PlanDocModal 的关键差别：产出物正文**不随列表下发**（列表只给元数据），所以本组件要取数——
 * 按 `GET /artifacts/:id/versions/:version` 取当前版本载荷，再交给文档站同一套富渲染
 * `FilePreview`（text→Markdown、md→Markdown、pdf→沙箱、office→下载卡、图片→内联）。
 * 复用而非另造渲染器，保证与文档站看到的一致。
 *
 * 头部保留「在文档站打开」入口：弹窗用于快速查看，深链浏览仍在文档站。
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { DocModalShell } from "@/src/components/teams/DocModalShell";
import {
  FilePreview,
  type FilePreviewVersion,
} from "@/src/features/docs-site/file-preview";
import type { ArtifactItem } from "@/src/components/tasks/task-detail-types";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

export function ArtifactDocModal({
  artifact,
  onOpenInDocs,
  onClose,
}: {
  /** 当前展示的产出物（null=关闭）。 */
  artifact: ArtifactItem | null;
  /** 「在文档站打开」回调（缺省则不显示该入口）。 */
  onOpenInDocs?: (a: ArtifactItem) => void;
  onClose: () => void;
}) {
  const version = artifact?.currentVersion;
  const versionQuery = useQuery({
    queryKey: ["artifact", artifact?.id, "version", version],
    queryFn: () =>
      api.get<FilePreviewVersion>(
        `/artifacts/${artifact!.id}/versions/${version}`,
      ),
    enabled: !!artifact,
  });

  if (!artifact) return null;

  return (
    <DocModalShell
      testid="artifact-doc-modal"
      title={artifact.title}
      subtitle={`v${artifact.currentVersion}`}
      subtitleTestid="artifact-doc-modal-version"
      closeTestid="artifact-doc-modal-close"
      headerExtra={
        onOpenInDocs ? (
          <button
            type="button"
            data-testid="artifact-doc-modal-open-docs"
            onClick={() => onOpenInDocs(artifact)}
            style={{
              flexShrink: 0,
              border: "none",
              background: "none",
              color: "#0D9488",
              cursor: "pointer",
              fontSize: fontSize.xs,
              fontFamily: fontFamily.body,
              whiteSpace: "nowrap",
            }}
          >
            在文档站打开 →
          </button>
        ) : undefined
      }
      onClose={onClose}
    >
      {versionQuery.isPending ? (
        <div style={{ color: neutral[400] }}>加载中…</div>
      ) : versionQuery.isError ? (
        <div
          data-testid="artifact-doc-modal-error"
          role="alert"
          style={{
            color: "#DC2626",
            backgroundColor: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.14)",
            borderRadius: radius.sm,
            padding: `${space.xs}px ${space.sm}px`,
          }}
        >
          {isApiError(versionQuery.error)
            ? versionQuery.error.message
            : "产出物内容加载失败"}
        </div>
      ) : versionQuery.data ? (
        <div data-testid="artifact-doc-modal-content">
          <FilePreview
            version={versionQuery.data}
            type={artifact.type}
            title={artifact.title}
          />
        </div>
      ) : null}
    </DocModalShell>
  );
}
