/**
 * DshMessage：一条 agent 消息的 DSH 风格合成
 * =============================================
 * 私聊 Tab 的渲染入口（`MsgParts variant="dsh"` 委托到这里）。
 *
 * 组成顺序（**按 part 发生顺序的时间线**，与 DSH 一致）：
 * ```
 * [身份栏 MessageIdentity]（grouped 时省略）
 *   └ 依次渲染 block：
 *       reasoning → DshReasoning（折叠的思考行）
 *       tool      → DshToolCard （折叠的工具卡）
 *       text      → DshMarkdown（完整 Markdown 正文，流式时增量解析）
 *       error     → MsgError    （消息级错误，复用既有组件保证文案一致）
 *   └ 附件（有则出 ChatBubble 的附件形态；多附件纵向逐张渲染）
 * ```
 *
 * ## 与群聊（bubble）的排版差异（刻意）
 * bubble 是「过程在上、正文置底」的**对话式**排版；DSH 是**时间线**排版 ——
 * 正文就在它产生的位置。私聊对齐 DSH ⇒ 保持时间线，不把正文抽出来置底。
 *
 * ## aborted 的独占处理
 * 与 `MsgParts` 同口径：消息含 `aborted` part 时，其余未完成 part **不渲染**，
 * 只出一条「已中断」灰条（10 篇 §2.3）。本组件在进入 block 映射前先判。
 *
 * @module components/chat/dsh/dsh-message
 */
"use client";

import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { RoleKey } from "@/src/theme/tokens";
import { space } from "@/src/theme/tokens";
import type { MarkdownLabels } from "@deepseek-ai/dsh-client-ui-primitives";
import { ChatBubble, MessageIdentity } from "@/src/components/ui";
import type { ChatBubbleAttachment } from "@/src/components/ui";
import { MsgAborted } from "@/src/components/chat/msg-aborted";
import { MsgError } from "@/src/components/chat/msg-error";
import { DshMarkdown } from "./dsh-markdown";
import { DshReasoning } from "./dsh-reasoning";
import { DshToolCard } from "./dsh-tool-card";
import { toDshBlocks } from "./dsh-parts-adapter";
import type { DshBlock } from "./dsh-parts-adapter";
import { DshProcessGroup } from "./dsh-process-group";
import { useMarkdownLabels } from "./dsh-labels";

/** 附属行容器：过程片段与正文挂在共享身份栏之下，左缩进 = 头像 28 + 身份栏间距 8。 */
const secondaryRows: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space.sm,
  paddingLeft: 36,
};

export interface DshMessageProps {
  /** 服务端 `content.parts[]`（私聊为全量：text/reasoning/tool/error/aborted）。 */
  parts: unknown[];
  /** parts 无 text 时的正文兜底（`content.text`）。 */
  bodyText?: string;
  /** 已解析的展示作者名（容器已剔除裸 id）。 */
  author?: string;
  role: RoleKey;
  time?: string;
  /** 消息是否仍在流式生成（`status === "processing"`）。 */
  streaming?: boolean;
  /** 消息终态：processing / sent / failed…（tool 卡终态收敛用）。 */
  messageStatus?: string;
  /** 该会话存在待填写的 secret_input → 敏感命令卡升级为 awaiting-input。 */
  secretAwaiting?: boolean;
  /** 多附件（≤10）：有则走 ChatBubble 附件形态，纵向渲染多张附件卡。 */
  attachments?: ChatBubbleAttachment[];
  isMentionMe?: boolean;
  /** 与上一条为同发送者连续消息时省略身份栏。 */
  grouped?: boolean;
  /** 头像缩写（由调用方从已解析人名生成）。 */
  initials?: string;
  style?: CSSProperties;
  className?: string;
}

/**
 * 一条 agent 消息（DSH 风格）。
 *
 * 无任何可渲染内容时返回 `null` —— 与 `MsgParts` 同口径，避免「只有头像+时间」的空消息。
 */
export function DshMessage({
  parts,
  bodyText,
  author,
  role,
  time,
  streaming = false,
  messageStatus,
  secretAwaiting = false,
  attachments,
  isMentionMe,
  grouped = false,
  initials,
  style,
  className,
}: DshMessageProps) {
  const labels = useMarkdownLabels();
  /** 多附件存在性：缺省 / 空数组即无附件（与 MsgParts 同口径，避免渲染空附件区）。 */
  const hasAttachments = (attachments?.length ?? 0) > 0;

  /** 中断独占：与 MsgParts 同口径，先判 aborted 再谈块映射。 */
  const aborted = useMemo(() => {
    const list = Array.isArray(parts) ? parts : [];
    const hit = list.find(
      (p) => (p as { type?: string } | null)?.type === "aborted",
    ) as { detail?: string } | undefined;
    return hit;
  }, [parts]);

  const blocks = useMemo(
    () =>
      aborted
        ? []
        : toDshBlocks(parts, {
            streaming,
            messageStatus,
            secretAwaiting,
            bodyText,
          }),
    [aborted, parts, streaming, messageStatus, secretAwaiting, bodyText],
  );

  if (aborted) {
    return (
      <div
        data-testid="dsh-message"
        className={className}
        style={{ display: "flex", flexDirection: "column", gap: space.sm, ...style }}
      >
        {!grouped && <MessageIdentity author={author} role={role} time={time} initials={initials} />}
        <div style={secondaryRows}>
          <MsgAborted detail={aborted.detail ?? "用户中断"} />
        </div>
      </div>
    );
  }

  if (blocks.length === 0 && !hasAttachments) return null;

  return (
    <div
      data-testid="dsh-message"
      data-streaming={streaming ? "true" : undefined}
      className={className}
      style={{ display: "flex", flexDirection: "column", gap: space.sm, ...style }}
    >
      {!grouped && <MessageIdentity author={author} role={role} time={time} initials={initials} />}
      <div style={secondaryRows}>
        {renderRuns(blocks, streaming, labels)}
        {hasAttachments ? (
          <ChatBubble
            showIdentity={false}
            text=""
            type="agent"
            author={author}
            role={role}
            time={time}
            attachments={attachments}
            isMentionMe={isMentionMe}
          />
        ) : null}
      </div>
    </div>
  );
}

/** 一个「过程块」（reasoning / tool / error）—— 会被收进过程组。 */
function isProcessBlock(block: DshBlock): boolean {
  return block.kind === "reasoning" || block.kind === "tool" || block.kind === "error";
}

/** 单个块渲染（过程组内外共用；导出供成员视角的聚合过程组复用）。 */
export function renderDshBlock(block: DshBlock, labels: MarkdownLabels) {
  switch (block.kind) {
    case "reasoning":
      return (
        <DshReasoning key={block.key} text={block.text} running={block.running} labels={labels} />
      );
    case "tool":
      return (
        <DshToolCard
          key={block.key}
          name={block.name}
          status={block.status}
          input={block.input}
          output={block.output}
        />
      );
    case "text":
      return (
        <div key={block.key} data-testid="dsh-body" style={{ minWidth: 0 }}>
          <DshMarkdown text={block.text} streaming={block.streaming} labels={labels} />
        </div>
      );
    case "error":
      return <MsgError key={block.key} kind={block.errorKind} detail={block.detail} />;
    default:
      return null;
  }
}

/**
 * 按「连续过程片段」分组渲染。
 *
 * - 连续 **≥2** 个过程块 → 合成一个可展开的 `DshProcessGroup`（降噪的主要来源）；
 * - 单个过程块 → 原样平铺（为了一个思考行套一层折叠反而更难读）；
 * - 正文块（text）永远平铺，保持「答案始终可见」。
 *
 * 为什么按**连续段**而不是「整轮一个组」：块之间可能夹着正文（中途汇报结论），
 * 按连续段分组既降噪又不打乱时间线顺序。
 */
function renderRuns(blocks: DshBlock[], streaming: boolean, labels: MarkdownLabels) {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (!isProcessBlock(block)) {
      out.push(renderDshBlock(block, labels));
      i += 1;
      continue;
    }
    // 收集一段连续的过程块
    const run: DshBlock[] = [];
    while (i < blocks.length) {
      const current = blocks[i];
      if (!isProcessBlock(current)) break;
      run.push(current);
      i += 1;
    }
    if (run.length === 1) {
      out.push(renderDshBlock(run[0], labels));
      continue;
    }
    const toolCount = run.filter((b) => b.kind === "tool").length;
    const reasoningCount = run.filter((b) => b.kind === "reasoning").length;
    out.push(
      <DshProcessGroup
        key={`process-${run[0].key}`}
        toolCount={toolCount}
        reasoningCount={reasoningCount}
        streaming={streaming}
      >
        {run.map((b) => renderDshBlock(b, labels))}
      </DshProcessGroup>,
    );
  }
  return out;
}
