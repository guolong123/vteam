/**
 * MessageInput：受控输入组件（真实 textarea + @ mentions 候选插入 + 发送回调）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 迁移并升级为交互组件：
 * - value/onChange 由父组件受控管理（内部不存 value，仅候选展开状态为内部 state）
 * - 光标前出现 `@` 或 `@<片段>` 时弹出候选列表（message-input-mentions），
 *   点击候选在 `@` 处插入 `@名称 ` 并恢复光标；候选为空 / 未输入 @ 时不弹出
 * - Enter 发送（Shift+Enter 换行；IME 组合中 Enter 不上屏，不触发发送）
 * - onSend({ text, mentions })：mentions 为文本中被 @ 的 agent 列表（按名去重）
 * 结构 / 样式 / data-testid 与原型一致（message-input / message-input-mentions /
 * message-input-send），token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import { useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent, KeyboardEvent, MouseEvent } from "react";
import {
  type RoleKey,
  roles,
  roleText,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 可 @ 的候选 Agent（对齐 GET /api/v1/agents 返回的 { id, name, role } 结构） */
export interface MentionableAgent {
  id: string;
  name: string;
  role: RoleKey;
}

/** 已插入文本的 mention 记录（T13 落库 / 分派时按 id 解析） */
export type MessageMention = MentionableAgent;

/** onSend 载荷：消息文本 + 被 @ 的 agent 列表 */
export interface SendMessagePayload {
  text: string;
  mentions: MessageMention[];
}

export interface MessageInputProps {
  /** 受控输入值 */
  value: string;
  /** 输入变更回调（父组件维护 value） */
  onChange: (value: string) => void;
  /** 发送回调（Enter / 点击发送按钮触发；文本为空时不触发） */
  onSend?: (payload: SendMessagePayload) => void | Promise<void>;
  /** 可 @ 的 Agent 列表（输入 @ 时作为候选弹出） */
  mentionable?: MentionableAgent[];
  placeholder?: string;
  /** 发送中：禁用按钮并显示「发送中…」 */
  sending?: boolean;
  style?: CSSProperties;
  className?: string;
}

export function MessageInput({
  value,
  onChange,
  onSend,
  /** 兜底为空：未显式传 mentionable 时 @ 无候选，绝不展示非团队成员的假 Agent */
  mentionable = [],
  placeholder = "输入消息，@ 提及某个 Agent…",
  sending = false,
  style,
  className,
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** 候选触发位置：mentionAt = value 中 `@` 的索引（null = 未触发候选） */
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");

  /** 候选列表：@ 触发且过滤后非空才展示 */
  const candidates = useMemo(() => {
    if (mentionAt === null) return [];
    const q = mentionQuery.trim().toLowerCase();
    return q
      ? mentionable.filter((a) => a.name.toLowerCase().includes(q))
      : mentionable;
  }, [mentionAt, mentionQuery, mentionable]);

  /** 解析光标前的 `@`（或 `@片段`）触发候选；无匹配则关闭 */
  const refreshMention = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, pos);
    const m = before.match(/(^|[\s])@([\p{L}\p{N}_-]*)$/u);
    if (m) {
      setMentionAt((m.index ?? 0) + (m[1]?.length ?? 0));
      setMentionQuery(m[2] ?? "");
    } else {
      setMentionAt(null);
      setMentionQuery("");
    }
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    refreshMention(e.target);
  };

  /** 点击候选：在 `@` 处插入 `@名称 `，重置光标到插入末尾 */
  const insertMention = (agent: MentionableAgent) => {
    const el = textareaRef.current;
    if (!el || mentionAt === null) return;
    const at = mentionAt;
    const pos = el.selectionStart ?? el.value.length;
    const next = value.slice(0, at) + `@${agent.name} ` + value.slice(pos);
    onChange(next);
    setMentionAt(null);
    setMentionQuery("");
    requestAnimationFrame(() => {
      el.focus();
      const caret = at + agent.name.length + 2;
      el.setSelectionRange(caret, caret);
    });
  };

  /** 从文本提取被 @ 的 agent（按名匹配，按 mentionable 顺序去重） */
  const extractMentions = (text: string): MessageMention[] =>
    mentionable.filter((a) => text.includes(`@${a.name}`));

  const handleSend = () => {
    const text = value.trim();
    if (!text || sending) return;
    void onSend?.({ text, mentions: extractMentions(value) });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组合中 Enter 用于上屏候选，不触发发送
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleBlur = () => {
    // 候选 chip 已 onMouseDown preventDefault 阻止失焦；其余 blur 直接关闭候选
    setMentionAt(null);
    setMentionQuery("");
  };

  /** 候选 chip：视觉对齐 AgentBadge（roles token 配色），点击插入 */
  const renderCandidate = (agent: MentionableAgent) => {
    const theme = roles[agent.role] ?? roles.product;
    const text = roleText[agent.role] ?? roleText.product;
    return (
      <button
        key={agent.id}
        type="button"
        data-role={agent.role}
        onMouseDown={(e: MouseEvent<HTMLButtonElement>) => e.preventDefault()}
        onClick={() => insertMention(agent)}
        title={`@${agent.name}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: space.xs,
          padding: `${space.xs - 1}px ${space.sm}px`,
          borderRadius: radius.pill,
          backgroundColor: theme.bg,
          border: `1px solid ${theme.border}`,
          color: text,
          fontSize: fontSize.sm,
          fontWeight: 500,
          lineHeight: 1.4,
          whiteSpace: "nowrap",
          cursor: "pointer",
          ...baseFont,
        }}
      >
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
        {agent.name}
      </button>
    );
  };

  const showCandidates = candidates.length > 0;

  return (
    <div
      className={className}
      style={{
        position: "relative",
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
      {/* @ 候选区：@ 触发时展示，点击候选插入到文本 */}
      {showCandidates && (
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
          {candidates.map(renderCandidate)}
        </div>
      )}
      {/* 输入区：真实 textarea（受控），placeholder 色对齐原型 neutral[400] */}
      <style>{`[data-testid="message-input"]::placeholder { color: ${neutral[400]}; }`}</style>
      <textarea
        data-testid="message-input"
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={1}
        aria-label="消息输入"
        style={{
          width: "100%",
          minHeight: 40,
          border: "none",
          outline: "none",
          resize: "none",
          background: "transparent",
          color: neutral[800],
          fontSize: fontSize.md,
          lineHeight: 1.6,
          padding: `${space.xs}px ${space.sm}px`,
          ...baseFont,
        }}
      />
      {/* 操作行：发送按钮 */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          data-testid="message-input-send"
          onClick={handleSend}
          disabled={sending || !value.trim()}
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
            border: "none",
            cursor: sending || !value.trim() ? "not-allowed" : "pointer",
            opacity: sending || !value.trim() ? 0.5 : 1,
            ...baseFont,
          }}
        >
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
