import { ConflictException, NotFoundException } from '@nestjs/common';
import { TasksService } from './tasks.service';

/**
 * DELETE /api/v1/tasks/:id 的删除契约。
 *
 * 重点锁两件事，任一被后人「顺手简化」都会造成真实数据损坏：
 *  1. chat_channels 只解绑 taskId、不删频道——私聊频道按 [teamId, teamMemberId]
 *     唯一，是团队级长期资源，删掉会连带毁掉该团队全部成员私聊；
 *  2. sessions 先删本团队任务会话、再把其余置空——sessions.team_member_key 是
 *     task_id 为 NULL 时物化的生成列且带唯一键，顺序反了会 P2002。
 */
describe('TasksService.remove（DELETE /api/v1/tasks/:id）', () => {
  type Row = { id: string };

  let taskRow: { id: string; teamId: string | null; status: string } | null;
  let calls: string[];
  let prisma: Record<string, unknown>;
  let service: TasksService;

  const id = 't_0000000001';

  beforeEach(() => {
    calls = [];
    taskRow = { id, teamId: 'tm_0000000001', status: 'pending' };

    const findMany = (name: string, rows: Row[]) => () => {
      calls.push(name);
      return Promise.resolve(rows);
    };
    const del = (name: string) => () => {
      calls.push(name);
      return Promise.resolve({ count: 1 });
    };

    prisma = {
      task: {
        findUnique: () => Promise.resolve(taskRow),
        delete: del('task.delete'),
      },
      taskMessageChannel: { deleteMany: del('taskMessageChannel.deleteMany') },
      taskNotificationChannel: {
        deleteMany: del('taskNotificationChannel.deleteMany'),
      },
      taskEvent: { deleteMany: del('taskEvent.deleteMany') },
      plan: {
        findMany: findMany('plan.findMany', [{ id: 'pl_1' }]),
        deleteMany: del('plan.deleteMany'),
      },
      planTask: { deleteMany: del('planTask.deleteMany') },
      issue: {
        findMany: findMany('issue.findMany', [{ id: 'is_1' }]),
        deleteMany: del('issue.deleteMany'),
      },
      issueActivity: { deleteMany: del('issueActivity.deleteMany') },
      artifact: {
        findMany: findMany('artifact.findMany', [{ id: 'ar_1' }]),
        deleteMany: del('artifact.deleteMany'),
      },
      artifactVersion: { deleteMany: del('artifactVersion.deleteMany') },
      memory: { deleteMany: del('memory.deleteMany') },
      agentQuestion: { deleteMany: del('agentQuestion.deleteMany') },
      message: { deleteMany: del('message.deleteMany') },
      chatChannel: {
        findMany: findMany('chatChannel.findMany', [{ id: 'c_1' }]),
        updateMany: del('chatChannel.updateMany'),
        deleteMany: del('chatChannel.deleteMany'),
      },
      session: {
        deleteMany: del('session.deleteMany'),
        updateMany: del('session.updateMany'),
      },
      taskGroupInstance: { updateMany: del('taskGroupInstance.updateMany') },
      teamQueue: { deleteMany: del('teamQueue.deleteMany') },
      team: { updateMany: del('team.updateMany') },
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };

    service = new TasksService(
      prisma as never,
      { nextId: jest.fn(), seed: jest.fn() } as never,
      { broadcast: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
    taskRow = null;
    await expect(service.remove(id)).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toEqual([]);
  });

  it.each(['in_progress', 'pending_review'])(
    '%s → 409 TASK_DELETE_BLOCKED，且不进入事务',
    async (status) => {
      taskRow = { id, teamId: 'tm_0000000001', status };
      await expect(service.remove(id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(calls).toEqual([]);
    },
  );

  it('可删状态：返回 deleted，删除任务行并清空 teams.currentTaskId', async () => {
    await expect(service.remove(id)).resolves.toEqual({ deleted: true, id });
    expect(calls).toContain('task.delete');
    expect(calls).toContain('team.updateMany');
    // 指针必须先于任务行清理，否则留下指向已删任务的悬空引用
    expect(calls.indexOf('team.updateMany')).toBeLessThan(
      calls.indexOf('task.delete'),
    );
  });

  it('chat_channels 只解绑 taskId，不删频道', async () => {
    await service.remove(id);
    expect(calls).toContain('chatChannel.updateMany');
    expect(calls).not.toContain('chatChannel.deleteMany');
  });

  it('sessions 先删本团队任务会话，再把其余置空（P2002 顺序）', async () => {
    await service.remove(id);
    expect(calls.indexOf('session.deleteMany')).toBeLessThan(
      calls.indexOf('session.updateMany'),
    );
  });

  it('级联顺序：子表先于任务行', async () => {
    await service.remove(id);
    const firstTaskScoped = calls.indexOf('taskMessageChannel.deleteMany');
    expect(firstTaskScoped).toBeGreaterThanOrEqual(0);
    for (const dep of [
      'taskEvent.deleteMany',
      'plan.deleteMany',
      'issue.deleteMany',
      'artifact.deleteMany',
      'memory.deleteMany',
      'agentQuestion.deleteMany',
      'message.deleteMany',
      'teamQueue.deleteMany',
    ]) {
      expect(calls.indexOf(dep)).toBeLessThan(calls.indexOf('task.delete'));
    }
  });
});
