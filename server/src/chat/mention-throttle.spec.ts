import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  containsTeamWideMention,
  DEFAULT_PAIR_MAX,
  DEFAULT_PAIR_WINDOW_MS,
  DEFAULT_TASK_BUDGET_MAX,
  DEFAULT_TASK_WINDOW_MS,
  isThrottleExemptKind,
  MentionThrottle,
  pairKeyOf,
} from './mention-throttle';

describe('MentionThrottle（agent @ storm 硬节流，纯/确定性/注入时钟）', () => {
  it('同一无序对窗口内最多 3 次（第 4 次 pair_limit；反向同配额）', () => {
    const t = new MentionThrottle();
    const base = { taskId: 't_1', fromInstanceId: 'tmm_a', toInstanceId: 'tmm_b' };
    expect(t.shouldDispatch({ ...base, now: 1000 })).toEqual({ allow: true });
    expect(t.shouldDispatch({ ...base, now: 2000 })).toEqual({ allow: true });
    expect(t.shouldDispatch({ ...base, now: 3000 })).toEqual({ allow: true });
    // 第 4 次拒绝
    expect(t.shouldDispatch({ ...base, now: 4000 })).toEqual({
      allow: false,
      reason: 'pair_limit',
    });
    // 反向（B→A）共用同一无序对配额 → 同样拒绝
    expect(
      t.shouldDispatch({
        taskId: 't_1',
        fromInstanceId: 'tmm_b',
        toInstanceId: 'tmm_a',
        now: 5000,
      }),
    ).toEqual({ allow: false, reason: 'pair_limit' });
  });

  it('窗口滑过后配额恢复（60s 窗口）', () => {
    const t = new MentionThrottle();
    const base = { taskId: 't_1', fromInstanceId: 'tmm_a', toInstanceId: 'tmm_b' };
    t.shouldDispatch({ ...base, now: 0 });
    t.shouldDispatch({ ...base, now: 1000 });
    t.shouldDispatch({ ...base, now: 2000 });
    // 61s 后首条滑出窗口 → 允许
    expect(t.shouldDispatch({ ...base, now: 61_000 })).toEqual({ allow: true });
  });

  it('单任务全局预算 20/120s：21 个不同对的第 21 次 task_budget', () => {
    const t = new MentionThrottle();
    for (let i = 0; i < 20; i++) {
      const d = t.shouldDispatch({
        taskId: 't_1',
        fromInstanceId: `tmm_from_${i}`,
        toInstanceId: `tmm_to_${i}`,
        now: 1000 + i,
      });
      expect(d).toEqual({ allow: true });
    }
    expect(
      t.shouldDispatch({
        taskId: 't_1',
        fromInstanceId: 'tmm_x',
        toInstanceId: 'tmm_y',
        now: 2000,
      }),
    ).toEqual({ allow: false, reason: 'task_budget' });
  });

  it('任务预算按 taskId 隔离（t_2 不受 t_1 配额影响）', () => {
    const t = new MentionThrottle({ taskBudgetMax: 1 });
    expect(
      t.shouldDispatch({
        taskId: 't_1',
        fromInstanceId: 'a',
        toInstanceId: 'b',
        now: 1000,
      }),
    ).toEqual({ allow: true });
    expect(
      t.shouldDispatch({
        taskId: 't_2',
        fromInstanceId: 'a',
        toInstanceId: 'b',
        now: 1000,
      }),
    ).toEqual({ allow: true });
  });

  it('@all 抑制：agent 内容含 @all/@全体等 → 调用方须按 display-only 处理', () => {
    expect(containsTeamWideMention('@all 请大家看一下')).toBe(true);
    expect(containsTeamWideMention('同步 @全体成员')).toBe(true);
    expect(containsTeamWideMention('@所有人 注意')).toBe(true);
    expect(containsTeamWideMention('@here check')).toBe(true);
    expect(containsTeamWideMention('@开发者-1 请处理')).toBe(false);
    expect(containsTeamWideMention('普通消息无提及')).toBe(false);
    expect(containsTeamWideMention(null)).toBe(false);
    expect(containsTeamWideMention('all without at')).toBe(false);
  });

  it('pairKeyOf 无序（A|B == B|A）', () => {
    expect(pairKeyOf('tmm_a', 'tmm_b')).toBe(pairKeyOf('tmm_b', 'tmm_a'));
  });

  it('用户路径不受影响：chat.service 不得引用 mention-throttle（仅 MCP 路径咨询节流）', () => {    const chatServiceSrc = fs.readFileSync(
      path.join(__dirname, 'chat.service.ts'),
      'utf8',
    );
    expect(chatServiceSrc).not.toContain('mention-throttle');
    expect(chatServiceSrc).not.toContain('MentionThrottle');
    const mcpServiceSrc = fs.readFileSync(
      path.join(__dirname, '..', 'platform-mcp', 'platform-mcp.service.ts'),
      'utf8',
    );
    expect(mcpServiceSrc).toContain('mention-throttle');
  });

  it('预算常量字节一致（Todo 5 不改配额/窗口：pair 3/60s + task 20/120s）', () => {
    expect(DEFAULT_PAIR_MAX).toBe(3);
    expect(DEFAULT_PAIR_WINDOW_MS).toBe(60_000);
    expect(DEFAULT_TASK_BUDGET_MAX).toBe(20);
    expect(DEFAULT_TASK_WINDOW_MS).toBe(120_000);
    const src = fs.readFileSync(
      path.join(__dirname, 'mention-throttle.ts'),
      'utf8',
    );
    const budgetLines = src
      .split('\n')
      .filter((l) => l.startsWith('export const DEFAULT_'));
    expect(budgetLines).toEqual([
      'export const DEFAULT_PAIR_MAX = 3;',
      'export const DEFAULT_PAIR_WINDOW_MS = 60_000;',
      'export const DEFAULT_TASK_BUDGET_MAX = 20;',
      'export const DEFAULT_TASK_WINDOW_MS = 120_000;',
    ]);
  });

  it('内部 wake/round-notify 豁免节流（外部派发才计 pair/task 预算）', () => {
    expect(isThrottleExemptKind('wake')).toBe(true);
    expect(isThrottleExemptKind('round-notify')).toBe(true);
    expect(isThrottleExemptKind('execution')).toBe(false);
    expect(isThrottleExemptKind('review')).toBe(false);
    expect(isThrottleExemptKind('nudge')).toBe(false);
    expect(isThrottleExemptKind(undefined)).toBe(false);
    expect(isThrottleExemptKind(null)).toBe(false);
    expect(isThrottleExemptKind('')).toBe(false);
  });

  it('突发豁免回归：3 评审外部派发占满 pair 预算后，wake + round-notify 仍零丢失', () => {
    const t = new MentionThrottle();
    const pair = {
      taskId: 't_1',
      fromInstanceId: 'tmm_pm',
      toInstanceId: 'tmm_arch',
    };
    for (const now of [1000, 2000, 3000]) {
      expect(t.shouldDispatch({ ...pair, now })).toEqual({ allow: true });
    }
    expect(t.shouldDispatch({ ...pair, now: 4000 })).toEqual({
      allow: false,
      reason: 'pair_limit',
    });
    expect(isThrottleExemptKind('wake')).toBe(true);
    expect(isThrottleExemptKind('round-notify')).toBe(true);
  });
});
