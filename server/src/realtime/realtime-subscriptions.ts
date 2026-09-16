import { EVENT_TYPES } from '../common/constants/event.constants';
import { PLAN_LIFECYCLE_STATUS } from '../tasks/plan-lifecycle.service';

export type EventSubscriberPage = 'session' | 'board';

export const RECEIPT_ROUND_PLAN_EVENTS: readonly string[] = [
  EVENT_TYPES.RECEIPT_ACKED,
  EVENT_TYPES.RECEIPT_EXPIRED,
  EVENT_TYPES.ROUND_COMPLETE,
  EVENT_TYPES.ROUND_STALE,
  ...Object.values(PLAN_LIFECYCLE_STATUS).map(
    (s) => `plan.status.${s}`,
  ),
];

export const EVENT_SUBSCRIBERS: Record<string, EventSubscriberPage[]> = Object.fromEntries(
  RECEIPT_ROUND_PLAN_EVENTS.map((event) => [event, ['session', 'board']]),
);
