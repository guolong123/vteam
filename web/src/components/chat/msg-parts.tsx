/**
 * MsgParts：Agent 消息内容片段渲染器（T14 群聊流式展示增强）
 * =============================================
 * 将一条 agent 消息的 content.parts 按 10 篇 §2.2/§2.3 规则映射为 UI：
 * - reasoning / thinking → MsgThinking（思考折叠条，thinking 为 reasoning 别名）
 * - tool               → MsgTool（工具卡片三态）
 * - error              → MsgError（消息级错误）
 * - aborted            → MsgAborted（灰「已中断」）；按 10 篇 §2.3：中断时其余
 *                       未完成 Part 不渲染，仅显示中断灰条
 * - text               → 正文（ChatBubble agent 型，置底作为最终结论）；
 *                        streaming（status=processing）时正文改流式块渲染 + 「生成中」指示，
 *                        终态（sent）消息由 chat.message.new 替换后自动切换回 ChatBubble
 * - 其余类型（step-start/step-finish/patch 等内部片段）不渲染（FR-10 边界）
 * 正文兜底：parts 无 text 片段时回退 content.text（T10 落库格式 { text, parts }，
 * 两者可能其一为空）；parts 全空时退化为普通 ChatBubble（Phase 2 mock 形态）。
 * data-testid 委托给各子组件（msg-thinking/msg-tool/msg-error/msg-aborted/chat-bubble），
 * token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import type { CSSProperties } from "react";
import { type RoleKey, neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";
import { ChatBubble, Markdown } from "@/src/components/ui";
import type { ChatBubbleAttachment } from "@/src/components/ui";
import { LoadingDots } from "./loading-indicator";
import { MsgThinking } from "./msg-thinking";
import { MsgTool } from "./msg-tool";
import { MsgError } from "./msg-error";
import { MsgAborted } from "./msg-aborted";
import { stripInjectedContext } from "@/lib/strip-injected-context";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 前端认识的 part 字段（后端 parts Json 透传，宽松读取防御未知字段）。 */
export interface PartShape {
  type?: string;
  state?: "pending" | "done";
  text?: string;
  /** reasoning 兜底字段：部分 serve 模型 reasoning 内容落在 summary/thoughts/detail 而非 text。 */
  summary?: string;
  thoughts?: string;
  /** serve 标准 tool part 工具名（MCP 格式 `<serverName>_<toolName>`，如 vteam_task_context）。 */
  tool?: string;
  name?: string;
  status?: "running" | "success" | "failed";
  input?: string;
  output?: string;
  kind?: "retry" | "quota";
  detail?: string;
}

/** 工具输入/输出规范化为单行文本：对象/数组 JSON 序列化，字符串原样，超长（>500 字符）截断省略。 */
function formatToolIO(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return serialized.length > 500 ? `${serialized.slice(0, 500)}…` : serialized;
}

/** serve tool part 状态值（completed 等）→ MsgTool 三态（running/success/failed）。 */
function toToolStatus(value: unknown): "running" | "success" | "failed" {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s === "running" || s === "streaming" || s === "pending" || s === "queued") {
    return "running";
  }
  if (s === "failed" || s === "error" || s === "aborted" || s === "cancelled") {
    return "failed";
  }
  // success / completed / done / 空 → success（serve 终态以 completed 落盘）
  return "success";
}

export interface MsgPartsProps {
  parts: unknown[];
  bodyText?: string;
  author: string;
  role: RoleKey;
  time?: string;
  streaming?: boolean;
  attachment?: ChatBubbleAttachment;
  isMentionMe?: boolean;
  style?: CSSProperties;
  className?: string;
}

export function MsgParts({ parts, bodyText, author, role, time, streaming, attachment, isMentionMe, style, className }: MsgPartsProps) {
  const list = (parts ?? []) as PartShape[];

  // 中断独占：aborted 时其余未完成 Part 不渲染（10 篇 §2.3）
  const aborted = list.find((p) => p.type === "aborted");
  if (aborted) {
    return (
      <div className={className} style={{ display: "flex", flexDirection: "column", gap: space.sm, ...style }}>
        <MsgAborted author={author} role={role} detail={aborted.detail ?? "用户中断"} time={time} />
      </div>
    );
  }

  const procParts = list.filter((p) => p.type !== "text");
  const textParts = list.filter((p) => p.type === "text");
  const body = textParts.map((t) => t.text ?? "").join("\n") || bodyText || "";
  const cleanBody = stripInjectedContext(body);

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: space.sm, ...style }}>
      {procParts.map((p, i) => {
        if (p.type === "reasoning" || p.type === "thinking") {
          return (
            <MsgThinking
              key={i}
              author={author}
              role={role}
              state={p.state ?? "done"}
              text={p.text ?? p.summary ?? p.thoughts ?? p.detail ?? ""}
              time={time}
            />
          );
        }
        if (p.type === "tool") {
          const rawState = p.state;
          const st =
            rawState !== undefined && rawState !== null && typeof rawState === "object"
              ? (rawState as unknown as Record<string, unknown>)
              : undefined;
          return (
            <MsgTool
              key={i}
              author={author}
              role={role}
              name={String(p.tool ?? p.name ?? "工具")}
              status={toToolStatus(st?.status ?? p.status)}
              input={formatToolIO(st?.input)}
              output={formatToolIO(st?.output)}
              time={time}
            />
          );
        }
        if (p.type === "error") {
          return (
            <MsgError
              key={i}
              kind={p.kind ?? "retry"}
              author={author}
              role={role}
              detail={p.detail ?? "处理失败"}
              time={time}
            />
          );
        }
        return null;
      })}
      {body ? (
        streaming ? (
          <div
            data-testid="msg-streaming"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              maxWidth: "78%",
              alignSelf: "flex-start",
              padding: `${space.sm}px ${space.md}px`,
              borderRadius: radius.md,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              ...baseFont,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: fontSize.md,
                color: neutral[700],
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {/* 流式正文 markdown 渲染（is_0000000019，终态走 ChatBubble 同链路） */}
              <Markdown>{cleanBody}</Markdown>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
              <LoadingDots color={neutral[400]} testid="msg-streaming-dots" />
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>生成中</span>
            </span>
          </div>
        ) : (
          <ChatBubble text={cleanBody} type="agent" author={author} role={role} time={time} attachment={attachment} isMentionMe={isMentionMe} />
        )
      ) : attachment ? (
        <ChatBubble text="" type="agent" author={author} role={role} time={time} attachment={attachment} isMentionMe={isMentionMe} />
      ) : null}
    </div>
  );
}
