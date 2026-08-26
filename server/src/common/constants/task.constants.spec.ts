import {
  TASK_STATUS,
  TASK_STATUS_ORDER,
  TASK_PRIORITY,
  TASK_TRANSITIONS,
  TASK_ERRORS,
} from './task.constants';

describe('task.constants（任务状态机契约，13 篇 §3）', () => {
  it('五态常量与契约一致', () => {
    expect(TASK_STATUS).toEqual({
      pending: 'pending',
      in_progress: 'in_progress',
      pending_review: 'pending_review',
      completed: 'completed',
      archived: 'archived',
    });
  });

  it('TASK_STATUS_ORDER 覆盖五态且顺序正确', () => {
    expect(TASK_STATUS_ORDER).toEqual([
      'pending',
      'in_progress',
      'pending_review',
      'completed',
      'archived',
    ]);
  });

  it('TASK_PRIORITY 三档', () => {
    expect(TASK_PRIORITY).toEqual({
      high: 'high',
      medium: 'medium',
      low: 'low',
    });
  });

  it('TASK_TRANSITIONS 覆盖 5 个迁移动作且迁移合法', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([
      'accept',
      'archive',
      'mark-pending-review',
      'reject',
      'start',
    ]);
    expect(TASK_TRANSITIONS.start).toEqual({
      from: 'pending',
      to: 'in_progress',
    });
    expect(TASK_TRANSITIONS['mark-pending-review']).toEqual({
      from: 'in_progress',
      to: 'pending_review',
    });
    expect(TASK_TRANSITIONS.accept).toEqual({
      from: 'pending_review',
      to: 'completed',
    });
    expect(TASK_TRANSITIONS.reject).toEqual({
      from: 'pending_review',
      to: 'in_progress',
    });
    expect(TASK_TRANSITIONS.archive).toEqual({
      from: 'completed',
      to: 'archived',
    });
    // 五态闭合：from/to 均为合法状态
    const valid = new Set(TASK_STATUS_ORDER);
    for (const { from, to } of Object.values(TASK_TRANSITIONS)) {
      expect(valid.has(from)).toBe(true);
      expect(valid.has(to)).toBe(true);
    }
  });

  it('TASK_ERRORS 契约（409 错误码）', () => {
    expect(TASK_ERRORS.TASK_INVALID_TRANSITION).toBe('TASK_INVALID_TRANSITION');
  });
});
