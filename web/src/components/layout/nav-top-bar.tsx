/**
 * NavTopBar：浅色顶栏（面包屑 + 居中 Cmd+K 触发框 + 右用户头像）
 *
 * 从 docs/agent-platform/prototypes/_shared/nav.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 * 处于文档流（非浮层），height 60 固定。
 */
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface NavTopBarProps {
  /** 面包屑路径（按序用 › 连接）；提供时替代 title/subtitle 展示 */
  breadcrumb?: string[];
  /** 无 breadcrumb 时的左侧标题 */
  title?: string;
  /** 无 breadcrumb 时的左侧副标题 */
  subtitle?: string;
  userName?: string;
  userRole?: string;
  /** 点击 Cmd+K 触发框回调（打开命令面板） */
  onCmdKClick?: () => void;
  /** 右侧用户头像后扩展插槽 */
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function NavTopBar({
  breadcrumb,
  title = "任务看板",
  subtitle,
  userName = "运营者",
  userRole = "项目管理员",
  onCmdKClick,
  children,
  style,
  className,
}: NavTopBarProps) {
  const hasBreadcrumb = !!breadcrumb && breadcrumb.length > 0;
  const initials = userName.slice(0, 1);
  return (
    <header
      data-testid="topbar"
      className={className}
      style={{
        height: 60,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space.xl,
        padding: `0 ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
        ...style,
      }}
    >
      {/* 左侧：面包屑 或 标题 */}
      {hasBreadcrumb ? (
        <nav
          data-testid="top-breadcrumb"
          aria-label="面包屑"
          style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}
        >
          {breadcrumb.map((crumb, i) => {
            const isLast = i === breadcrumb.length - 1;
            return (
              <span
                key={i}
                style={{ display: "inline-flex", alignItems: "center", gap: space.sm, minWidth: 0 }}
              >
                {i > 0 && (
                  <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.lg, lineHeight: 1 }}>
                    ›
                  </span>
                )}
                <span
                  style={{
                    fontSize: fontSize.md,
                    fontWeight: isLast ? 600 : 500,
                    color: isLast ? neutral[900] : neutral[500],
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {crumb}
                </span>
              </span>
            );
          })}
        </nav>
      ) : (
        <div data-testid="top-title" style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              lineHeight: 1.3,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>{subtitle}</div>
          )}
        </div>
      )}

      {/* 中部：Cmd+K 触发框 */}
      <button
        type="button"
        data-testid="cmdk-trigger"
        aria-label="打开命令面板（⌘K）"
        onClick={onCmdKClick}
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          width: 280,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[50],
          border: `1px solid ${neutral[200]}`,
          cursor: "pointer",
          fontFamily: fontFamily.body,
          boxShadow: shadow.sm,
        }}
      >
        <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
          ⌕
        </span>
        <span
          style={{
            flex: 1,
            textAlign: "left",
            fontSize: fontSize.md,
            color: neutral[400],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          搜索或输入命令…
        </span>
        <span
          aria-hidden
          style={{
            fontSize: fontSize.xs,
            fontWeight: 600,
            color: neutral[500],
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
            padding: "1px 6px",
            borderRadius: radius.sm,
          }}
        >
          ⌘K
        </span>
      </button>

      {/* 右侧：用户信息 + 头像 + children 插槽 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 500 }}>{userName}</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>{userRole}</div>
        </div>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: "50%",
            backgroundColor: neutral[900],
            color: "#FFFFFF",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: fontSize.md,
            fontWeight: 600,
            userSelect: "none",
          }}
        >
          {initials}
        </span>
        {children}
      </div>
    </header>
  );
}