/**
 * MsgParts：Agent 消息内容片段渲染器（T14 群聊流式展示增强）
 * =============================================
 * 将一条 agent 消息的 content.parts 按 10 篇 §2.2/§2.3 规则映射为 UI：
 * - reasoning / thinking → MsgThinking（思考折叠条，thinking 为 reasoning 别名）
 * - tool               → MsgTool（工具卡片四态；running secret_command + pending
 *                        secret_input question → awaiting-input，见 secretAwaiting prop）
 * - error              → MsgError（消息级错误）
 * - aborted            → MsgAborted（灰「已中断」）；按 10 篇 §2.3：中断时其余
 *                       未完成 Part 不渲染，仅显示中断灰条
 * - text               → 正文（ChatBubble agent 型，置底作为最终结论）；
 *                        streaming（status=processing）时正文改流式块渲染 + 「生成中」指示，
 *                        终态（sent）消息由 chat.message.new 替换后自动切换回 ChatBubble
 * - 其余类型（step-start/step-finish/patch 等内部片段）→ MsgUnknownPart 默认收起的
 *                       诊断行（B6，标注 part 类型，不再静默丢弃）
 * 正文兜底：parts 无 text 片段时回退 content.text（T10 落库格式 { text, parts }，
 * 两者可能其一为空）；parts 全空时退化为普通 ChatBubble（Phase 2 mock 形态）。
 * 身份（B1）：本组件是单条 agent 消息唯一的身份出口——顶部一条 MessageIdentity
 * （头像/作者/时间各一次），过程片段与最终正文/附件全部作为其下的附属行，
 * 正文与附件路径传 showIdentity={false} 关闭 ChatBubble 自带身份。
 * 分组（B2）：grouped=true 时省略这条共享身份栏（上一条已是同一发送者），
 * 附属行缩进不变，正文/过程/流式 testid 与渲染路径不受影响。
 * 折叠（B11）：收起策略统一落在各子组件（thinking/tool/unknown/附件默认收起，
 * error/aborted 标题状态恒可见、仅超长 detail 默认展开可收起），本分发层不额外折叠。
 * data-testid 委托给各子组件（message-identity/msg-thinking/msg-tool/msg-error/
 * msg-aborted/msg-unknown-part/chat-bubble），token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import type { CSSProperties } from "react";
import { type RoleKey, neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";
import { ChatBubble, Markdown, MessageIdentity } from "@/src/components/ui";
import type { ChatBubbleAttachment } from "@/src/components/ui";
import { LoadingDots } from "./loading-indicator";
import { MsgThinking } from "./msg-thinking";
import { MsgTool } from "./msg-tool";
import type { MsgToolStatus } from "./msg-tool";
import { MsgError } from "./msg-error";
import { MsgAborted } from "./msg-aborted";
import { MsgUnknownPart } from "./msg-unknown-part";
import { stripInjectedContext } from "@/lib/strip-injected-context";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 附属行容器：过程片段与正文挂在共享身份栏之下，左缩进 = 头像 28 + 身份栏间距 8 */
const secondaryRows: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space.sm,
  paddingLeft: 36,
};

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

/** 工具 I/O 进入 DOM 的字符上限（A2）：折叠 summary/title 与展开 input/output 共用同一封顶。 */
export const TOOL_IO_MAX_CHARS = 2000;

/**
 * 工具输入/输出规范化为单行文本：对象/数组 JSON 序列化，字符串原样，
 * 超长（>2000 字符）只保留前 TOOL_IO_MAX_CHARS 个字符——第 2001 字符起不进入 DOM，
 * 不追加省略号以保证「DOM ≤ 前 2000 字符」严格成立。
 */
function formatToolIO(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.length > TOOL_IO_MAX_CHARS
      ? value.slice(0, TOOL_IO_MAX_CHARS)
      : value;
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
  return serialized.length > TOOL_IO_MAX_CHARS
    ? serialized.slice(0, TOOL_IO_MAX_CHARS)
    : serialized;
}

/** serve tool part 状态值（completed 等）→ MsgTool 四态（running/success/failed/awaiting-input）。 */
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

/** serve tool part 工具名（`<serverName>_<toolName>` 或裸名）是否敏感命令工具。 */
function isSecretCommandPart(name: string): boolean {
  return name === "secret_command" || name.endsWith("_secret_command");
}

export interface MsgPartsProps {
  parts: unknown[];
  bodyText?: string;
  /** 已解析的展示作者名（容器剔除裸 id）；缺省时由共享身份栏回落角色标签 */
  author?: string;
  role: RoleKey;
  time?: string;
  streaming?: boolean;
  attachment?: ChatBubbleAttachment;
  isMentionMe?: boolean;
  style?: CSSProperties;
  className?: string;
  /** 消息终态（sent/failed）：part 仍为 pending/running 时收敛显示，避免"运行中"卡死 */
  messageStatus?: string;
  /** B2 分组态：与上一条为同发送者连续消息时省略共享身份栏，过程行与正文缩进保持对齐 */
  grouped?: boolean;
  /** B8 头像缩写：调用方从已解析人名生成（lib/message-initials），只透传给共享身份栏 */
  initials?: string;
  /**
   * 敏感命令「等待填写」派生（sensitive-command-tool todo 8）：调用方判定当前消息所属
   * session 存在 pending `secret_input` question（来自 agent.question / GET /questions）后传入。
   * 本层只做两件事——仅对 running 的 `secret_command` tool part 升级为 awaiting-input，
   * 其余 part / 其余状态一律按原三态渲染。question resolve/reject/expire 或 tool part
   * 落终态时调用方把该 prop 收回（或本层因终态自然不命中），状态即清除。
   */
  secretAwaiting?: boolean;
}

export function MsgParts({ parts, bodyText, author, role, time, streaming, attachment, isMentionMe, style, className, messageStatus, grouped, initials, secretAwaiting }: MsgPartsProps) {
  const list = (parts ?? []) as PartShape[];
  /** 终态收敛：消息已 sent/failed 但 part 仍 pending/running → sent 收敛成功，failed 收敛失败 */
  const terminal = messageStatus === "sent" || messageStatus === "failed";

  // 中断独占：aborted 时其余未完成 Part 不渲染（10 篇 §2.3）
  const aborted = list.find((p) => p.type === "aborted");
  if (aborted) {
    return (
      <div className={className} style={{ display: "flex", flexDirection: "column", gap: space.sm, ...style }}>
        {!grouped && <MessageIdentity author={author} role={role} time={time} initials={initials} />}
        <div style={secondaryRows}>
          <MsgAborted detail={aborted.detail ?? "用户中断"} />
        </div>
      </div>
    );
  }

  const procParts = list.filter((p) => p.type !== "text");
  const textParts = list.filter((p) => p.type === "text");
  const body = textParts.map((t) => t.text ?? "").join("\n") || bodyText || "";
  const cleanBody = stripInjectedContext(body);
  // 无任何可渲染内容时不出身份栏：保持既有「空消息不占位」行为
  const hasContent = list.length > 0 || cleanBody.length > 0 || Boolean(attachment);

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: space.sm, ...style }}>
      {hasContent && !grouped && <MessageIdentity author={author} role={role} time={time} initials={initials} />}
      <div style={secondaryRows}>
        {procParts.map((p, i) => {
          if (p.type === "reasoning" || p.type === "thinking") {
            return (
              <MsgThinking
                key={i}
                state={p.state ?? "done"}
                text={p.text ?? p.summary ?? p.thoughts ?? p.detail ?? ""}
              />
            );
          }
          if (p.type === "tool") {
            const rawState = p.state;
            const st =
              rawState !== undefined && rawState !== null && typeof rawState === "object"
                ? (rawState as unknown as Record<string, unknown>)
                : undefined;
            const toolName = String(p.tool ?? p.name ?? "工具");
            let status: MsgToolStatus = toToolStatus(st?.status ?? p.status);
            if (terminal && status === "running") {
              status = messageStatus === "failed" ? "failed" : "success";
            }
            // awaiting-input 只在「仍在 running」时成立：question 已收敛或 part 已终态都不命中
            if (secretAwaiting && status === "running" && isSecretCommandPart(toolName)) {
              status = "awaiting-input";
            }
            return (
              <MsgTool
                key={i}
                name={toolName}
                status={status}
                input={formatToolIO(st?.input)}
                output={formatToolIO(st?.output)}
              />
            );
          }
          if (p.type === "error") {
            return <MsgError key={i} kind={p.kind ?? "retry"} detail={p.detail ?? "处理失败"} />;
          }
          // step-start/step-finish/patch 等内部过程 part 不渲染（过程噪声）。
          // 已在分发层显式处理之外的未识别 type 同样不渲染。
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
          ) : messageStatus === "failed" ? (
            <MsgError kind="failed" detail={cleanBody} />
          ) : (
            <ChatBubble showIdentity={false} text={cleanBody} type="agent" author={author} role={role} time={time} attachment={attachment} isMentionMe={isMentionMe} />
          )
        ) : attachment ? (
          <ChatBubble showIdentity={false} text="" type="agent" author={author} role={role} time={time} attachment={attachment} isMentionMe={isMentionMe} />
        ) : null}
      </div>
    </div>
  );
}
