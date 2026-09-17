import {
  TRIGGER_KIND,
  buildTriggerDedupKey,
  isTriggerKind,
  triggerSourceOf,
} from './trigger.constants';
import { buildReceiptNudgeDedupKey } from '../../chat/receipt-nudge.handler';
import { buildReviewRoundTimeoutDedupKey } from '../../chat/review-round-timeout.handler';

describe('trigger.constants（kind 白名单 + dedup 组装）', () => {
  it('白名单命中：六 kind 通过，未知 kind 拒绝', () => {
    expect(isTriggerKind(TRIGGER_KIND.RECEIPT_NUDGE)).toBe(true);
    expect(isTriggerKind(TRIGGER_KIND.REVIEW_ROUND_TIMEOUT)).toBe(true);
    expect(isTriggerKind(TRIGGER_KIND.PROGRESSION_PATROL)).toBe(true);
    expect(isTriggerKind(TRIGGER_KIND.SESSION_IDLE_SCAN)).toBe(true);
    expect(isTriggerKind(TRIGGER_KIND.HOOK_FIRE)).toBe(true);
    expect(isTriggerKind(TRIGGER_KIND.HOOK_POLL)).toBe(true);
    expect(Object.values(TRIGGER_KIND)).toHaveLength(6);
    expect(isTriggerKind('task_trigger')).toBe(false);
    expect(isTriggerKind('test_kind')).toBe(false);
    expect(isTriggerKind('')).toBe(false);
  });

  it('dedup 组装与历史逐字节一致', () => {
    expect(
      buildTriggerDedupKey(TRIGGER_KIND.RECEIPT_NUDGE, 'tm_1', 'mr_0000000001'),
    ).toBe(buildReceiptNudgeDedupKey('tm_1', 'mr_0000000001'));
    expect(
      buildTriggerDedupKey(TRIGGER_KIND.RECEIPT_NUDGE, 'tm_1', 'mr_0000000001'),
    ).toBe('receipt_nudge:tm_1:mr_0000000001');
    expect(
      buildTriggerDedupKey(
        TRIGGER_KIND.REVIEW_ROUND_TIMEOUT,
        'is_1',
        3,
      ),
    ).toBe(buildReviewRoundTimeoutDedupKey('is_1', 3));
    expect(
      buildTriggerDedupKey(
        TRIGGER_KIND.REVIEW_ROUND_TIMEOUT,
        'is_1',
        3,
      ),
    ).toBe('review_round_timeout:is_1:3');
  });

  it('source 派生：四系统 kind→system，两 hook kind→agent，未知→system', () => {
    expect(triggerSourceOf(TRIGGER_KIND.RECEIPT_NUDGE)).toBe('system');
    expect(triggerSourceOf(TRIGGER_KIND.REVIEW_ROUND_TIMEOUT)).toBe('system');
    expect(triggerSourceOf(TRIGGER_KIND.PROGRESSION_PATROL)).toBe('system');
    expect(triggerSourceOf(TRIGGER_KIND.SESSION_IDLE_SCAN)).toBe('system');
    expect(triggerSourceOf(TRIGGER_KIND.HOOK_FIRE)).toBe('agent');
    expect(triggerSourceOf(TRIGGER_KIND.HOOK_POLL)).toBe('agent');
    expect(triggerSourceOf('test_kind')).toBe('system');
  });
});
