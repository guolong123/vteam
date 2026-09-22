import { createHash } from 'node:crypto';
import {
  buildMessageReceiptDedupKey,
  MESSAGE_RECEIPT_KINDS,
  MESSAGE_RECEIPT_STATUSES,
} from './message-receipt.constants';

/**
 * is_5 起：`from::to::sha1(内容去空白后前64字符)`——issueId 永不参与组键
 * （此前 issueId 非空时不同内容永远同键 → P2002 误判重复派发）。
 */
describe('buildMessageReceiptDedupKey', () => {
  it('同 from/to/issue 不同内容 → 不同键（is_5 回归：禁止 issue 尾碰撞）', () => {
    const a = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      content: '请评审第一版方案设计文档并给出结论',
    });
    const b = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      content: '请修复登录页面的空指针崩溃问题',
    });
    expect(a).not.toBe(b);
  });

  it('同 from/to/内容 → 同键（重派幂等命中）', () => {
    const a = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      content: '请执行该需求',
    });
    const b = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      content: '请执行该需求',
    });
    expect(a).toBe(b);
  });

  it('键尾 = sha1(去空白后前64字符)', () => {
    const content = '  请  评审\n第一版方案\t';
    const stripped = content.replace(/\s+/g, '').slice(0, 64);
    const expected = createHash('sha1').update(stripped, 'utf8').digest('hex');
    expect(
      buildMessageReceiptDedupKey({
        fromInstanceId: 'ta_from',
        toInstanceId: 'ta_to',
        content,
      }),
    ).toBe(`ta_from::ta_to::${expected}`);
  });

  it('键永不为 NULL/空（MySQL 唯一索引多 NULL 陷阱）', () => {
    const key = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_from',
      toInstanceId: 'ta_to',
      content: '  请  评审\n第一版方案\t',
    });
    expect(key).toBeTruthy();
    expect(typeof key).toBe('string');
  });

  it('不同 from/to 即使同内容也不同键', () => {
    const a = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_a',
      toInstanceId: 'ta_b',
      content: 'x',
    });
    const b = buildMessageReceiptDedupKey({
      fromInstanceId: 'ta_a',
      toInstanceId: 'ta_c',
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
