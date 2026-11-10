"use client";

/**
 * 外部用户左侧列表（契约 3.2）
 * =============================================
 * 每行：首字渐变圆头像 + 姓名 + 公司·岗位 + 最近发言时间 + 消息数徽标。
 * 空态/加载态由父级（会话页）渲染：外部用户是入站消息自动沉淀出来的，
 * 「一条都没有」和「搜索没命中」的文案不同，交给页面统一处理。
 */
import type { CSSProperties } from "react";
import type { ExternalUserListItem } from "@/src/api/external-users";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

interface ExternalUserListProps {
  items: ExternalUserListItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

/** 头像渐变板：按种子哈希取一组，保证同一用户跨刷新颜色稳定。 */
const AVATAR_PALETTES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "#818CF8", to: "#4F46E5" },
  { from: "#2DD4BF", to: "#0D9488" },
  { from: "#60A5FA", to: "#2563EB" },
  { from: "#FBBF24", to: "#EA580C" },
  { from: "#A78BFA", to: "#7C3AED" },
];

/** 外部用户头像样式：首字渐变圆（与群头像同款渐变思路，避免伪造成员角色色）。 */
export function externalUserAvatarStyle(seed: string, size: number): CSSProperties {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const palette = AVATAR_PALETTES[hash % AVATAR_PALETTES.length];
  return {
    flexShrink: 0,
    width: size,
    height: size,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundImage: `linear-gradient(135deg, ${palette.from}, ${palette.to})`,
    color: "#FFFFFF",
    fontSize: Math.round(size * 0.42),
    fontWeight: 700,
    fontFamily: fontFamily.body,
  };
}

/** 头像首字：取展示名第一个字符（空名兜底「外」）。 */
export function externalUserInitial(name: string): string {
  return name.trim().slice(0, 1) || "外";
}

/**
 * 最近发言时间：当天显示 HH:mm，今年显示 MM-DD，更早显示 YYYY-MM-DD。
 * 外部用户是低频目录，不需要「x 分钟前」这类相对时间。
 */
export function formatExternalUserTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
    });
  }
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 公司 · 岗位：两者都空时回落外部标识，保证每行有第二行信息。 */
function orgLine(item: ExternalUserListItem): string {
  const parts = [item.company, item.position].filter(
    (part): part is string => !!part && part.trim().length > 0,
  );
  if (parts.length > 0) return parts.join(" · ");
  return item.displayName || item.externalId;
}

export function ExternalUserList({
  items,
  activeId,
  onSelect,
}: ExternalUserListProps) {
  return (
    <div
      data-testid="external-user-list"
      style={{ display: "flex", flexDirection: "column", gap: 2 }}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            data-testid="external-user-item"
            data-external-user-id={item.id}
            onClick={() => onSelect(item.id)}
            style={{
              width: "100%",
              textAlign: "left",
              border: "none",
              cursor: "pointer",
              display: "flex",
              gap: space.sm,
              alignItems: "center",
              padding: `${space.sm}px ${space.sm}px`,
              borderRadius: radius.md,
              backgroundColor: active ? "rgba(13,148,136,0.10)" : "transparent",
              fontFamily: fontFamily.body,
            }}
          >
            <span style={externalUserAvatarStyle(item.name || item.id, 36)}>
              {externalUserInitial(item.name)}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    fontSize: fontSize.sm,
                    fontWeight: 600,
                    color: neutral[800],
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.name}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    flexShrink: 0,
                    fontSize: 10,
                    color: neutral[400],
                  }}
                >
                  {formatExternalUserTime(item.lastMessageAt)}
                </span>
              </span>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 2,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: fontSize.xs,
                    color: neutral[400],
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {orgLine(item)}
                </span>
                {item.messageCount > 0 && (
                  <span
                    title={`${item.messageCount} 条消息`}
                    style={{
                      flexShrink: 0,
                      minWidth: 18,
                      height: 18,
                      borderRadius: 9,
                      padding: "0 5px",
                      backgroundColor: neutral[100],
                      color: neutral[500],
                      fontSize: 10,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {item.messageCount > 999 ? "999+" : item.messageCount}
                  </span>
                )}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
