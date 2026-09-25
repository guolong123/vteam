import { TASK_STATUS, TASK_STATUS_ORDER } from './task.constants';
import { ISSUE_STATUS } from '../../issues/issues.constants';

/**
 * 状态词汇回归 guard（tech-debt-remediation Todo 17）。
 * =============================================================
 * server 拥有 web-facing 状态词汇，任何增删改都必须同步 web 侧
 * `web/src/types/task-status.ts` / `web/src/types/issue-status.ts`。
 * 本 spec 用精确相等断言锁死成员与顺序，防止静默漂移。
 */
describe('status-vocabulary guard（TASK_STATUS 7 成员 + ISSUE_STATUS 5 成员，防漂移）', () => {
  it('TASK_STATUS 恰为 7 个文档化成员且顺序固定', () => {
    expect(Object.keys(TASK_STATUS)).toEqual([
      'queued',
      'pending',
      'in_progress',
      'blocked',
      'pending_review',
      'completed',
      'archived',
    ]);
    expect(TASK_STATUS).toEqual({
      queued: 'queued',
      pending: 'pending',
      in_progress: 'in_progress',
      blocked: 'blocked',
      pending_review: 'pending_review',
      completed: 'completed',
      archived: 'archived',
    });
  });

  it('TASK_STATUS_ORDER 与 TASK_STATUS 一致且顺序固定', () => {
    expect([...TASK_STATUS_ORDER]).toEqual([
      'queued',
      'pending',
      'in_progress',
      'blocked',
      'pending_review',
      'completed',
      'archived',
    ]);
    expect([...TASK_STATUS_ORDER]).toEqual(Object.values(TASK_STATUS));
  });

  it('ISSUE_STATUS 恰为 5 个文档化成员', () => {
    expect(Object.keys(ISSUE_STATUS)).toEqual([
      'open',
      'in_progress',
      'resolved',
      'closed',
      'rejected',
    ]);
    expect(ISSUE_STATUS).toEqual({
      open: 'open',
      in_progress: 'in_progress',
      resolved: 'resolved',
      closed: 'closed',
      rejected: 'rejected',
    });
  });
});
