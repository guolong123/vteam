/**
 * MsgParts：Agent 消息内容片段渲染器（T14 群聊流式展示增强）
 * =============================================
 * 将一条 agent 消息的 content.parts 按 10 篇 §2.2/§2.3 规则映射为 UI：
 * - reasoning / thinking → MsgThinking（思考折叠条，thinking 为 reasoning 别名）
 * - tool               → MsgTool（工具卡片三态）
 * - error              → MsgError（消息级错误）
 * - aborted            → MsgAborted（灰「已中断」）；按 10 篇 §2.3：中断时其余
 *                       未完成 Part 不渲染，仅显示中断灰条
 * - text               → 正文（ChatBubble agent 型，置底作为最终结论）
 * - 其余类型（step-start/step-finish/patch 等内部片段）不渲染（FR-10 边界）
 * 正文兜底：parts 无 text 片段时回退 content.text（T10 落库格式 { text, parts }，
 * 两者可能其一为空）；parts 全空时退化为普通 ChatBubble（Phase 2 mock 形态）。
 * data-testid 委托给各子组件（msg-thinking/msg-tool/msg-error/msg-aborted/chat-bubble），
 * token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import type { CSSProperties } from "react";
import { type RoleKey, space } from "@/src/theme/tokens";
import { ChatBubble } from "@/src/components/ui";
import { MsgThinking } from "./msg-thinking";
import { MsgTool } from "./msg-tool";
import { MsgError } from "./msg-error";
import { MsgAborted } from "./msg-aborted";

/** 前端认识的 part 字段（后端 parts Json 透传，宽松读取防御未知字段）。 */
export interface PartShape {
  type?: string;
  state?: "pending" | "done";
  text?: string;
  name?: string;
  status?: "running" | "success" | "failed";
  input?: string;
  output?: string;
  kind?: "retry" | "quota";
  detail?: string;
}

export interface MsgPartsProps {
  /** 消息 content.parts 原始数组（后端 Json 透传）。 */
  parts: unknown[];
  /** 正文兜底（content.text；parts 无 text 片段时使用）。 */
  bodyText?: string;
  author: string;
  role: RoleKey;
  time?: string;
  style?: CSSProperties;
  className?: string;
}

/** Agent 消息片段渲染：过程片段（thinking/tool/error/aborted）+ 正文置底。 */
export function MsgParts({ parts, bodyText, author, role, time, style, className }: MsgPartsProps) {
  const list = parts as PartShape[];

  // 中断独占：aborted 时其余未完成 Part 不渲染（10 篇 §2.3）
  const aborted = list.find((p) => p.type === "aborted");
  if (aborted) {
    return (
      <div className={className} style={{ display: "flex", flexDirection: "column", gap: space.sm, ...style }}>
        <MsgAborted author={author} role={role} detail={aborted.detail ?? "用户中断"} time={time} />
      </div>
    );
  }

  // 非 text 过程片段按序渲染；text 片段合并为正文置底
  const procParts = list.filter((p) => p.type !== "text");
  const textParts = list.filter((p) => p.type === "text");
  const body = textParts.map((t) => t.text ?? "").join("\n") || bodyText || "";

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
              text={p.text ?? ""}
              time={time}
            />
          );
        }
        if (p.type === "tool") {
          return (
            <MsgTool
              key={i}
              author={author}
              role={role}
              name={p.name ?? "工具"}
              status={p.status ?? "success"}
              input={p.input ?? ""}
              output={p.output ?? ""}
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
        <ChatBubble text={body} type="agent" author={author} role={role} time={time} />
      ) : null}
    </div>
  );
}
