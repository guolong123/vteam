import { EVENT_TYPES } from '../common/constants/event.constants';
import { PLAN_LIFECYCLE_STATUS } from '../tasks/plan-lifecycle.service';
import {
  EVENT_SUBSCRIBERS,
  RECEIPT_ROUND_PLAN_EVENTS,
} from './realtime-subscriptions';

describe('realtime-subscriptions（plan-review-execution-gates Todo 5）', () => {
  it('回执/轮次/计划事件清单与 EVENT_TYPES 实际展开一致（receipt×2 + round×2 + plan.status×N）', () => {
    const expected = [
      EVENT_TYPES.RECEIPT_ACKED,
      EVENT_TYPES.RECEIPT_EXPIRED,
      EVENT_TYPES.ROUND_COMPLETE,
      EVENT_TYPES.ROUND_STALE,
      ...Object.values(PLAN_LIFECYCLE_STATUS).map((s) => `plan.status.${s}`),
    ];
    expect([...RECEIPT_ROUND_PLAN_EVENTS].sort()).toEqual([...expected].sort());
  });

  it.each([...RECEIPT_ROUND_PLAN_EVENTS])(
    '事件 %s 有订阅者清单：含会话页 + 看板页（缺席即红）',
    (event) => {
      const subscribers = EVENT_SUBSCRIBERS[event];
      expect(subscribers).toBeDefined();
      expect(subscribers).toContain('session');
      expect(subscribers).toContain('board');
    },
  );

  it('订阅者清单仅 session/board 两页（不新增分析页）', () => {
    for (const event of RECEIPT_ROUND_PLAN_EVENTS) {
      expect([...EVENT_SUBSCRIBERS[event]].sort()).toEqual([
        'board',
        'session',
      ]);
    }
  });
});
