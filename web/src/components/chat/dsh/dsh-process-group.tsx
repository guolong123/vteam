/**
 * DshProcessGroup：把一轮里的「过程片段」收成一个可展开的组
 * =============================================
 * 问题：DSH 一轮会产出 **每个 step 一条 reasoning**，再叠上每次 tool 调用 ——
 * 一条消息里 10+ 个思考行平铺，视觉噪音极大，用户的原话是「思考消息都挤到一起了」。
 *
 * DSH 的做法是把整轮过程收进一个折叠组（`TurnProcessNodeView`），只露一行概览。
 * 本组件按同样思路实现：**连续的过程片段**（reasoning / tool / error）合成一组，
 * 默认折叠，折叠行显示「N 次工具调用 · M 段思考」。
 *
 * ## 展开时机（刻意的）
 * - **流式中默认展开**：否则用户在模型输出时看不到任何过程，观感像"卡住了"；
 * - **定稿后默认折叠**：回复完成后过程不再是主要信息，收起来降噪；
 * - 用户手动点过之后以用户的为准（`manual` 一旦有值不再随流式状态自动变）。
 *
 * @module components/chat/dsh/dsh-process-group
 */
"use client";

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { DisclosureRow, IconTriangleRightFillRegular } from "@deepseek-ai/dsh-client-ui-primitives";

export interface DshProcessGroupProps {
  /** 这一组里的过程块数量（用于概览文案）。 */
  toolCount: number;
  reasoningCount: number;
  /** 是否仍在流式生成（决定默认展开/折叠）。 */
  streaming: boolean;
  children: ReactNode;
}

/**
 * 一轮的过程折叠组。
 *
 * 折叠态自己钉死 24px（`DisclosureRow` 只保证 header 行高），否则内容会撑破行高
 * —— 与思考行/工具卡同一契约（见 dsh-reasoning.tsx 的说明）。
 */
export function DshProcessGroup({
  toolCount,
  reasoningCount,
  streaming,
  children,
}: DshProcessGroupProps) {
  /** null = 跟随流式状态自动；true/false = 用户手动选择过。 */
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? streaming;
  const toggle = useCallback(() => setManual((prev) => !(prev ?? streaming)), [streaming]);

  const parts: string[] = [];
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`);
  if (reasoningCount > 0) parts.push(`${reasoningCount} 段思考`);
  const summary = parts.join(" · ");

  return (
    <div
      data-testid="dsh-process-group"
      data-state={open ? "expanded" : "collapsed"}
      data-tools={toolCount}
      data-reasoning={reasoningCount}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        ...(open
          ? {}
          : { contain: "size layout", height: "calc(24px + var(--dsh-content-font-delta, 0px))" }),
      }}
    >
      <DisclosureRow
        icon={<IconTriangleRightFillRegular size={12} />}
        title="过程"
        open={open}
        expandable
        onToggle={toggle}
        running={streaming}
        expandOnRowClick
        previewChevron
        keepContentWhenOpen
        collapsedContent={
          summary.length > 0 ? (
            <span
              data-testid="dsh-process-summary"
              style={{
                flex: "auto",
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "block",
                fontSize: 13,
                lineHeight: "20px",
              }}
            >
              {" "}· {summary}
            </span>
          ) : undefined
        }
      >
        {open ? (
          <div
            data-testid="dsh-process-body"
            style={{
              padding: "4px 0 4px 22px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              minWidth: 0,
            }}
          >
            {children}
          </div>
        ) : null}
      </DisclosureRow>
    </div>
  );
}
