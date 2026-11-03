/**
 * DshToolCard：工具调用卡（DSH `ToolRow` 的对齐实现）
 * =============================================
 * 形态与 DSH 一致：
 * - **默认折叠**成一行（`DisclosureRow` 24px）：状态点 + 工具标题 + 摘要；
 * - 点击展开 → 「输入」「输出」两段（DSH `row.input` / `row.output` 文案），
 *   用 `CodeBlock`（无 header）渲染，拿到 DSH 的代码字体与换行行为；
 * - 状态五态对齐 DSH 的 `toolRowModel`：preparing / running / stopped / error / ok，
 *   映射到 vteam 既有的 `MsgToolStatus` 四态 + 一个「等待填写」；
 * - `preparing`（DSH 里不可展开的那一态）在 vteam 侧没有数据来源（part 一出现就带
 *   input），故不单列；`stopped`（中断）由 adapter 把 status 收敛成 failed，文案上区分。
 *
 * ## 为什么不用 DSH 的 9 种专用视图
 * DSH 按工具名分派 read/search/web/diff/terminal 等专用视图，那套映射基于 **DSH 的
 * 工具名空间**（bash / read / write / edit / grep / glob / web_fetch…）。vteam 是
 * MCP 风格 `<server>_<tool>`，名字对不上。本轮先做**通用卡**（等价于 DSH 的
 * `GenericToolCard` fallback），把观感对齐；专用视图按 vteam 工具清单另排期。
 *
 * @module components/chat/dsh/dsh-tool-card
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import {
  CodeBlock,
  DisclosureRow,
  IconChevronRightOutlineRegular,
  IconCodeOutlineRegular,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { StateDotState } from "@deepseek-ai/dsh-client-ui-primitives";
import { DSH_COMMON_ZH } from "./dsh-labels";
import type { MsgToolStatus } from "@/src/components/chat/msg-tool";
import {
  TOOL_IO_MAX_CHARS,
} from "@/src/components/chat/msg-parts";

/**
 * 工具状态 → DSH 过程行文案 / 状态点语义。
 *
 * 文案对齐 DSH conversation 的 `row.*` 字典：
 * running=运行中 · failed=失败 · stopped=已停止 · input=输入 · output=输出。
 */
const STATUS_VIEW: Record<
  MsgToolStatus,
  { label: string; dot: StateDotState }
> = {
  running: { label: "运行中", dot: "ongoing" },
  success: { label: "", dot: "done" },
  failed: { label: "失败", dot: "error" },
  // 文案沿用 vteam 既有产品口径（MsgTool 的 awaiting-input 标签），不另造一套措辞
  // —— 同一状态在两种渲染变体下必须叫同一个名字。
  "awaiting-input": { label: "等待填写敏感信息", dot: "warning" },
};

/** 工具名 → DSH 风格标题。覆盖不到的回落工具原名（相当于 DSH 的 GenericToolCard）。 */
const TOOL_TITLE_RULES: ReadonlyArray<{ match: RegExp; title: string }> = [
  { match: /(^|_)bash$|^(bash|shell)$/i, title: "运行命令" },
  { match: /(^|_)read(_image)?$/i, title: "读取" },
  { match: /(^|_)write$|(^|_)edit$|str_replace/i, title: "编辑" },
  { match: /grep|(^|_)search$/i, title: "搜索" },
  { match: /(^|_)glob$|(^|_)find$|(^|_)ls$/i, title: "查找文件" },
  { match: /web_fetch|(^|_)fetch$/i, title: "网页获取" },
  { match: /web_search/i, title: "网页搜索" },
  { match: /todo/i, title: "待办" },
];

/** 工具名 → 展示标题（未命中规则时用原名，保证信息不丢）。 */
export function toolTitleOf(name: string): string {
  for (const rule of TOOL_TITLE_RULES) {
    if (rule.match.test(name)) return rule.title;
  }
  return name;
}

/** 单行摘要：取输入首行，超长截断（折叠态只有一行，不能撑开）。 */
function summarize(input: string): string {
  if (input.trim().length === 0) return "";
  const line = input.split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

export interface DshToolCardProps {
  name: string;
  status: MsgToolStatus;
  input: string;
  output: string;
}

/**
 * 一个工具调用块。
 *
 * 折叠态：状态点 + 标题 + 摘要（DSH 用 `·` 分隔，这里同样）；
 * 展开态：输入/输出两段，用 CodeBlock 无 header 渲染（拿到 DSH 的代码排版）。
 */
export function DshToolCard({ name, status, input, output }: DshToolCardProps) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const view = STATUS_VIEW[status];
  const title = toolTitleOf(name);
  const summary = useMemo(() => summarize(input), [input]);

  /** 有内容才可展开（空输出 + 空输入的卡在 adapter 层已被拦掉，这里再兜一次）。 */
  const expandable = input.length > 0 || output.length > 0;

  return (
    <div
      data-testid="dsh-tool"
      data-status={status}
      data-tool={name}
      data-expanded={open ? "true" : undefined}
      // 与思考行同一契约：折叠态自己钉死 24px（DisclosureRow 只保证 header 行），
      // 否则长摘要换行会把相邻工具卡挤在一起。
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        ...(open ? {} : { contain: "size layout", height: "calc(24px + var(--dsh-content-font-delta, 0px))" }),
      }}
    >
      <DisclosureRow
        icon={
          status === "running" ? (
            <StateDot state={view.dot} size={14} />
          ) : status === "awaiting-input" ? (
            <StateDot state={view.dot} size={14} />
          ) : status === "failed" ? (
            <StateDot state={view.dot} />
          ) : (
            <IconCodeOutlineRegular size={14} />
          )
        }
        title={title}
        open={open}
        expandable={expandable}
        onToggle={toggle}
        running={status === "running"}
        expandOnRowClick
        previewChevron={false}
        keepContentWhenOpen
        collapsedContent={
          <>
            {summary.length > 0 ? (
              // 单行 + 省略号：工具输入可能很长，不截断就会换行撑破 24px 行高
              <span
                data-testid="dsh-tool-summary"
                style={{
                  flex: "auto",
                  minWidth: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "block",
                }}
              >
                {" "}· {summary}
              </span>
            ) : null}
            {view.label.length > 0 ? (
              <span
                // awaiting 徽章的语义入口：与 MsgTool 的 msg-tool-awaiting 等价。
                // 敏感命令工具的「等待用户填写」是用户唯一的操作入口，必须可被断言到，
                // 故 awaiting 时把 testid 让给它（其余状态用 dsh-tool-status）。
                data-testid={status === "awaiting-input" ? "dsh-tool-awaiting" : "dsh-tool-status"}
                data-status={status}
                style={{ flex: "none", whiteSpace: "nowrap" }}
              >
                {" "}· {view.label}
              </span>
            ) : null}
          </>
        }
        headerAccessory={
          expandable ? (
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                transform: open ? "rotate(90deg)" : "none",
                transition: "transform 120ms ease",
                opacity: 0.5,
              }}
            >
              <IconChevronRightOutlineRegular size={12} />
            </span>
          ) : undefined
        }
      >
        {open && expandable ? (
          <div data-testid="dsh-tool-body" style={{ padding: "4px 0 8px 22px" }}>
            {input.length > 0 ? (
              <div data-testid="dsh-tool-input">
                <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 2 }}>输入</div>
                <CodeBlock
                  code={input.slice(0, TOOL_IO_MAX_CHARS)}
                  showHeader={false}
                  copyLabel={DSH_COMMON_ZH.copy}
                  copiedLabel={DSH_COMMON_ZH.copied}
                />
              </div>
            ) : null}
            {output.length > 0 ? (
              <div data-testid="dsh-tool-output">
                <div style={{ opacity: 0.6, fontSize: 11, margin: "6px 0 2px" }}>输出</div>
                <CodeBlock
                  code={output.slice(0, TOOL_IO_MAX_CHARS)}
                  showHeader={false}
                  copyLabel={DSH_COMMON_ZH.copy}
                  copiedLabel={DSH_COMMON_ZH.copied}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </DisclosureRow>
    </div>
  );
}
