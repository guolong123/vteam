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
import { api } from "@/lib/api";
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

/**
 * 可 @ 的候选 Agent。
 * - 单 Agent 语义（存量）：对齐 GET /api/v1/agents 返回的 { id, name, role }，id=agent id。
 * - 实例语义（T5 角色/实例分离）：同一 agent 可多实例，候选按**实例**列出（name=实例别名，
 *   如 开发者-1/开发者-2），id=agent id（文本匹配/发送映射兼容），instanceId=实例 id
 *   （ta_ 前缀，候选 key 与 mentions 落库结构唯一来源），agentId=模板 agent id。
 */
export interface MentionableAgent {
  id: string;
  name: string;
  role: RoleKey;
  /** 任务实例 id（ta_ 前缀；多实例场景必填，候选 key 唯一标识）。 */
  instanceId?: string;
  /** 模板 agent id（与 id 相同；提交 mentions 时按 agentId 映射，对齐后端 CreateMessageDto）。 */
  agentId?: string;
}

/** 已插入文本的 mention 记录（T13 落库 / 分派时按 id 解析） */
export type MessageMention = MentionableAgent;

/** UX-10 附件元数据（对齐 POST /uploads 响应 {url,name,size,ext}）。 */
export interface MessageAttachment {
  url: string;
  name: string;
  size: number;
  ext: string;
}

/** onSend 载荷：消息文本 + 被 @ 的 agent 列表 + 可选附件（先 POST /uploads 后随消息提交） */
export interface SendMessagePayload {
  text: string;
  mentions: MessageMention[];
  attachment?: MessageAttachment;
}

/** 附件扩展名白名单（对齐后端 uploads.constants ALLOWED_EXTENSIONS，客户端先行拦截提示）。 */
const ALLOWED_ATTACHMENT_EXTS = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "md",
  "txt",
];

/** 单文件大小上限（对齐后端 FILE_SIZE_LIMIT 10MB，客户端先行拦截避免 413）。 */
const ATTACHMENT_SIZE_LIMIT = 10 * 1024 * 1024;

function attachmentExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export interface MessageInputProps {
  /** 受控输入值 */
  value: string;
  /** 输入变更回调（父组件维护 value） */
  onChange: (value: string) => void;
  /** 发送回调（Enter / 点击发送按钮触发；文本与附件均空时不触发） */
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 候选触发位置：mentionAt = value 中 `@` 的索引（null = 未触发候选） */
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");

  // UX-10 附件状态：pendingAttachment（待发送附件）/ attaching（上传中）/ attachError（上传失败提示）
  const [pendingAttachment, setPendingAttachment] = useState<MessageAttachment | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  /** 附件按钮点击：触发隐藏 file input */
  const handlePickFile = () => {
    if (attaching || sending) return;
    fileInputRef.current?.click();
  };

  /** 选文件 → 客户端校验 → POST /uploads → 存待发送附件 */
  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 重置 input value：允许重选同名文件重复触发 onChange
    e.target.value = "";
    if (!file) return;
    const ext = attachmentExt(file.name);
    if (!ext || !(ALLOWED_ATTACHMENT_EXTS as readonly string[]).includes(ext)) {
      setAttachError(`不支持 ${ext || "无扩展名"} 文件，仅支持 ${ALLOWED_ATTACHMENT_EXTS.join("/")}`);
      return;
    }
    if (file.size > ATTACHMENT_SIZE_LIMIT) {
      setAttachError("文件超过 10MB 上限");
      return;
    }
    setAttachError(null);
    setAttaching(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const meta = await api.post<MessageAttachment>("/uploads", form);
      setPendingAttachment(meta);
    } catch (err) {
      setAttachError(
        err instanceof Error ? err.message : "文件上传失败，请稍后重试",
      );
    } finally {
      setAttaching(false);
    }
  };

  const removeAttachment = () => {
    setPendingAttachment(null);
    setAttachError(null);
  };

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
    // UX-10：文本为空但已选附件也可发送（纯图片/文件消息）
    if ((!text && !pendingAttachment) || sending || attaching) return;
    void onSend?.({
      text,
      mentions: extractMentions(value),
      ...(pendingAttachment ? { attachment: pendingAttachment } : {}),
    });
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
        key={agent.instanceId ?? agent.id}
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
      {/* 操作行：附件按钮 + 发送按钮 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0, flex: 1 }}>
          {/* 隐藏 file input（附件按钮触发；accept 限定白名单扩展名，服务端兜底） */}
          <input
            ref={fileInputRef}
            type="file"
            data-testid="message-attach-input"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            data-testid="message-attach-button"
            onClick={handlePickFile}
            disabled={attaching || sending}
            title={attaching ? "上传中…" : "添加附件（图片/文档）"}
            aria-label="添加附件"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 34,
              height: 34,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: attaching ? neutral[300] : neutral[600],
              fontSize: fontSize.md,
              cursor: attaching || sending ? "default" : "pointer",
              opacity: attaching || sending ? 0.6 : 1,
              fontFamily: fontFamily.body,
            }}
          >
            {attaching ? "…" : (
              <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            )}
          </button>
          {/* 待发送附件预览（可移除） */}
          {pendingAttachment && (
            <span
              data-testid="message-attach-preview"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.sm,
                maxWidth: "100%",
                padding: `${space.xs}px ${space.sm}px`,
                borderRadius: radius.pill,
                backgroundColor: neutral[100],
                color: neutral[700],
                fontSize: fontSize.sm,
                ...baseFont,
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 180,
                }}
              >
                {pendingAttachment.name}
              </span>
              <button
                type="button"
                data-testid="message-attach-remove"
                onClick={removeAttachment}
                title="移除附件"
                aria-label="移除附件"
                style={{
                  border: "none",
                  background: "transparent",
                  color: neutral[400],
                  cursor: "pointer",
                  fontSize: fontSize.md,
                  lineHeight: 1,
                  padding: 0,
                  fontFamily: fontFamily.body,
                }}
              >
                ×
              </button>
            </span>
          )}
          {/* 上传失败提示（客户端校验 / POST /uploads 失败） */}
          {attachError && (
            <span
              data-testid="message-attach-error"
              role="alert"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "#DC2626",
                fontSize: fontSize.xs,
                ...baseFont,
              }}
            >
              {attachError}
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="message-input-send"
          onClick={handleSend}
          disabled={sending || (!value.trim() && !pendingAttachment) || attaching}
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
            cursor: sending || (!value.trim() && !pendingAttachment) || attaching ? "not-allowed" : "pointer",
            opacity: sending || (!value.trim() && !pendingAttachment) || attaching ? 0.5 : 1,
            ...baseFont,
          }}
        >
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
