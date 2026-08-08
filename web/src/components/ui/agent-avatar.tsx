/**
 * AgentAvatar：Agent 头像（圆形头像 + 角色色块，右下角带角色小圆点）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 */
import type { CSSProperties } from "react";
import {
  type RoleKey,
  roles,
  fontFamily,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

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