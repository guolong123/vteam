/**
 * MemberProcessAggregate：成员视角的「聚合过程组」
 * =============================================
 * 成员视角展示该成员**完整会话历史**时，每轮都带一组 reasoning/tool。若逐轮平铺折叠行，
 * 列表会被「过程 · 1 次工具调用 · 1 段思考」刷屏（用户实测反馈）。
 *
 * 本组件把**一段连续的过程**（跨多轮累积）合成一个折叠组，只露一行概览：
 *   ▸ 过程 · 12 次工具调用 · 10 段思考
 * 展开后按原顺序渲染其中的思考行与工具卡（与 dsh 消息内过程组同一渲染器）。
 *
 * 与 `DshProcessGroup` 的分工：后者负责折叠 UI，本组件负责「把 parts 解析成块 + 计数」。
 *
 * @module components/chat/dsh/member-process-aggregate
 */
"use client";

import { useMemo } from "react";
import type { MarkdownLabels } from "@deepseek-ai/dsh-client-ui-primitives";
import { toDshBlocks } from "./dsh-parts-adapter";
import { DshProcessGroup } from "./dsh-process-group";
import { renderDshBlock } from "./dsh-message";
import { useMarkdownLabels } from "./dsh-labels";

export interface MemberProcessAggregateProps {
  /** 聚合的过程片段（reasoning / tool / error，可跨多轮）。 */
  parts: unknown[];
}

export function MemberProcessAggregate({ parts }: MemberProcessAggregateProps) {
  const labels: MarkdownLabels = useMarkdownLabels();
  const { toolCount, reasoningCount, blocks } = useMemo(() => {
    const all = toDshBlocks(parts);
    const processOnly = all.filter(
      (b) => b.kind === "reasoning" || b.kind === "tool" || b.kind === "error",
    );
    return {
      toolCount: all.filter((b) => b.kind === "tool").length,
      reasoningCount: all.filter((b) => b.kind === "reasoning").length,
      blocks: processOnly,
    };
  }, [parts]);

  if (blocks.length === 0) return null;
  return (
    <DshProcessGroup
      toolCount={toolCount}
      reasoningCount={reasoningCount}
      streaming={false}
    >
      {blocks.map((block) => renderDshBlock(block, labels))}
    </DshProcessGroup>
  );
}
