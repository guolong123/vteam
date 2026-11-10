/**
 * MessageIdentity：共享消息身份栏（chat-ux-hierarchy-and-streaming 复选框 4 · B1）
 * =============================================
 * 一条 agent 消息（MsgParts）只渲染一次「头像 + 作者行 + 时间」；reasoning/tool/error/aborted
 * 等过程片段与最终正文、附件都作为附属行挂在同一条身份栏之下，不再各自重复身份。
 *
 * 纯展示组件：author/role/time/senderType/initials 全部由调用方解析后传入，
 * 组件内不做 senderId → 名称 的业务映射、不读原始 id、不访问任何数据源；
 * role 仅用于取 src/theme/tokens.ts 的角色主题色与标签回退（roleLabel 属展示决策，
 * 由 lib/author-role-display.ts 回答：已解析 author 与角色标签并列、同值去重、
 * 未解析只回落角色标签——裸 id 的过滤在容器侧 lib/display-author.ts 完成，不进入本组件）。
 * data-testid：message-identity（身份栏容器，本 todo 新增）+ 既有
 * agent-avatar / chat-bubble-author / chat-bubble-time / external-channel-badge，
 * 以及本 todo 新增的 message-identity-role（并列展示的角色标签）。
 */
"use client";

import type { CSSProperties } from "react";
import {
  type RoleKey,
  roles,
  roleText,
  neutral,
  space,
  messageFontSize,
  messageFontWeight,
  fontFamily,
} from "@/src/theme/tokens";
import { authorRoleDisplay } from "@/lib/author-role-display";
import { AgentAvatar } from "./agent-avatar";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface MessageIdentityProps {
  /** 已解析的展示作者名：容器（session 页面）已剔除裸 a_/tmm_/ta_ id，缺省时回落角色标签 */
  author?: string;
  role?: RoleKey;
  time?: string;
  /** 外部渠道消息：senderType==='external' 时展示“外部渠道”徽章 */
  senderType?: string;
  /** 头像缩写（透传 AgentAvatar，B8 才由调用方生成） */
  initials?: string;
  style?: CSSProperties;
  className?: string;
}

export function MessageIdentity({
  author,
  role,
  time,
  senderType,
  initials,
  style,
  className,
}: MessageIdentityProps) {
  // 两种「没有合法角色」的场景要分开处理（2026-11-10 修正）：
  // - `role` **缺省**（外部渠道消息无平台角色）→ 不回落 developer，否则「GuoLong」旁
  //   会并排挂一个假「开发者」标签（见 50257f99）；
  // - `role` **非法/未知**（脏数据，运行时可能拿到不在 ROLE_KEYS 的字符串）→ 回落到
  //   developer。此时 AgentAvatar 已按 `roles[safeRole] ?? roles.developer` 回落成开发者
  //   头像，若这里不回落就会出现「头像是开发者色、旁边却没有角色标签」的割裂，
  //   且 `roleText[role]` 会取到 undefined（颜色不属于任何主题）。
  const roleTheme = role ? (roles[role] ?? roles.developer) : null;
  const roleColor = role ? (roleText[role] ?? roleText.developer) : neutral[400];
  const display = authorRoleDisplay(author, roleTheme ? roleTheme.label : "");
  return (
    <div
      data-testid="message-identity"
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        minWidth: 0,
        ...baseFont,
        ...style,
      }}
    >
      <AgentAvatar role={role ?? "developer"} initials={initials} size="sm" dot={false} style={{ marginTop: 2 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "baseline",
          gap: space.xs,
          flexWrap: "wrap",
          minWidth: 0,
          ...baseFont,
        }}
      >
        <span
          data-testid="chat-bubble-author"
          style={{
            fontSize: messageFontSize.identity,
            color: roleColor,
            fontWeight: messageFontWeight.identity,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            ...baseFont,
          }}
        >
          <span>{display.primary}</span>
          {display.roleLabel !== null && (
            <span
              data-testid="message-identity-role"
              style={{
                fontSize: messageFontSize.identity,
                fontWeight: 500,
                color: neutral[600],
                lineHeight: 1.4,
                ...baseFont,
              }}
            >
              · {display.roleLabel}
            </span>
          )}
          {senderType === "external" && (
            <span
              data-testid="external-channel-badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "1px 6px",
                borderRadius: 999,
                backgroundColor: neutral[100],
                border: `1px solid ${neutral[200]}`,
                color: neutral[500],
                fontSize: 10,
                fontWeight: 600,
                lineHeight: 1.4,
                whiteSpace: "nowrap",
              }}
            >
              外部渠道
            </span>
          )}
        </span>
        {time ? (
          <span
            data-testid="chat-bubble-time"
            style={{
              fontSize: messageFontSize.meta,
              color: neutral[500],
              lineHeight: 1.4,
              ...baseFont,
            }}
          >
            · {time}
          </span>
        ) : null}
      </span>
    </div>
  );
}
