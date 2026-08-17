/**
 * Agent Platform 共享 UI 组件库
 * =============================================
 * 供 docs/agent-platform/prototypes 下各原型（T8~T11）统一使用。
 * - 纯展示组件，不承载任何交互逻辑（点击/跳转/状态变更）。
 * - 颜色 / 间距 / 圆角 / 字号一律取自 ./styles.ts token。
 * - 关键元素带 data-testid，供后续 playwright 断言。
 *
 * 引入方式（原型内相对 import）：
 *   import { AgentAvatar, ChatBubble, ... } from "../../_shared/components";
 */
import type { CSSProperties, ReactNode } from "react";
import {
  type RoleKey,
  type StatusKey,
  roles,
  roleText,
  statusColors,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
  sidebarTheme,
} from "./styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ================================ AgentAvatar ================================
 * Agent 头像：圆形头像 + 角色色块，右下角带角色小圆点。
 */
export interface AgentAvatarProps {
  /** 角色 key，决定色块颜色 */
  role: RoleKey;
  /** 头像内展示的缩写（缺省取角色 key 首字母大写） */
  initials?: string;
  /** 尺寸：sm=28 / md=36 / lg=44 */
  size?: "sm" | "md" | "lg";
  /** 是否显示右下角色点 */
  dot?: boolean;
  style?: CSSProperties;
  className?: string;
}

const avatarSizes = { sm: 28, md: 36, lg: 44 } as const;

export function AgentAvatar({
  role,
  initials,
  size = "md",
  dot = true,
  style,
  className,
}: AgentAvatarProps) {
  const dim = avatarSizes[size];
  const theme = roles[role];
  const dotDim = Math.max(8, Math.round(dim * 0.28));
  return (
    <span
      data-testid="agent-avatar"
      data-role={role}
      aria-label={`${theme.label} 头像`}
      className={className}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: dim,
        height: dim,
        borderRadius: "50%",
        backgroundColor: theme.bg,
        border: `1.5px solid ${theme.border}`,
        color: theme.color,
        fontSize: Math.round(dim * 0.36),
        fontWeight: 600,
        lineHeight: 1,
        userSelect: "none",
        flexShrink: 0,
        ...baseFont,
        ...style,
      }}
    >
      {(initials ?? role.charAt(0).toUpperCase())}
      {dot && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: dotDim,
            height: dotDim,
            borderRadius: "50%",
            backgroundColor: theme.color,
            border: `2px solid #FFFFFF`,
          }}
        />
      )}
    </span>
  );
}

/* ================================ AgentBadge ================================
 * 角色标签：产品经理 / 架构师 / 开发者 / 测试
 */
export interface AgentBadgeProps {
  role: RoleKey;
  /** 是否显示前置小圆点 */
  dot?: boolean;
  style?: CSSProperties;
  className?: string;
}

export function AgentBadge({ role, dot = true, style, className }: AgentBadgeProps) {
  const theme = roles[role];
  return (
    <span
      data-testid="agent-badge"
      data-role={role}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs - 1}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: roleText[role],
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
        ...style,
      }}
    >
      {dot && (
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: theme.color,
            flexShrink: 0,
          }}
        />
      )}
      {theme.label}
    </span>
  );
}

/* ================================ ChatBubble ================================
 * 消息气泡：user=右对齐蓝 / agent=左对齐白卡带角色 / system=居中灰
 */
export type ChatMessageType = "user" | "agent" | "system";

export interface ChatBubbleProps {
  text: string;
  type?: ChatMessageType;
  /** 发送人（agent / system 消息展示） */
  author?: string;
  /** 发送人角色（agent 消息展示角色色） */
  role?: RoleKey;
  /** 可选时间戳 */
  time?: string;
  style?: CSSProperties;
  className?: string;
}

export function ChatBubble({
  text,
  type = "agent",
  author,
  role,
  time,
  style,
  className,
}: ChatBubbleProps) {
  const isUser = type === "user";
  const isSystem = type === "system";
  const roleTheme = role ? roles[role] : null;

  // 气泡外壳
  const bubbleBase: CSSProperties = {
    maxWidth: "78%",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.lg,
    fontSize: fontSize.md,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    ...baseFont,
  };

  if (isSystem) {
    return (
      <div
        data-testid="chat-bubble"
        data-type="system"
        className={className}
        style={{ display: "flex", justifyContent: "center", ...style }}
      >
        <div
          style={{
            ...bubbleBase,
            backgroundColor: neutral[100],
            color: neutral[500],
            fontSize: fontSize.sm,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.pill,
          }}
        >
          {text}
        </div>
      </div>
    );
  }

  const showHeader = !isUser && (author || roleTheme);
  return (
    <div
      data-testid="chat-bubble"
      data-type={type}
      className={className}
      style={{
        display: "flex",
        flexDirection: isUser ? "row-reverse" : "row",
        alignItems: "flex-start",
        gap: space.sm,
        ...style,
      }}
    >
      {!isUser && (
        <AgentAvatar role={role ?? "developer"} size="sm" dot={false} style={{ marginTop: 2 }} />
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: isUser ? "flex-end" : "flex-start",
          gap: space.xs,
        }}
      >
        {showHeader && (
          <span
            data-testid="chat-bubble-author"
            style={{
              fontSize: fontSize.xs,
              color: roleTheme ? roleText[role!] : neutral[400],
              fontWeight: 500,
              ...baseFont,
            }}
          >
            {author ?? roleTheme!.label}
            {time ? ` · ${time}` : ""}
          </span>
        )}
        <div
          style={
            isUser
              ? {
                  ...bubbleBase,
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  borderTopRightRadius: radius.sm,
                  boxShadow: shadow.sm,
                }
              : {
                  ...bubbleBase,
                  backgroundColor: "#FFFFFF",
                  color: neutral[800],
                  border: `1px solid ${neutral[200]}`,
                  borderTopLeftRadius: radius.sm,
                  boxShadow: shadow.sm,
                }
          }
        >
          {text}
        </div>
      </div>
    </div>
  );
}

/* ================================ MessageInput ================================
 * 输入区：@ 提示区域样式 + 输入占位 + 发送按钮（纯展示）
 */
export interface MessageInputProps {
  /** 可 @ 的 Agent 角色列表（渲染为提示 chips） */
  mentionable?: RoleKey[];
  placeholder?: string;
  style?: CSSProperties;
  className?: string;
}

export function MessageInput({
  mentionable = ["product", "architect", "developer", "tester"],
  placeholder = "输入消息，@ 提及某个 Agent…",
  style,
  className,
}: MessageInputProps) {
  return (
    <div
      data-testid="message-input"
      className={className}
      style={{
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        padding: space.md,
        boxShadow: shadow.sm,
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        ...baseFont,
        ...style,
      }}
    >
      {/* @ 提示区域 */}
      <div
        data-testid="message-input-mentions"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          flexWrap: "wrap",
          paddingBottom: space.sm,
          borderBottom: `1px dashed ${neutral[200]}`,
        }}
      >
        <span style={{ fontSize: fontSize.sm, color: neutral[400], fontWeight: 500 }}>
          @提及：
        </span>
        {mentionable.map((role) => (
          <AgentBadge key={role} role={role} />
        ))}
      </div>
      {/* 输入占位 */}
      <div
        aria-hidden
        style={{
          minHeight: 40,
          color: neutral[400],
          fontSize: fontSize.md,
          lineHeight: 1.6,
          padding: `${space.xs}px ${space.sm}px`,
        }}
      >
        {placeholder}
      </div>
      {/* 操作行：发送按钮 */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <span
          data-testid="message-input-send"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.pill,
            backgroundColor: "#2563EB",
            color: "#FFFFFF",
            fontSize: fontSize.md,
            fontWeight: 500,
            cursor: "pointer",
            ...baseFont,
          }}
        >
          发送
        </span>
      </div>
    </div>
  );
}

/* ================================ StatusBadge ================================
 * 任务状态徽章：进行中 / 待验收 / 已完成 / 已归档
 */
export interface StatusBadgeProps {
  status: StatusKey;
  style?: CSSProperties;
  className?: string;
}

export function StatusBadge({ status, style, className }: StatusBadgeProps) {
  const theme = statusColors[status];
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: theme.color,
          flexShrink: 0,
        }}
      />
      {status}
    </span>
  );
}

/* ================================ Sidebar ================================
 * 左侧导航：项目名 + 导航项（任务 / Agent 管理）
 */
export type SidebarNavKey = "tasks" | "agents";

export interface SidebarProps {
  projectName?: string;
  active?: SidebarNavKey;
  onNavClick?: (key: SidebarNavKey) => void;
  style?: CSSProperties;
  className?: string;
}

const NAV_ITEMS: { key: SidebarNavKey; label: string; icon: string }[] = [
  { key: "tasks", label: "任务", icon: "▤" },
  { key: "agents", label: "Agent 管理", icon: "◉" },
];

export function Sidebar({
  projectName = "Agent 协作平台",
  active = "tasks",
  onNavClick,
  style,
  className,
}: SidebarProps) {
  return (
    <aside
      data-testid="sidebar"
      className={className}
      style={{
        width: 220,
        flexShrink: 0,
        height: "100%",
        backgroundColor: sidebarTheme.bg,
        color: sidebarTheme.text,
        display: "flex",
        flexDirection: "column",
        ...baseFont,
        ...style,
      }}
    >
      {/* 项目名 */}
      <div
        data-testid="sidebar-project"
        style={{
          padding: space.xl,
          borderBottom: `1px solid ${sidebarTheme.border}`,
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: radius.md,
            background: "linear-gradient(135deg,#3B82F6,#8B5CF6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#FFFFFF",
            fontWeight: 700,
            fontSize: fontSize.lg,
            marginBottom: space.md,
          }}
        >
          A
        </div>
        <div
          style={{
            color: sidebarTheme.textActive,
            fontSize: fontSize.md,
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          {projectName}
        </div>
        <div style={{ fontSize: fontSize.xs, color: sidebarTheme.text, marginTop: 2 }}>
          智能体协作工作区
        </div>
      </div>

      {/* 导航项 */}
      <nav style={{ padding: space.md, display: "flex", flexDirection: "column", gap: space.xs }}>
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === active;
          return (
            <button
              key={item.key}
              type="button"
              data-testid={`sidebar-nav-${item.key}`}
              data-active={isActive ? "true" : "false"}
              onClick={onNavClick ? () => onNavClick(item.key) : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm + 2,
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                backgroundColor: isActive ? sidebarTheme.bgActive : "transparent",
                color: isActive ? sidebarTheme.textActive : sidebarTheme.text,
                fontSize: fontSize.md,
                fontWeight: isActive ? 600 : 400,
                transition: "background-color .15s ease",
                fontFamily: fontFamily.body,
              }}
            >
              <span style={{ fontSize: fontSize.lg, lineHeight: 1, opacity: 0.9 }} aria-hidden>
                {item.icon}
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* 底部占位 */}
      <div
        style={{
          marginTop: "auto",
          padding: space.lg,
          borderTop: `1px solid ${sidebarTheme.border}`,
          fontSize: fontSize.xs,
          color: sidebarTheme.text,
          lineHeight: 1.5,
        }}
      >
        4 个 Agent 在线
      </div>
    </aside>
  );
}

/* ================================ TopBar ================================
 * 顶部栏：页面标题 + 用户信息占位
 */
export interface TopBarProps {
  title?: string;
  subtitle?: string;
  userName?: string;
  userRole?: string;
  style?: CSSProperties;
  className?: string;
}

export function TopBar({
  title = "任务看板",
  subtitle,
  userName = "运营者",
  userRole = "项目管理员",
  style,
  className,
}: TopBarProps) {
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
        padding: `0 ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
        ...style,
      }}
    >
      <div>
        <div
          style={{
            fontSize: fontSize.lg,
            fontWeight: 600,
            color: neutral[900],
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
            {subtitle}
          </div>
        )}
      </div>

      {/* 用户信息占位 */}
      <div
        data-testid="topbar-user"
        style={{ display: "flex", alignItems: "center", gap: space.sm }}
      >
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 500 }}>
            {userName}
          </div>
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
          }}
        >
          {initials}
        </span>
      </div>
    </header>
  );
}

/* ================================ EmptyState ================================
 * 空状态占位：图标 + 标题 + 描述
 */
export interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function EmptyState({
  title = "暂无数据",
  description = "当前还没有内容，稍后再来看看。",
  icon,
  action,
  style,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: space.md,
        padding: `${space.xxl}px`,
        textAlign: "center",
        ...baseFont,
        ...style,
      }}
    >
      <div
        aria-hidden
        style={{
          width: 64,
          height: 64,
          borderRadius: radius.lg,
          backgroundColor: neutral[100],
          border: `1px dashed ${neutral[300]}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 26,
          color: neutral[400],
        }}
      >
        {icon ?? "◌"}
      </div>
      <div>
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[700] }}>
          {title}
        </div>
        <div style={{ fontSize: fontSize.md, color: neutral[400], marginTop: space.xs }}>
          {description}
        </div>
      </div>
      {action}
    </div>
  );
}
