import {
  EVENT_TYPES,
  MESSAGE_STATUS,
  CHANNEL_TYPE,
  SENDER_TYPE,
  SESSION_STATUS,
  ACTOR_TYPE,
} from './event.constants';
import { PLAN_LIFECYCLE_STATUS } from '../../tasks/plan-lifecycle.service';

describe('event.constants（Phase 2 事件与消息契约，09 篇 §4.2 / 10 篇；Phase 4 worker 回流扩展，T1）', () => {
  it('EVENT_TYPES 含 31 个事件，事件名一律点号分隔（无下划线变体）', () => {
    expect(EVENT_TYPES.CHAT_MESSAGE_NEW).toBe('chat.message.new');
    expect(EVENT_TYPES.AGENT_LOADING).toBe('agent.loading');
    expect(EVENT_TYPES.AGENT_ERROR).toBe('agent.error');
    expect(EVENT_TYPES.TASK_STATUS_CHANGED).toBe('task.status.changed');
    expect(EVENT_TYPES.TEAM_CHANGED).toBe('team.changed');
    expect(EVENT_TYPES.TEAM_CREATED).toBe('team.created');
    expect(EVENT_TYPES.TEAM_UPDATED).toBe('team.updated');
    expect(EVENT_TYPES.TEAM_DELETED).toBe('team.deleted');
    expect(EVENT_TYPES.TEAM_QUEUE_CHANGED).toBe('team.queue.changed');
    expect(EVENT_TYPES.ARTIFACT_SUBMITTED).toBe('artifact.submitted');
    expect(EVENT_TYPES.ISSUE_CHANGED).toBe('issue.changed');
    expect(EVENT_TYPES.SESSION_UPDATED).toBe('session.updated');
    expect(EVENT_TYPES.MESSAGE_PART_DELTA).toBe('message.part.delta');
    expect(EVENT_TYPES.TASK_COMPLETED).toBe('task.completed');
    expect(EVENT_TYPES.AGENT_STATUS).toBe('agent.status');
    expect(EVENT_TYPES.WORKER_HEARTBEAT).toBe('worker.heartbeat');
    expect(EVENT_TYPES.AGENT_QUESTION).toBe('agent.question');
    // plan-review-execution-gates Todo 5：回执/轮次/计划事件（走 team:/channel: 订阅）
    expect(EVENT_TYPES.RECEIPT_ACKED).toBe('receipt.acked');
    expect(EVENT_TYPES.RECEIPT_EXPIRED).toBe('receipt.expired');
    expect(EVENT_TYPES.ROUND_COMPLETE).toBe('round.complete');
    expect(EVENT_TYPES.ROUND_STALE).toBe('round.stale');
    expect(EVENT_TYPES.PLAN_STATUS_DRAFT).toBe('plan.status.draft');
    expect(EVENT_TYPES.PLAN_STATUS_REVIEWING).toBe('plan.status.reviewing');
    expect(EVENT_TYPES.PLAN_STATUS_PENDING_FINAL).toBe(
      'plan.status.pending_final',
    );
    expect(EVENT_TYPES.PLAN_STATUS_APPROVED).toBe('plan.status.approved');
    expect(EVENT_TYPES.PLAN_STATUS_REJECTED).toBe('plan.status.rejected');
    expect(EVENT_TYPES.PLAN_STATUS_EXECUTING).toBe('plan.status.executing');
    expect(EVENT_TYPES.PLAN_STATUS_COMPLETED).toBe('plan.status.completed');
    // trigger-unification todo-20：trigger 生命周期可观测事件（HookService 发射）
    expect(EVENT_TYPES.TRIGGER_FIRED).toBe('trigger.fired');
    expect(EVENT_TYPES.TRIGGER_EXPIRED).toBe('trigger.expired');
    expect(EVENT_TYPES.TRIGGER_SKIPPED).toBe('trigger.skipped');
    expect(Object.values(EVENT_TYPES)).toHaveLength(31);
    for (const name of Object.values(EVENT_TYPES)) {
      // plan.status.* 后缀逐字取自 PLAN_LIFECYCLE_STATUS（含 pending_final 的下划线），
      // 由下一单测 1:1 锁定；此处仅对其余事件断言无下划线变体
      if (!name.startsWith('plan.status.')) {
        expect(name.includes('_')).toBe(false);
      }
      // 点号命名：除 global 外一律含点号分隔（无驼峰/下划线变体）
      expect(name.includes('.')).toBe(true);
    }
  });

  it('plan.status.* 后缀与 PLAN_LIFECYCLE_STATUS 七态一一对应', () => {
    const planEvents = Object.values(EVENT_TYPES).filter((n) =>
      n.startsWith('plan.status.'),
    );
    expect(planEvents).toHaveLength(
      Object.values(PLAN_LIFECYCLE_STATUS).length,
    );
    for (const status of Object.values(PLAN_LIFECYCLE_STATUS)) {
      expect(planEvents).toContain(`plan.status.${status}`);
    }
  });

  it('MESSAGE_STATUS 六态', () => {
    expect(MESSAGE_STATUS).toEqual({
      sending: 'sending',
      sent: 'sent',
      pending: 'pending',
      processing: 'processing',
      completed: 'completed',
      failed: 'failed',
    });
  });

  it('CHANNEL_TYPE 两类频道', () => {
    expect(CHANNEL_TYPE).toEqual({
      team_group: 'team_group',
      private: 'private',
    });
  });

  it('SENDER_TYPE 四类发送方', () => {
    expect(SENDER_TYPE).toEqual({
      user: 'user',
      agent: 'agent',
      system: 'system',
      external: 'external',
    });
  });

  it('SESSION_STATUS 七态', () => {
    expect(SESSION_STATUS).toEqual({
      created: 'created',
      active: 'active',
      running: 'running',
      idle: 'idle',
      frozen: 'frozen',
      archived: 'archived',
      failed: 'failed',
    });
  });

  it('ACTOR_TYPE 三类操作者（user/system/agent，agent 供 MCP/issue_activities 操作记录）', () => {
    expect(ACTOR_TYPE).toEqual({
      user: 'user',
      system: 'system',
      agent: 'agent',
    });
  });
});
