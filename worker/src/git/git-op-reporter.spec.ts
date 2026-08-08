import { EventSender } from '../client/event-client';
import { ServeMessage } from '../driver/v1-driver';
import {
  GitOpRecord,
  GitOpReporter,
  extractGitOps,
} from './git-op-reporter';

/** 构造一条含 tool part 的 serve message。 */
function toolMessage(part: Record<string, unknown>): ServeMessage {
  return {
    info: { id: 'msg_1', role: 'assistant' },
    parts: [part as ServeMessage['parts'][number]],
  };
}

const COMPLETED_CLONE = toolMessage({
  id: 'p_1',
  type: 'tool',
  callID: 'call_1',
  tool: 'git_clone',
  state: {
    status: 'completed',
    input: { repo_url: 'git@gitee.com:xishuhq/ketaops.git', target: 'ketaops' },
    output: 'Cloned.',
    time: { start: 1000, end: 2000 },
  },
});

describe('extractGitOps（从 serve messages 提取 git 终态记录）', () => {
  it('completed 工具 part → action/repoUrl/exit=0/时间戳', () => {
    const records = extractGitOps([COMPLETED_CLONE]);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      callID: 'call_1',
      action: 'git_clone',
      repoUrl: 'git@gitee.com:xishuhq/ketaops.git',
      exit: 0,
      startedAt: 1000,
      endedAt: 2000,
    });
  });

  it('error 工具 part → exit=1 + error 消息', () => {
    const records = extractGitOps([
      toolMessage({
        id: 'p_2',
        type: 'tool',
        callID: 'call_2',
        tool: 'git_push',
        state: {
          status: 'error',
          input: { repo_url: 'origin', refspec: 'main:main' },
          error: 'git push failed (exit 1): rejected',
          time: { start: 100, end: 300 },
        },
      }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      callID: 'call_2',
      action: 'git_push',
      repoUrl: 'origin',
      exit: 1,
      error: 'git push failed (exit 1): rejected',
    });
  });

  it('error 消息含 exit N → 提取真实退出码（非固定 1）', () => {
    const records = extractGitOps([
      toolMessage({
        id: 'p_3',
        type: 'tool',
        callID: 'call_3',
        tool: 'git_clone',
        state: {
          status: 'error',
          input: { repo_url: 'git@host:org/repo.git' },
          error: 'git clone failed (exit 128): fatal: could not read Username',
        },
      }),
    ]);
    expect(records[0]?.exit).toBe(128);
  });

  it('非 git_ 前缀工具（bash/task 等）不提取', () => {
    const records = extractGitOps([
      toolMessage({
        id: 'p_4',
        type: 'tool',
        callID: 'call_4',
        tool: 'bash',
        state: { status: 'completed', input: {}, output: 'ok' },
      }),
    ]);
    expect(records).toHaveLength(0);
  });

  it('中间态（pending/running）跳过，只取终态', () => {
    const records = extractGitOps([
      toolMessage({
        id: 'p_5',
        type: 'tool',
        callID: 'call_5',
        tool: 'git_fetch',
        state: { status: 'running', input: {} },
      }),
      toolMessage({
        id: 'p_6',
        type: 'tool',
        callID: 'call_6',
        tool: 'git_status',
        state: { status: 'pending', input: {} },
      }),
    ]);
    expect(records).toHaveLength(0);
  });

  it('input 无 repo_url 时 repoUrl 缺省（status/pull 等本地操作）', () => {
    const records = extractGitOps([
      toolMessage({
        id: 'p_7',
        type: 'tool',
        callID: 'call_7',
        tool: 'git_status',
        state: {
          status: 'completed',
          input: { porcelain: true },
          output: ' M file.ts',
        },
      }),
    ]);
    expect(records[0]).toMatchObject({
      action: 'git_status',
      exit: 0,
    });
    expect(records[0]).not.toHaveProperty('repoUrl');
  });
});

describe('GitOpReporter（轮询扫描 → git.op 上报）', () => {
  function createSender(): {
    sender: EventSender;
    sent: Array<{ type: string; payload: Record<string, unknown> }>;
  } {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const fetchImpl = (async () => {
      return { ok: true, status: 202, statusText: 'Accepted' } as Response;
    }) as typeof fetch;
    const sender = new EventSender({
      serverUrl: 'http://server:3000',
      workerId: 'w_test',
      workerToken: 'tok',
      startSeq: 0,
      bootId: 'boot',
      fetchImpl,
      maxRetries: 0,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const rawSend = sender.send.bind(sender);
    sender.send = (async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return rawSend(type as never, payload);
    }) as EventSender['send'];
    return { sender, sent };
  }

  it('scan 上报 git.op 事件（payload 含 taskId/agentId/action/repo_url/exit）', async () => {
    const { sender, sent } = createSender();
    const reporter = new GitOpReporter({
      taskId: 't_1',
      agentId: 'a_1',
      sessionId: 's_1',
      sender,
    });

    await reporter.scan([COMPLETED_CLONE]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'git.op',
      payload: {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 's_1',
        action: 'git_clone',
        repo_url: 'git@gitee.com:xishuhq/ketaops.git',
        exit: 0,
      },
    });
  });

  it('同 callID 重复轮询只上报一次（按 callID 去重）', async () => {
    const { sender, sent } = createSender();
    const reporter = new GitOpReporter({
      taskId: 't_1',
      sender,
    });

    await reporter.scan([COMPLETED_CLONE]);
    await reporter.scan([COMPLETED_CLONE]);
    await reporter.scan([COMPLETED_CLONE]);

    expect(sent).toHaveLength(1);
  });

  it('多轮不同 callID 均上报（不同工具/多次调用）', async () => {
    const { sender, sent } = createSender();
    const reporter = new GitOpReporter({ taskId: 't_1', sender });

    await reporter.scan([COMPLETED_CLONE]);
    await reporter.scan([
      toolMessage({
        id: 'p_8',
        type: 'tool',
        callID: 'call_8',
        tool: 'git_push',
        state: {
          status: 'error',
          input: { repo_url: 'origin', refspec: 'main:main' },
          error: 'git push failed (exit 1)',
        },
      }),
    ]);

    expect(sent).toHaveLength(2);
    expect(sent[1].payload).toMatchObject({
      action: 'git_push',
      exit: 1,
    });
  });
});
