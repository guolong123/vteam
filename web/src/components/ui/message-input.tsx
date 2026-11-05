/**
 * MessageInput：受控输入组件（真实 textarea + @ mentions 候选插入 + 多附件 + 发送回调）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 迁移并升级为交互组件：
 * - value/onChange 由父组件受控管理（内部不存 value，仅候选展开状态为内部 state）
 * - textarea 随内容自增高（约 1~8 行，超出后内部滚动；发送/清空 → 回落到单行）
 * - 光标前出现 `@` 或 `@<片段>` 时弹出候选列表（message-input-mentions），
 *   点击候选在 `@` 处插入 `@名称 ` 并恢复光标；候选为空 / 未输入 @ 时不弹出
 * - Enter 发送（Shift+Enter 换行；IME 组合中 Enter 不上屏，不触发发送）
 * - 附件从「单文件」升级为「多文件」：一次可选/粘贴多个，各自并行 POST /uploads；
 *   待发送区按 chip 展示（名称/大小/上传中/移除），单条最多 10 个、单文件 20MB
 * - onSend({ text, mentions, attachments })：mentions 为文本中被 @ 的 agent 列表（按名去重），
 *   attachments 为已上传完成的附件元数据数组（纯附件消息 text 可为空）
 * 结构 / 样式 / data-testid 与原型一致（message-input / message-input-mentions /
 * message-input-send / message-attach-*），token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent, ClipboardEvent, ForwardedRef, KeyboardEvent, MouseEvent } from "react";
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

/** onSend 载荷：消息文本 + 被 @ 的 agent 列表 + 附件列表（先并发 POST /uploads 后随消息提交） */
export interface SendMessagePayload {
  text: string;
  mentions: MessageMention[];
  attachments: MessageAttachment[];
}

/** 单条消息附件数量上限（对齐后端 MAX_MESSAGE_ATTACHMENTS，客户端先行拦截提示）。 */
const MAX_ATTACHMENTS = 10;

/** 单文件大小上限（对齐后端 FILE_SIZE_LIMIT 20MB，客户端先行拦截避免 413）。 */
const ATTACHMENT_SIZE_LIMIT = 20 * 1024 * 1024;

/** textarea 自增高参数：约 1~8 行，超过后在内部滚动。
 *  - 行高 = fontSize.md × 1.6，必须与 textarea 的 lineHeight 保持一致，否则行数估算漂移；
 *  - MIN 沿用历史 40px 视觉基线（单行态高度不变，避免布局跳动）；
 *  - MAX = 8 行内容 + 上下内边距（space.xs）+ 1px 像素取整余量，
 *    保证第 8 行完整可见之后才会出现内部滚动条。 */
const TEXTAREA_LINE_HEIGHT = 1.6;
const TEXTAREA_MIN_HEIGHT = 40;
const TEXTAREA_MAX_LINES = 8;
const TEXTAREA_MAX_HEIGHT =
  Math.ceil(fontSize.md * TEXTAREA_LINE_HEIGHT * TEXTAREA_MAX_LINES + space.xs * 2) + 1;

/** 附件大小展示（与 chat-bubble 同口径，组件内自持避免跨组件导出耦合）。 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 待发送附件条目：文件本体 + 上传状态。
 * 用本地 id 而非文件名做 key —— 用户可能一次选两个同名文件（不同目录）。
 */
interface PendingAttachment {
  id: string;
  file: File;
  status: "uploading" | "done";
  /** POST /uploads 返回的元数据（status=done 时必有；上传中为 undefined）。 */
  meta?: MessageAttachment;
}

/** 命令式句柄：供会话页把「窗口级拖入的文件」转交进来，复用同一套校验/上传流程。 */
export interface MessageInputHandle {
  /** 追加一批文件（拖拽/粘贴/选择共用 addFiles 管线：≤10 个、≤20MB、并发上传）。 */
  addFiles: (files: File[]) => void;
}

export interface MessageInputProps {
  /** 受控输入值 */
  value: string;
  /** 输入变更回调（父组件维护 value） */
  onChange: (value: string) => void;
  /** 发送回调（Enter / 点击发送按钮触发；文本与附件均空时不触发）。
   *  返回 Promise 时：resolve 视为发送成功（清空待发送附件），reject 视为失败（保留附件供重试）；
   *  同步实现（不返回 Promise）只能按「调用即成功」处理，失败无法感知。 */
  onSend?: (payload: SendMessagePayload) => void | Promise<void>;
  /** 可 @ 的 Agent 列表（输入 @ 时作为候选弹出） */
  mentionable?: MentionableAgent[];
  placeholder?: string;
  /** 发送中：禁用按钮并显示「发送中…」 */
  sending?: boolean;
  /** 可选：关联任务 id（任务会话/私聊场景传入）。附件上传时随 multipart 提交，
   *  后端 POST /uploads 带 taskId 落盘后同步归档为 file 产出物（与 Agent 上传链路一致）；
   *  非任务场景不传 → 纯上传不归档。 */
  taskId?: string;
  style?: CSSProperties;
  className?: string;
}

function MessageInputImpl({
  value,
  onChange,
  onSend,
  /** 兜底为空：未显式传 mentionable 时 @ 无候选，绝不展示非团队成员的假 Agent */
  mentionable = [],
  placeholder = "输入消息，@ 提及某个 Agent…",
  sending = false,
  taskId,
  style,
  className,
}: MessageInputProps, ref: ForwardedRef<MessageInputHandle>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 候选触发位置：mentionAt = value 中 `@` 的索引（null = 未触发候选） */
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");

  // UX-10 多附件状态：pendingAttachments（待发送列表）/ attachError（校验或上传失败提示）
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** 本地 id 自增序列（file 重名时仍能唯一标识 chip）。 */
  const attachSeqRef = useRef(0);

  /**
   * 同步镜像：并发上传时每个上传 Promise 回调里读到的 state 可能是旧快照，
   * 直接用函数式 setState 又无法在异步流程中拿到新值 → 以 ref 为唯一真相，
   * setState 只负责触发渲染（批量追加 / 单个回填 / 移除都走这里）。
   */
  const pendingRef = useRef<PendingAttachment[]>([]);
  const updatePending = (updater: (prev: PendingAttachment[]) => PendingAttachment[]) => {
    pendingRef.current = updater(pendingRef.current);
    setPendingAttachments(pendingRef.current);
  };

  /** 是否有附件仍在上传：上传中禁止发送（避免消息先落库、附件后到导致丢失）。 */
  const attaching = pendingAttachments.some((item) => item.status === "uploading");
  /** 已上传完成、可随消息提交的附件数（决定是否允许纯附件发送）。 */
  const readyCount = pendingAttachments.filter((item) => item.status === "done").length;
  const atLimit = pendingAttachments.length >= MAX_ATTACHMENTS;

  /**
   * textarea 自增高：value 变化后先归零高度再按 scrollHeight 撑开，
   * 夹在 [MIN, MAX] 之间；超过 MAX 时内部滚动。发送/清空由父组件把 value 置空，
   * 本 effect 随之回落到单行。直接写 el.style.height 而不放进 React style，
   * 避免每帧 setState 重渲染（React 不会覆盖未出现在 style prop 里的属性）。
   */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const contentHeight = el.scrollHeight;
    const nextHeight = Math.min(
      Math.max(contentHeight, TEXTAREA_MIN_HEIGHT),
      TEXTAREA_MAX_HEIGHT,
    );
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = contentHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  /** 附件按钮点击：触发隐藏 file input（多选） */
  const handlePickFile = () => {
    if (sending || atLimit) return;
    fileInputRef.current?.click();
  };

  /** 上传单个文件：POST /uploads（multipart，任务场景带 taskId）→ 回填元数据。
   *  失败只移除该 chip 并提示，不影响同批其它文件的上传。 */
  const uploadOne = async (item: PendingAttachment) => {
    const form = new FormData();
    form.append("file", item.file);
    if (taskId) {
      form.append("taskId", taskId);
    }
    try {
      const meta = await api.post<MessageAttachment>("/uploads", form);
      updatePending((prev) =>
        prev.map((p) => (p.id === item.id ? { ...p, status: "done" as const, meta } : p)),
      );
    } catch (err) {
      updatePending((prev) => prev.filter((p) => p.id !== item.id));
      setAttachError(
        `${item.file.name} 上传失败：${
          err instanceof Error ? err.message : "请稍后重试"
        }`,
      );
    }
  };

  /**
   * 追加一批文件（选择 / 粘贴共用）：客户端先行校验数量与大小，
   * 通过校验的入队并**并行**上传；超限文件丢弃并在错误条说明。
   * 不再做扩展名白名单拦截 —— 服务端已放宽为任意扩展名（模型自行决定处理方式）。
   */
  const addFiles = (files: File[]) => {
    if (!files.length || sending) return;
    const errors: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      if (file.size > ATTACHMENT_SIZE_LIMIT) {
        errors.push(
          `${file.name} 超过 ${ATTACHMENT_SIZE_LIMIT / (1024 * 1024)}MB 上限`,
        );
        continue;
      }
      if (pendingRef.current.length + accepted.length >= MAX_ATTACHMENTS) {
        errors.push(`单条消息最多 ${MAX_ATTACHMENTS} 个附件`);
        break;
      }
      accepted.push(file);
    }
    setAttachError(errors.length ? errors.join("；") : null);
    if (!accepted.length) return;
    const items: PendingAttachment[] = accepted.map((file) => ({
      id: `pending-${attachSeqRef.current++}`,
      file,
      status: "uploading",
    }));
    updatePending((prev) => [...prev, ...items]);
    // 并行上传：每个文件一次 POST /uploads，互不阻塞（沿用 api.post 的 multipart 处理）
    for (const item of items) {
      void uploadOne(item);
    }
  };

  // 对外暴露命令式接口：会话页把「拖入窗口的文件」转交给本组件，
  // 与点击选择/粘贴走完全相同的校验与上传管线（不另开旁路）。
  useImperativeHandle(ref, () => ({ addFiles }));

  /** 选文件 → 入队并上传（multiple：一次可选多个） */
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // 重置 input value：允许重选同名文件重复触发 onChange
    e.target.value = "";
    addFiles(files);
  };

  /** 粘贴文件/图片 → 全部入队上传；粘贴纯文本时不拦截（走浏览器默认输入） */
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (sending) return;
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    // 阻止浏览器把图片以 data:/file: 形式插入文本区；附件统一走上传链路
    e.preventDefault();
    addFiles(files);
  };

  /** 移除指定 chip（上传中也允许：上传请求会自然完成，但不再占用列表/随消息发送）。 */
  const removeAttachment = (id: string) => {
    updatePending((prev) => prev.filter((p) => p.id !== id));
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

  const handleSend = async () => {
    const text = value.trim();
    // 只提交已上传完成的附件；上传中的条目不能进 payload（服务端拿不到 URL）
    const attachments: MessageAttachment[] = [];
    for (const item of pendingRef.current) {
      if (item.status === "done" && item.meta) attachments.push(item.meta);
    }
    // UX-10：文本为空但已有上传完成的附件也可发送（纯文件消息）；上传中禁止发送
    if (sending || attaching || (!text && attachments.length === 0)) return;
    try {
      await onSend?.({ text, mentions: extractMentions(value), attachments });
      // 发送成功后清空待发送列表：否则下一条消息会重复带上同一批附件；
      // onSend 返回的 Promise 抛错（发送失败）时保留附件供重试。
      updatePending(() => []);
      setAttachError(null);
    } catch {
      // 发送失败：保留附件与错误提示，待用户重试
    }
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

  /** 发送按钮禁用条件（上传中 / 发送中 / 无文本且无已上传附件）。 */
  const sendDisabled = sending || attaching || (!value.trim() && readyCount === 0);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        border: `1px solid ${neutral[200]}`,
        borderRadius: radius.lg,
        backgroundColor: "var(--color-surface)",
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
      {/* 输入区：真实 textarea（受控 + 自增高），placeholder 色对齐原型 neutral[400] */}
      <style>{`[data-testid="message-input"]::placeholder { color: ${neutral[400]}; }`}</style>
      <textarea
        data-testid="message-input"
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={1}
        aria-label="消息输入"
        style={{
          width: "100%",
          minHeight: TEXTAREA_MIN_HEIGHT,
          border: "none",

          resize: "none",
          background: "transparent",
          color: neutral[800],
          fontSize: fontSize.md,
          lineHeight: TEXTAREA_LINE_HEIGHT,
          padding: `${space.xs}px ${space.sm}px`,
          ...baseFont,
        }}
      />
      {/* 操作行：附件按钮 + 待发送附件列表 + 发送按钮 */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.xs, minWidth: 0, flex: 1, flexWrap: "wrap" }}>
          {/* 隐藏 file input（附件按钮触发；multiple 支持一次多选，类型/大小由服务端兜底） */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            data-testid="message-attach-input"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            data-testid="message-attach-button"
            onClick={handlePickFile}
            disabled={sending || atLimit}
            title={
              atLimit
                ? `最多 ${MAX_ATTACHMENTS} 个附件`
                : sending
                  ? "发送中…"
                  : `添加附件（已选 ${pendingAttachments.length}/${MAX_ATTACHMENTS}）`
            }
            aria-label="添加附件"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 34,
              height: 34,
              flexShrink: 0,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: sending || atLimit ? neutral[300] : neutral[600],
              fontSize: fontSize.md,
              cursor: sending || atLimit ? "default" : "pointer",
              opacity: sending || atLimit ? 0.6 : 1,
              fontFamily: fontFamily.body,
            }}
          >
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          {/* 待发送附件列表（多个 chip：文件名 / 大小 / 上传中 / 移除） */}
          {pendingAttachments.length > 0 && (
            <div
              data-testid="message-attach-preview"
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.xs,
                flexWrap: "wrap",
                minWidth: 0,
              }}
            >
              {pendingAttachments.map((item) => (
                <span
                  key={item.id}
                  data-testid="message-attach-item"
                  data-status={item.status}
                  title={item.file.name}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.xs,
                    maxWidth: 240,
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
                      maxWidth: 110,
                    }}
                  >
                    {item.file.name}
                  </span>
                  {/* 大小对上传中/已上传都展示（上传中先用本地 file.size，完成后用服务端 meta.size） */}
                  <span style={{ color: neutral[400], fontSize: fontSize.xs, whiteSpace: "nowrap" }}>
                    {formatFileSize(item.meta?.size ?? item.file.size)}
                  </span>
                  {item.status === "uploading" && (
                    <span
                      data-testid="message-attach-uploading"
                      style={{ color: neutral[400], fontSize: fontSize.xs, whiteSpace: "nowrap" }}
                    >
                      上传中…
                    </span>
                  )}
                  <button
                    type="button"
                    data-testid="message-attach-remove"
                    onClick={() => removeAttachment(item.id)}
                    title="移除附件"
                    aria-label={`移除附件 ${item.file.name}`}
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
              ))}
            </div>
          )}
          {/* 上传失败 / 超限提示（客户端校验 / POST /uploads 失败） */}
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
          disabled={sendDisabled}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            flexShrink: 0,
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.pill,
            backgroundColor: "#0D9488",
            color: "#FFFFFF",
            fontSize: fontSize.md,
            fontWeight: 500,
            border: "none",
            cursor: sendDisabled ? "not-allowed" : "pointer",
            opacity: sendDisabled ? 0.5 : 1,
            ...baseFont,
          }}
        >
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
    </div>
  );
}

/**
 * 对外导出：forwardRef 包装（命令式句柄见 MessageInputHandle）。
 * 组件体保持顶层函数书写，避免整文件重排；ref 仅用于「窗口级拖入文件」转交。
 */
export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(
  MessageInputImpl,
);
MessageInput.displayName = "MessageInput";
