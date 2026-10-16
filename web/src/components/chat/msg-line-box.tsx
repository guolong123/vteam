/**
 * MsgLineBox：私聊单行盒（reasoning / text 过程片段的统一渲染出口）
 * =============================================
 * 私聊 Tab 下，agent 消息的每个 reasoning / text part 各渲染一个**独立可折叠的单行盒**：
 * - 默认**收起** = 单行 tail-follow：右边缘锚定，最新文本始终可见，超出部分从**左侧**裁掉；
 * - 纯布局锚定（`overflow:hidden` 容器 + `justify-content:flex-end` + 内部 `white-space:nowrap`），
 *   **无任何动画/keyframe/marquee**，因此自然跟随 token 到达速度，文本停止增长即停；
 * - 点击展开 = 完整文本（`white-space:pre-wrap` 正常换行）；
 * - 与过程行同款外观（虚线中性描边、小字号、可点击、左对齐）。
 *
 * tone 决定文字层级（同一形状，只差颜色 / 字形）：
 * - `thinking` → 更暗的中性色（neutral[400]）+ 斜体（对齐既有思考行观感）；
 * - `body`     → 更亮的中性色（neutral[700]）。
 *
 * data-testid=msg-line-box（根，带 data-tone / data-state）；折叠开关
 * data-testid=msg-line-box-toggle（aria-expanded）；展开态正文 data-testid=msg-line-box-text。
 * token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import { useState } from "react";
import type { CSSProperties } from "react";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export type MsgLineBoxTone = "thinking" | "body";

/** tone → 文字色 / 字形：thinking 更暗且斜体，body 更亮常规。 */
const toneStyle: Record<MsgLineBoxTone, CSSProperties> = {
  thinking: { color: neutral[400], fontStyle: "italic" },
  body: { color: neutral[700] },
};

export interface MsgLineBoxProps {
  text: string;
  tone: MsgLineBoxTone;
  style?: CSSProperties;
  className?: string;
}

/**
 * 单行过程盒：默认收起为 tail-follow 单行，点击展开为完整多行文本。
 * 收起/展开是同一份文本的两种布局，不做截断（收起态由容器裁掉头部）。
 */
export function MsgLineBox({ text, tone, style, className }: MsgLineBoxProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      data-testid="msg-line-box"
      data-tone={tone}
      data-state={expanded ? "expanded" : "collapsed"}
      className={className}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: space.sm,
        maxWidth: "78%",
        alignSelf: "flex-start",
        ...baseFont,
        ...style,
      }}
    >
      <button
        type="button"
        data-testid="msg-line-box-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          flex: 1,
          minWidth: 0,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[100],
          border: `1px dashed ${neutral[300]}`,
          cursor: "pointer",
          transition: "border-color .15s ease",
          textAlign: "left",
          fontFamily: fontFamily.body,
          fontSize: fontSize.sm,
        }}
      >
        {expanded ? (
          <span
            data-testid="msg-line-box-text"
            style={{
              display: "block",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.6,
              ...toneStyle[tone],
            }}
          >
            {text}
          </span>
        ) : (
          // tail-follow：外层固定宽度 + 右对齐，内层 nowrap 自然溢出 → 右侧（尾部）可见、左侧（头部）被裁。
          // 无 animation / keyframe / marquee：纯布局，token 一停就停。
          <span
            style={{
              display: "flex",
              justifyContent: "flex-end",
              overflow: "hidden",
              maxWidth: "100%",
            }}
          >
            <span
              style={{
                whiteSpace: "nowrap",
                flex: "0 0 auto",
                lineHeight: 1.6,
                ...toneStyle[tone],
              }}
            >
              {text}
            </span>
          </span>
        )}
      </button>
    </div>
  );
}
