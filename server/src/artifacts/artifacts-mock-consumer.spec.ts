import { EVENT_TYPES } from '../common/constants/event.constants';
import {
  ArtifactsMockConsumer,
  ARTIFACT_DELAY_MS,
  ARTIFACT_DELAY_RANGE_MS,
} from './artifacts-mock-consumer';

describe('ArtifactsMockConsumer', () => {
  let prisma: Record<string, unknown>;
  let idGen: Record<string, unknown>;
  let realtime: { broadcast: jest.Mock };

  const taskId = 't_0000000001';

  /** 直接实例化（不走 Nest DI）：延迟字段实例化后覆盖（默认 0 = 立即执行，便于断言时序）。 */
  const createConsumer = (delayMs = 0, delayRangeMs = 0) => {
    const c = new ArtifactsMockConsumer(
      prisma as any,
      idGen as any,
      realtime as any,
    );
    c.delayMs = delayMs;
    c.delayRangeMs = delayRangeMs;
    return c;
  };

  beforeEach(() => {
    prisma = {};
    idGen = {};
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_0000000001' }) };
  });

  it('广播 artifact.submitted：payload 含 taskId/type/title/content/fileRef，scope=task', async () => {
    const c = createConsumer();

    const event = await c.simulateSubmission(taskId, {
      type: 'design-doc',
      title: '需求文档 v1',
      content: '# 需求',
    });

    expect(realtime.broadcast).toHaveBeenCalledWith(
      EVENT_TYPES.ARTIFACT_SUBMITTED,
      {
        taskId,
        type: 'design-doc',
        title: '需求文档 v1',
        content: '# 需求',
        fileRef: `mock://${taskId}/1`,
      },
      { type: 'task', id: taskId },
    );
    expect(event).toEqual({ id: 'ev_0000000001' });
  });

  it('fileRef 缺省生成 mock://<taskId>/<seq> 递增，显式传入则原样透传', async () => {
    const c = createConsumer();
    await c.simulateSubmission(taskId, { type: 'code', title: 'x', content: 'c' });
    await c.simulateSubmission(taskId, { type: 'code', title: 'x', content: 'c' });
    await c.simulateSubmission(taskId, {
      type: 'code',
      title: 'x',
      content: 'c',
      fileRef: 's3://bucket/a.md',
    });

    const payloads = realtime.broadcast.mock.calls.map((call) => call[1]);
    expect(payloads[0].fileRef).toBe(`mock://${taskId}/1`);
    expect(payloads[1].fileRef).toBe(`mock://${taskId}/2`);
    expect(payloads[2].fileRef).toBe('s3://bucket/a.md');
  });

  it('延迟未到不广播，到点后广播（fake timers + Math.random spy）', async () => {
    jest.useFakeTimers();
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    // 200 + 0.5 * 300 = 350ms
    const c = createConsumer(ARTIFACT_DELAY_MS, ARTIFACT_DELAY_RANGE_MS);

    const promise = c.simulateSubmission(taskId, {
      type: 'design-doc',
      title: 'x',
      content: 'c',
    });
    // 延迟未到：无广播
    await jest.advanceTimersByTimeAsync(349);
    expect(realtime.broadcast).not.toHaveBeenCalled();

    // 到点（350ms）：广播完成
    await jest.advanceTimersByTimeAsync(1);
    await promise;
    expect(realtime.broadcast).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
    jest.useRealTimers();
  });

  it('不落库：构造注入 prisma/idGen，simulateSubmission 仅调用 broadcast', async () => {
    const artifactCreate = jest.fn();
    prisma.artifact = { create: artifactCreate };
    const c = createConsumer();

    await c.simulateSubmission(taskId, {
      type: 'design-doc',
      title: 'x',
      content: 'c',
    });

    expect(realtime.broadcast).toHaveBeenCalledTimes(1);
    expect(artifactCreate).not.toHaveBeenCalled();
  });
});
