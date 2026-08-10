import {
  EVENT_TYPES,
  MESSAGE_STATUS,
  CHANNEL_TYPE,
  SENDER_TYPE,
  SESSION_STATUS,
  ACTOR_TYPE,
} from './event.constants';

describe('event.constants（Phase 2 事件与消息契约，09 篇 §4.2 / 10 篇；Phase 4 worker 回流扩展，T1）', () => {
  it('EVENT_TYPES 含 11 个事件，事件名一律点号分隔（无下划线变体）', () => {
    expect(EVENT_TYPES.CHAT_MESSAGE_NEW).toBe('chat.message.new');
    expect(EVENT_TYPES.AGENT_LOADING).toBe('agent.loading');
    expect(EVENT_TYPES.AGENT_ERROR).toBe('agent.error');
    expect(EVENT_TYPES.TASK_STATUS_CHANGED).toBe('task.status.changed');
    expect(EVENT_TYPES.TEAM_CHANGED).toBe('team.changed');
    expect(EVENT_TYPES.ARTIFACT_SUBMITTED).toBe('artifact.submitted');
    expect(EVENT_TYPES.SESSION_UPDATED).toBe('session.updated');
    expect(EVENT_TYPES.MESSAGE_PART_DELTA).toBe('message.part.delta');
    expect(EVENT_TYPES.TASK_COMPLETED).toBe('task.completed');
    expect(EVENT_TYPES.AGENT_STATUS).toBe('agent.status');
    expect(EVENT_TYPES.WORKER_HEARTBEAT).toBe('worker.heartbeat');
    expect(Object.values(EVENT_TYPES)).toHaveLength(11);
    for (const name of Object.values(EVENT_TYPES)) {
      expect(name.includes('_')).toBe(false);
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
    expect(CHANNEL_TYPE).toEqual({ task_group: 'task_group', private: 'private' });
  });

  it('SENDER_TYPE 三类发送方', () => {
    expect(SENDER_TYPE).toEqual({ user: 'user', agent: 'agent', system: 'system' });
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

  it('ACTOR_TYPE 两类操作者', () => {
    expect(ACTOR_TYPE).toEqual({ user: 'user', system: 'system' });
  });
});
