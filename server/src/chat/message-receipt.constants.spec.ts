import { createHash } from 'node:crypto';
import {
  buildMessageReceiptDedupKey,
  MESSAGE_RECEIPT_KINDS,
  MESSAGE_RECEIPT_STATUSES,
} from './message-receipt.constants';

/**
 * plan-review-execution-gates Todo 1：message_receipts.dedupKey 输入规范。
 *
 * 规范：`from::to::(issueId ?? sha1(内容去空白后前64字符))`——括号必须显式
 * （`??` 优先级低于拼接，不加括号时 NULL 分支永不生效；永不 NULL，
 * MySQL 允许多 NULL 故该键必须永不 NULL）。
 */
describe('buildMessageReceiptDedupKey', () => {
  it('NULL issueId + 两条不同内容 → 不同键（NULL 分支必须生效）', () => {
    const a = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      issueId: null,
      content: '请评审第一版方案设计文档并给出结论',
    });
    const b = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      issueId: null,
      content: '请修复登录页面的空指针崩溃问题',
    });
    expect(a).not.toBe(b);
  });

  it('NULL issueId 的键永不为 NULL/空（MySQL 唯一索引多 NULL 陷阱）', () => {
    const key = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      issueId: null,
      content: '  请  评审\n第一版方案\t',
    });
    expect(key).toBeTruthy();
    expect(typeof key).toBe('string');
  });

  it('NULL issueId 时键尾 = sha1(去空白后前64字符)', () => {
    const content = '  请  评审\n第一版方案\t';
    const stripped = content.replace(/\s+/g, '').slice(0, 64);
    const expected = createHash('sha1').update(stripped, 'utf8').digest('hex');
    expect(
      buildMessageReceiptDedupKey({
        fromInstanceId: 'ta_from',
        toInstanceId: 'ta_to',
        issueId: null,
        content,
      }),
    ).toBe(`ta_from::ta_to::${expected}`);
  });

  it('有 issueId 时直接取 issueId 分支（与内容无关，同一事项幂等）', () => {
    const a = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      issueId: 'is_0000000001',
      content: '内容 A',
    });
    const b = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      issueId: 'is_0000000001',
      content: '内容 B 完全不同',
    });
    expect(a).toBe('ta_from::ta_to::is_0000000001');
    expect(a).toBe(b);
  });

  it('不同 from/to 即使同 issueId 也不同键', () => {
    const a = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_a',
      toInstanceId: 'ta_b',
      issueId: 'is_0000000001',
      content: 'x',
    });
    const b = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_a',
      toInstanceId: 'ta_c',
      issueId: 'is_0000000001',
      content: 'x',
    });
    expect(a).not.toBe(b);
  });

  it('状态/类型枚举与表契约一致（wake/round-notify 为保留位）', () => {
    expect(MESSAGE_RECEIPT_STATUSES).toEqual({
      pending: 'pending',
      acked: 'acked',
      expired: 'expired',
    });
    expect(MESSAGE_RECEIPT_KINDS).toEqual({
      dispatch: 'dispatch',
      wake: 'wake',
      roundNotify: 'round-notify',
    });
  });
});
