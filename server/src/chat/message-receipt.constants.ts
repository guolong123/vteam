import { createHash } from 'node:crypto';

/**
 * 派发回执账本域常量（31 篇《派发-回执配对机制》§3.1，message_receipts 表）。
 *
 * 字符串枚举 + 应用层常量（双库兼容：不声明 Prisma enum，
 * 对齐 schema.prisma 头部「字符串枚举 + Json 列」约定）。
 */
export const MESSAGE_RECEIPT_STATUSES = {
  pending: 'pending',
  acked: 'acked',
  expired: 'expired',
} as const;

export type MessageReceiptStatus =
  (typeof MESSAGE_RECEIPT_STATUSES)[keyof typeof MESSAGE_RECEIPT_STATUSES];

/**
 * 回执类型：dispatch 常规派发；wake / round-notify 为保留位——永不写入，
 * 仅防未来误用（plan-review-execution-gates Todo 1）。
 */
export const MESSAGE_RECEIPT_KINDS = {
  dispatch: 'dispatch',
  wake: 'wake',
  roundNotify: 'round-notify',
} as const;

export type MessageReceiptKind =
  (typeof MESSAGE_RECEIPT_KINDS)[keyof typeof MESSAGE_RECEIPT_KINDS];

export interface BuildMessageReceiptDedupKeyInput {
  fromInstanceId: string;
  toInstanceId: string;
  /** 派发词原文（参与组键；issueId 已不再参与组键，见下）。 */
  content: string;
}

/**
 * 内容归一化（dedupKey 哈希输入）：去全部空白后取前 64 字符。
 */
export function normalizeReceiptContent(content: string): string {
  return content.replace(/\s+/g, '').slice(0, 64);
}

/**
 * 去重键：`from::to::sha1(内容去空白后前64字符)`。
 *
 * is_5 修复：此前尾部为 `(issueId ?? 内容哈希)`——issueId 非空时不同派发词
 * 永远同键，`dedup_key` 唯一约束下 P2002，被误判为重复派发（连续误吞）。
 * 现一律按内容哈希组键：同 (from,to,内容) 重派幂等命中；不同内容永不碰撞。
 * issueId 仍按列落库（`issue_id` 审计/宿主字段），仅不再参与组键；历史兼容
 * 不考虑（调用方显式确认），旧键形状直接废弃。
 *
 * 幂等窗口语义（`dedup_key` 列 @unique，库层永久唯一）：同键重派撞 P2002 →
 * 既有 pending 行复用排期、非 pending 行跳过排期（本次消息本身仍已派发；
 * 消息层另有 `NOTIFY_DEDUP_WINDOW_MS` 短窗口内容幂等回既有 messageId）。
 * 返回值永不 NULL（MySQL 唯一索引允许多 NULL，故该键必须永不 NULL）。
 */
export function buildMessageReceiptDedupKey(
  input: BuildMessageReceiptDedupKeyInput,
): string {
  const tail = createHash('sha1')
    .update(normalizeReceiptContent(input.content), 'utf8')
    .digest('hex');
  return `${input.fromInstanceId}::${input.toInstanceId}::${tail}`;
}
