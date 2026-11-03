/**
 * dsh-parts-adapter：vteam part 模型 → DSH block 模型
 * =============================================
 * 私聊的权威数据形状是服务端的 `content.parts[]`（`{id,type,text,synthetic,tool,state,time,…}`），
 * 而 DSH 的渲染单元是「block」（`text` / `reasoning` / `image` / `tool-call` / other）。
 * 本模块只做一件事：**把前者映射成后者**，渲染层（`dsh-message.tsx`）不认识 vteam part。
 *
 * ## 为什么不让渲染层直接读 part
 * `MsgParts` 的 line/bubble 两条老分支里混了大量 part 语义（去重、synthetic 剔除、
 * 注入上下文剥离、空卡兜底、终态收敛、awaiting-input 派生）。把这些**收敛到一个
 * 纯函数**里，DSH 分支才能只关心「怎么画」。老分支保持原样不动（群聊观感零变化）。
 *
 * ## 与老分支完全一致的口径（刻意对齐，避免两种私聊观感打架）
 * - 按 `part.id` 去重，**保留最后一次快照**（历史脏数据里同一次工具调用会重复落多个快照）；
 * - `text` 剔除 `synthetic`（注入上下文）片段，并剥离注入上下文文本；
 * - 空 reasoning（`text=""` 占位）不渲染；
 * - 工具卡「输入输出皆零信息量」时不渲染 —— 但在流的当前消息上豁免（进度反馈不能闪断）；
 * - 消息终态（sent/failed）时工具卡若仍 `running` → 收敛为 success/failed；
 * - `secret_command` 在 `running` 且存在待填 secret_input 时派生 `awaiting-input`。
 *
 * @module components/chat/dsh/dsh-parts-adapter
 */
"use client";

import { stripInjectedContext } from "@/lib/strip-injected-context";
import {
  formatToolIO,
  isEmptyToolIO,
  isSecretCommandPart,
  toToolStatus,
} from "@/src/components/chat/msg-parts";
import type { PartShape } from "@/src/components/chat/msg-parts";
import type { MsgToolStatus } from "@/src/components/chat/msg-tool";

/** 正文块。 */
export interface DshTextBlock {
  kind: "text";
  key: string;
  text: string;
  /** 是否仍在流式生成（决定 MarkdownText 的增量解析）。 */
  streaming: boolean;
}

/** 思考块。 */
export interface DshReasoningBlock {
  kind: "reasoning";
  key: string;
  text: string;
  /** 是否是正在生成的那一条（决定摘要 shimmer 与折叠状态）。 */
  running: boolean;
}

/** 工具调用块。 */
export interface DshToolBlock {
  kind: "tool";
  key: string;
  name: string;
  status: MsgToolStatus;
  input: string;
  output: string;
}

/** 消息级错误块。 */
export interface DshErrorBlock {
  kind: "error";
  key: string;
  errorKind: "retry" | "quota" | "failed";
  detail: string;
}

export type DshBlock = DshTextBlock | DshReasoningBlock | DshToolBlock | DshErrorBlock;

export interface ToDshBlocksOptions {
  /** 消息是否仍在流式生成（`status === "processing"`）。 */
  streaming?: boolean;
  /** 消息终态（sent / failed / processing…）。 */
  messageStatus?: string;
  /** 该会话当前存在待填写的 secret_input（敏感命令卡升级为 awaiting-input）。 */
  secretAwaiting?: boolean;
  /** parts 无 text 片段时的正文兜底（`content.text`）。 */
  bodyText?: string;
}

/** 按 part.id 去重，保留最后一次快照（顺序取最后一次出现的位置）。 */
function dedupeById(items: PartShape[]): PartShape[] {
  const seen = new Set<string>();
  const out: PartShape[] = [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const p = items[i];
    const id = typeof p.id === "string" && p.id.length > 0 ? p.id : undefined;
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(p);
  }
  return out.reverse();
}

/** reasoning part 的文本（serve 可能落在 summary/thoughts/detail 而非 text）。 */
function reasoningText(p: PartShape): string {
  return p.text ?? p.summary ?? p.thoughts ?? p.detail ?? "";
}

/** part 是否最终会产出可见内容（用于正文兜底判定）。 */
function isRenderableTextPart(p: PartShape): boolean {
  if (p.type !== "text") return false;
  if (p.synthetic === true) return false;
  return stripInjectedContext(p.text ?? "").trim().length > 0;
}

/**
 * vteam part 数组 → DSH block 数组（保持**原始顺序**）。
 *
 * 顺序为什么不重排：bubble 分支是「过程在上、正文置底」的对话式排版，
 * 而 DSH 是「按发生顺序」的时间线。私聊对齐 DSH ⇒ 保持原顺序。
 */
export function toDshBlocks(
  parts: unknown,
  options: ToDshBlocksOptions = {},
): DshBlock[] {
  const { streaming = false, messageStatus, secretAwaiting = false, bodyText } = options;
  const list = (Array.isArray(parts) ? parts : []) as PartShape[];
  const deduped = dedupeById(list);

  /** 终态收敛：消息已 sent/failed 但 part 仍 pending/running。 */
  const terminal = messageStatus === "sent" || messageStatus === "failed";

  const toolBlockOf = (p: PartShape, index: number): DshToolBlock | null => {
    const rawState = p.state as unknown;
    const state =
      rawState !== null && rawState !== undefined && typeof rawState === "object"
        ? (rawState as Record<string, unknown>)
        : undefined;
    const name = String(p.tool ?? p.name ?? "工具");
    let status: MsgToolStatus = toToolStatus(state?.status ?? p.status);
    if (terminal && status === "running") {
      status = messageStatus === "failed" ? "failed" : "success";
    }
    if (secretAwaiting && status === "running" && isSecretCommandPart(name)) {
      status = "awaiting-input";
    }
    const live = status === "running" && (streaming || messageStatus === "processing");
    const errorText = typeof state?.error === "string" ? state.error : "";
    const input = formatToolIO(state?.input);
    const output = formatToolIO(state?.output) || errorText;
    // 空卡兜底：与老分支同一口径（流式当前消息上的 running 卡豁免，进度反馈不能闪断）
    if (status !== "awaiting-input" && !live && isEmptyToolIO(input) && isEmptyToolIO(output)) {
      return null;
    }
    return {
      kind: "tool",
      key: p.id ?? `tool-${index}`,
      name,
      status,
      input,
      output,
    };
  };

  // 「正在生成的那一条」：最后一条有内容的 reasoning / 最后一条可渲染 text。
  // 用位置推断而非 part.state —— reasoning part 没有 state 字段（serve 只在 tool 上有）。
  let lastReasoningIdx = -1;
  let lastTextIdx = -1;
  deduped.forEach((p, i) => {
    if ((p.type === "reasoning" || p.type === "thinking") && reasoningText(p).trim().length > 0) {
      lastReasoningIdx = i;
    }
    if (isRenderableTextPart(p)) lastTextIdx = i;
  });

  const blocks: DshBlock[] = [];
  deduped.forEach((p, i) => {
    const type = p.type ?? "";

    if (type === "reasoning" || type === "thinking") {
      const text = reasoningText(p);
      if (text.trim().length === 0) return;
      blocks.push({
        kind: "reasoning",
        key: p.id ?? `reasoning-${i}`,
        text,
        running: streaming && i === lastReasoningIdx,
      });
      return;
    }

    if (type === "text") {
      if (p.synthetic === true) return;
      const text = stripInjectedContext(p.text ?? "");
      if (text.trim().length === 0) return;
      blocks.push({
        kind: "text",
        key: p.id ?? `text-${i}`,
        text,
        // 只有**最后一条**正文承担流式；更早的正文都已定稿（DSH 同口径）
        streaming: streaming && i === lastTextIdx,
      });
      return;
    }

    if (type === "tool") {
      const block = toolBlockOf(p, i);
      if (block !== null) blocks.push(block);
      return;
    }

    if (type === "error") {
      blocks.push({
        kind: "error",
        key: p.id ?? `error-${i}`,
        errorKind: p.kind ?? "retry",
        detail: p.detail ?? "处理失败",
      });
    }
    // step-start / step-finish / snapshot / patch 等内部片段一律不渲染（两端同口径）
  });

  // 正文兜底：parts 里没有可渲染 text 时回落到 content.text（T10 落库两者可能其一为空）
  if (!blocks.some((b) => b.kind === "text")) {
    const fallback = stripInjectedContext(bodyText ?? "").trim();
    if (fallback.length > 0) {
      blocks.push({
        kind: "text",
        key: "body-fallback",
        text: fallback,
        streaming: false,
      });
    }
  }

  return blocks;
}
