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
  /** 派发宿主 issue；null = 无宿主，走内容哈希分支 */
  issueId: string | null;
  /** 派发词原文（仅 issueId 为 null 时参与组键） */
  content: string;
}

/**
 * 内容归一化（dedupKey 哈希输入）：去全部空白后取前 64 字符。
 */
export function normalizeReceiptContent(content: string): string {
  return content.replace(/\s+/g, '').slice(0, 64);
}

/**
 * 去重键：`from::to::(issueId ?? sha1(内容去空白后前64字符))`。
 *
 * 括号必须显式——`??` 优先级低于字符串拼接，不加括号时 NULL 分支永不生效；
 * 返回值永不 NULL（MySQL 唯一索引允许多 NULL，故该键必须永不 NULL）。
 */
export function buildMessageReceiptDedupKey(
  input: BuildMessageReceiptDedupKeyInput,
): string {
  const tail =
    input.issueId ??
    createHash('sha1')
      .update(normalizeReceiptContent(input.content), 'utf8')
      .digest('hex');
  return `${input.fromInstanceId}::${input.toInstanceId}::${tail}`;
}
