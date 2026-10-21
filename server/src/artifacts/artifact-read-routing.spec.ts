/**
 * 产出物「按 id 读取」的路由回归测试（缺陷 1）。
 *
 * 测的是 **agent 真正走的那条链**：`read_file`（平台 MCP 工具）→ 产出物库 / worker
 * 工作区。本文件刻意**不放在 `src/platform-mcp/` 下**（该目录本轮不改）——被测对象是
 * 「产出物按 id 读取的路由与错误语义」，归属产出物域，故放 `src/artifacts/`。
 *
 * 三条口径（缺一不可）：
 * 1. **text 类产出物按 id 读得到正文**（正文在平台产出物库里，从来没有工作区文件）；
 * 2. **不存在的 id → 「找不到」**（不是「worker 不可用」）；
 * 3. **worker 真不可达 → 仍是「worker 不可用」**（两者必须可区分）。
 */

import { PlatformMcpService } from '../platform-mcp/platform-mcp.service';
import {
  WorkerClient,
  WorkerFileNotFoundException,
  WorkerUnavailableException,
} from '../workers/worker.client';

const taskId = 't_1';
const workerId = 'w_1';
const ctx = { workerId } as never;

describe('产出物按 id 读取的路由与错误语义（缺陷 1）', () => {
  let service: PlatformMcpService;
  let prisma: {
    task: { findUnique: jest.Mock };
    session: { findFirst: jest.Mock };
    artifact: { findUnique: jest.Mock };
    artifactVersion: { findFirst: jest.Mock; findMany: jest.Mock };
    worker: { findUnique: jest.Mock };
  };
  let workerClient: { fetchFile: jest.Mock };

  beforeEach(() => {
    prisma = {
      task: {
        findUnique: jest.fn().mockResolvedValue({ teamId: 'tm_1' }),
      },
      session: {
        findFirst: jest.fn().mockResolvedValue({
          id: 's_1',
          agentId: 'a_1',
          teamMemberId: 'tm_1',
        }),
      },
      artifact: { findUnique: jest.fn().mockResolvedValue(null) },
      artifactVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      worker: {
        findUnique: jest.fn().mockResolvedValue({ capabilities: {} }),
      },
    };
    workerClient = { fetchFile: jest.fn() };
    service = new PlatformMcpService(
      prisma as never,
      { nextId: jest.fn() } as never,
      { broadcast: jest.fn(), emit: jest.fn() } as never,
      workerClient as unknown as WorkerClient,
      { isAgentExecuting: jest.fn() } as never,
      { append: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('text 类产出物按 id 读 → 直接返回正文（正文在平台产出物库里，不在工作区）', async () => {
    const body = '# 产出物正文\n\n第一段内容。\n';
    prisma.artifactVersion.findFirst.mockResolvedValue({ contentRef: body });
    prisma.artifact.findUnique.mockResolvedValue({ taskId });

    const result = await service.readFile(ctx, {
      taskId,
      fileRef: 'art_0000000001',
    });

    expect(result.content).toBe(body);
    expect(result.source).toBe('archive');
    expect(workerClient.fetchFile).not.toHaveBeenCalled();
  });

  it('不存在的产出物 id → 「找不到」错误（**不是**「worker 不可用」）', async () => {
    prisma.artifactVersion.findFirst.mockResolvedValue(null);
    prisma.artifact.findUnique.mockResolvedValue(null);
    workerClient.fetchFile.mockRejectedValue(
      new WorkerFileNotFoundException(
        workerId,
        'art_0000000009（文件不存在: art_0000000009）',
      ),
    );

    const err = await service
      .readFile(ctx, { taskId, fileRef: 'art_0000000009' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkerFileNotFoundException);
    expect((err as WorkerUnavailableException).message).not.toContain('不可用');
  });

  it('worker 真不可达 → 仍是「worker 不可用」（与「找不到」区分开）', async () => {
    prisma.artifactVersion.findFirst.mockResolvedValue(null);
    prisma.artifact.findUnique.mockResolvedValue(null);
    workerClient.fetchFile.mockRejectedValue(
      new WorkerUnavailableException(workerId, 'file fetch HTTP 500'),
    );

    const err = await service
      .readFile(ctx, { taskId, fileRef: 'art_0000000009' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkerUnavailableException);
    expect(err).not.toBeInstanceOf(WorkerFileNotFoundException);
    expect((err as WorkerUnavailableException).message).toContain('不可用');
  });
});
