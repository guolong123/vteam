/**
 * PlanDocModal：计划文档弹窗（任务 Tab 下"计划"子 Tab 点击本地计划文件行弹出）。
 *
 * 纯展示组件（dumb modal）：**不发请求、不取数**。列表接口
 * `GET /tasks/:id/plan-docs` 已把正文随列表一次下发，本组件只负责渲染，
 * 因此打开弹窗是零延迟的，也不会出现"列表有、点开转圈"的不一致窗口。
 *
 * 正文走 `DocsMarkdown`（react-markdown + remark-gfm + Mermaid）——计划文件是 Markdown，
 * 直接 pre-wrap 会把 `#`/表格/列表原样显示出来。复用文档站同一渲染器，样式与行为一致。
 *
 * 弹窗外壳（标题栏/Esc/遮罩）抽到 `DocModalShell`，与 ArtifactDocModal 共用。
 *
 * 数据来源是任务目录 `.opencode/plans/*.md` 的真实文件内容——vteam 不自维护
 * 计划版本，故这里不再有 vN/版本列表的概念，只显示文件名与最后修改时间。
 */
"use client";
import { DocsMarkdown } from "@/src/features/docs-site";
import { DocModalShell } from "@/src/components/teams/DocModalShell";
import { neutral, space, radius, fontSize } from "@/src/theme/tokens";

export interface PlanDocContent {
  /** 文件名（等于弹窗标题）。 */
  name: string;
  /** 最后修改时间（ISO 字符串）。 */
  updatedAt: string;
  /** 正文（可能被服务端截断）。 */
  content: string;
  /** 正文是否被截断（截断时显示提示，避免用户以为文件就这么多）。 */
  truncated?: boolean;
}

/** 相对时间展示（计划文件由 agent 反复覆盖写，绝对时间意义不大）。 */
function formatUpdatedAt(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚更新";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前更新`;
  return new Date(t).toLocaleString();
}

export function PlanDocModal({
  doc,
  onClose,
}: {
  /** 当前展示的文档（null=关闭）。 */
  doc: PlanDocContent | null;
  onClose: () => void;
}) {
  if (!doc) return null;

  return (
    <DocModalShell
      testid="plan-doc-modal"
      title={doc.name}
      subtitle={formatUpdatedAt(doc.updatedAt)}
      subtitleTestid="plan-doc-modal-updated"
      closeTestid="plan-doc-modal-close"
      onClose={onClose}
    >
      {doc.content ? (
        <div data-testid="plan-doc-modal-markdown">
          {/* 首块标题在弹窗里不需要文档页那种 32px 上边距（内联样式需 !important 覆盖） */}
          <style>{`[data-testid="plan-doc-modal-markdown"] > :first-child { margin-top: 0 !important; }`}</style>
          <DocsMarkdown markdown={doc.content} />
        </div>
      ) : (
        <span style={{ color: neutral[400] }}>（空文件）</span>
      )}
      {doc.truncated && (
        <div
          data-testid="plan-doc-modal-truncated"
          style={{
            marginTop: space.md,
            fontSize: fontSize.xs,
            color: "#B45309",
            backgroundColor: "rgba(245,158,11,0.10)",
            border: "1px solid rgba(245,158,11,0.30)",
            borderRadius: radius.md,
            padding: `${space.xs}px ${space.sm}px`,
          }}
        >
          文件较大，此处仅显示前 256KB。完整内容见任务目录 .opencode/plans/{doc.name}
        </div>
      )}
    </DocModalShell>
  );
}
