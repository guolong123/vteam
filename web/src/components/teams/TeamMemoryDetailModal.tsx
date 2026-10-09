"use client";

/**
 * TeamMemoryDetailModal：记忆详情弹窗（团队「记忆」子 Tab 点击卡片弹出）。
 *
 * 显示语义对齐 /system/memories 管理页的 MemoryDetailDrawer（正文 Markdown 全文 +
 * 元信息块 + 主题标签 + 底部操作），差异只在于：
 * - 容器用 DocModalShell（右侧面板系列的共用弹窗外壳，Esc / 遮罩关闭），而非管理页的右侧抽屉；
 * - 没有注入开关（本 tab 只读，操作只有归档治理：禁用/删除 · 恢复/永久删除），
 *   且操作门沿用卡片同一套 `canOperate`（团队行恒可，全局行仅 admin）。
 *
 * 纯展示 + 转发操作：不取数（数据全部来自列表行 MemoryItem）。
 */
import { DocModalShell } from "@/src/components/teams/DocModalShell";
import type { MemoryItem } from "@/src/api/memories";
import { Markdown } from "@/src/components/ui";
import {
  absoluteTime,
  AutoInjectBadge,
  formatRelativeTime,
  LevelBadge,
  MergedMarker,
  RefCountBadge,
  safeRefCount,
  TopicChips,
  TypeChips,
} from "@/src/components/teams/memoryParts";
import {
  fontFamily,
  fontSize,
  neutral,
  radius,
  space,
  surface,
} from "@/src/theme/tokens";

/** 正文块最大高度（超出内部滚动，与管理页 DRAWER_BODY_MAX_H 同量级）。 */
const BODY_MAX_HEIGHT = 320;

const metaRowStyle = {
  display: "flex",
  gap: space.xs,
  wordBreak: "break-word",
} as const;

const metaKeyStyle = { color: neutral[400], flexShrink: 0 } as const;

const actionButtonStyle = {
  padding: `${space.xs}px ${space.sm + 2}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: surface,
  color: neutral[600],
  fontSize: fontSize.xs,
  fontFamily: fontFamily.body,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
} as const;

const dangerButtonStyle = {
  ...actionButtonStyle,
  color: "#DC2626",
  border: "1px solid rgba(220,38,38,0.28)",
} as const;

const disabledActionStyle = { opacity: 0.6, cursor: "default" } as const;

export interface TeamMemoryDetailModalProps {
  /** 当前展示的记忆（null = 关闭）。 */
  memory: MemoryItem | null;
  /** 已归档视图（决定底部是「恢复/永久删除」还是「禁用/删除」）。 */
  archived: boolean;
  /** 与卡片同一套权限口径：团队行 true，全局行仅 admin。 */
  canOperate: boolean;
  /** 该行有 mutation 在途。 */
  pending: boolean;
  onArchive: (memory: MemoryItem) => void;
  onRestore: (memory: MemoryItem) => void;
  onRequestPurge: (memory: MemoryItem) => void;
  onClose: () => void;
}

export function TeamMemoryDetailModal({
  memory,
  archived,
  canOperate,
  pending,
  onArchive,
  onRestore,
  onRequestPurge,
  onClose,
}: TeamMemoryDetailModalProps) {
  if (!memory) return null;

  const description = memory.description?.trim() || "";
  // 已合并行不可恢复（refCount 已转移给目标行，再恢复会二次计数）。
  const merged = !!memory.mergedIntoId;

  return (
    <DocModalShell
      testid="team-memory-detail-modal"
      title={description || "记忆详情"}
      subtitle={formatRelativeTime(memory.createdAt)}
      subtitleTestid="team-memory-detail-created-at"
      closeTestid="team-memory-detail-close"
      onClose={onClose}
    >
      <div
        data-testid="team-memory-detail-body"
        style={{ display: "flex", flexDirection: "column", gap: space.md }}
      >
        {/* ① 芯片行：类型 · 级别 · 自动注入 · 引用次数 · 合并标记 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: space.sm,
          }}
        >
          <TypeChips tags={memory.tags} />
          <LevelBadge level={memory.level} />
          <AutoInjectBadge on={!!memory.autoInject} />
          <RefCountBadge
            count={memory.refCount}
            lastUsedAt={memory.lastUsedAt}
          />
          {memory.mergedIntoId && (
            <MergedMarker mergedIntoId={memory.mergedIntoId} />
          )}
        </div>

        {/* ② 标题（description；卡片与正文标题同源） */}
        {description && (
          <div
            data-testid="team-memory-detail-title"
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[800],
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {description}
          </div>
        )}

        {/* ③ 元信息块（对齐管理页 memory-drawer-meta 的键值语义） */}
        <div
          data-testid="team-memory-detail-meta"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[100]}`,
            fontSize: fontSize.xs,
            color: neutral[500],
            lineHeight: 1.6,
          }}
        >
          <div style={metaRowStyle}>
            <span style={metaKeyStyle}>记忆 ID：</span>
            <span
              style={{ fontFamily: fontFamily.mono, color: neutral[700] }}
            >
              {memory.id}
            </span>
          </div>
          <div style={metaRowStyle}>
            <span style={metaKeyStyle}>归属：</span>
            <span>{memory.level === "global" ? "全局" : "本团队"}</span>
          </div>
          <div style={metaRowStyle}>
            <span style={metaKeyStyle}>自动注入：</span>
            <span>{memory.autoInject ? "注入中" : "仅检索"}</span>
          </div>
          <div style={metaRowStyle}>
            <span style={metaKeyStyle}>创建时间：</span>
            <span>{absoluteTime(memory.createdAt)}</span>
          </div>
          <div style={metaRowStyle}>
            <span style={metaKeyStyle}>引用次数：</span>
            <span>{safeRefCount(memory)} 次</span>
          </div>
          {memory.lastUsedAt ? (
            <div style={metaRowStyle}>
              <span style={metaKeyStyle}>最近引用：</span>
              <span>
                {absoluteTime(memory.lastUsedAt)}（
                {formatRelativeTime(memory.lastUsedAt)}）
              </span>
            </div>
          ) : null}
          {memory.mergedIntoId ? (
            <div style={metaRowStyle}>
              <span style={metaKeyStyle}>已合并至：</span>
              <span style={{ fontFamily: fontFamily.mono, color: neutral[700] }}>
                {memory.mergedIntoId}
              </span>
            </div>
          ) : null}
          <div style={metaRowStyle}>
            <span style={metaKeyStyle}>字数：</span>
            <span>{memory.content.length} 字</span>
          </div>
        </div>

        {/* ④ 正文全文（Markdown；超长内部滚动） */}
        <div
          data-testid="team-memory-detail-content"
          style={{
            padding: `${space.md}px ${space.lg}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: surface,
            fontSize: fontSize.md,
            color: neutral[800],
            maxHeight: BODY_MAX_HEIGHT,
            overflow: "auto",
          }}
        >
          <Markdown>{memory.content}</Markdown>
        </div>

        {/* ⑤ 主题标签 */}
        <TopicChips tags={memory.tags} />

        {/* ⑥ 底部操作（与卡片同一套权限门与在途禁用） */}
        {canOperate && (
          <div
            data-testid="team-memory-detail-actions"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: space.sm,
              paddingTop: space.md,
              borderTop: `1px solid ${neutral[100]}`,
            }}
          >
            {archived ? (
              <>
                <button
                  type="button"
                  data-testid="team-memory-detail-restore"
                  disabled={pending || merged}
                  title={
                    merged
                      ? "该记忆已合并到其他记忆，无法恢复；如需使用请查看目标记忆"
                      : "恢复这条记忆，使其重新生效"
                  }
                  onClick={() => onRestore(memory)}
                  style={
                    pending || merged
                      ? { ...actionButtonStyle, ...disabledActionStyle }
                      : actionButtonStyle
                  }
                >
                  恢复
                </button>
                <button
                  type="button"
                  data-testid="team-memory-detail-purge"
                  disabled={pending}
                  title="永久删除，不可恢复"
                  onClick={() => onRequestPurge(memory)}
                  style={
                    pending
                      ? { ...dangerButtonStyle, ...disabledActionStyle }
                      : dangerButtonStyle
                  }
                >
                  永久删除
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="team-memory-detail-archive"
                  disabled={pending}
                  title="禁用（归档）这条记忆，归档后可恢复"
                  onClick={() => onArchive(memory)}
                  style={
                    pending
                      ? { ...actionButtonStyle, ...disabledActionStyle }
                      : actionButtonStyle
                  }
                >
                  禁用
                </button>
                <button
                  type="button"
                  data-testid="team-memory-detail-purge"
                  disabled={pending}
                  title="永久删除，不可恢复"
                  onClick={() => onRequestPurge(memory)}
                  style={
                    pending
                      ? { ...dangerButtonStyle, ...disabledActionStyle }
                      : dangerButtonStyle
                  }
                >
                  删除
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </DocModalShell>
  );
}

export default TeamMemoryDetailModal;