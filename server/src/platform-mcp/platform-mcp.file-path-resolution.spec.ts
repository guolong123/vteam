import { Test, TestingModule } from '@nestjs/testing';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { IdGeneratorService } from '../common/id-generator';
import { GitReposService } from '../git-repos/git-repos.service';
import { IssuesService } from '../issues/issues.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from '../questions/questions.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import { WorkerClient, WorkerUnavailableException } from '../workers/worker.client';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { PlatformMcpService } from './platform-mcp.service';

/**
 * worker 取文件的相对路径解析：agent 传相对 fileRef（如 `docs/x.svg`）时，按
 * 「任务目录 → 根目录」候选依次取；仅 404 换候选，其余失败立即上抛。
 */
describe('PlatformMcpService worker 取文件路径解析', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    worker: { findUnique: jest.Mock };
    artifactVersion: { findFirst: jest.Mock; findMany: jest.Mock };
    artifact: { findUnique: jest.Mock };
  };
  let fetchFile: jest.Mock;

  const taskId = 't_0000000020';
  const workerId = 'w_0000000001';
  const memberId = 'tmm_0000000009';
  const ctx = { workerId };
  const ROOT = '/data/vteam-worker';
  const TASK_DIR = `${ROOT}/tasks/${taskId}`;

  beforeEach(async () => {
    process.env.WORK_DIR = ROOT;
    prisma = {
      session: { findFirst: jest.fn() },
      task: { findUnique: jest.fn().mockResolvedValue({ teamId: 'tm_1' }) },
      worker: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: workerId, capabilities: {} }),
      },
      artifactVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      artifact: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    fetchFile = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
        { provide: WorkerClient, useValue: { fetchFile } },
        {
          provide: WorkerDispatcher,
          useValue: {
            dispatchAgentMention: jest.fn(),
            isAgentExecuting: jest.fn().mockReturnValue(null),
          },
        },
        { provide: ArtifactsService, useValue: {} },
        { provide: IssuesService, useValue: {} },
        { provide: TasksService, useValue: {} },
        { provide: QuestionsService, useValue: {} },
        { provide: GitReposService, useValue: {} },
        { provide: SessionLifecycleService, useValue: {} },
      ],
    }).compile();
    service = module.get(PlatformMcpService);
  });

  afterEach(() => {
    delete process.env.WORK_DIR;
  });

  const allowWorkerAs = (instanceId: string) => {
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: 'a_x',
      teamMemberId: instanceId,
    });
  };

  it('相对 fileRef → 以 <任务目录>/<ref> 取文件（agent CWD 口径）', async () => {
    allowWorkerAs(memberId);
    fetchFile.mockResolvedValue(Buffer.from('svg'));

    await service.readFile(ctx, {
      taskId,
      fileRef: 'docs/pelican-drinking.svg',
    });

    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(fetchFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: workerId }),
      `${TASK_DIR}/docs/pelican-drinking.svg`,
    );
  });

  it('任务目录 404 → 自动换 <根>/<ref> 候选（agent 常写的 tasks/<taskId>/… 形态）', async () => {
    allowWorkerAs(memberId);
    fetchFile
      .mockRejectedValueOnce(new WorkerUnavailableException(workerId, 'file fetch HTTP 404', 404))
      .mockResolvedValueOnce(Buffer.from('svg'));

    await service.readFile(ctx, {
      taskId,
      fileRef: `tasks/${taskId}/docs/pelican-drinking.svg`,
    });

    expect(fetchFile).toHaveBeenCalledTimes(2);
    expect(fetchFile.mock.calls[1][1]).toBe(
      `${ROOT}/tasks/${taskId}/docs/pelican-drinking.svg`,
    );
  });

  it('绝对路径 → 原样取（唯一候选，不追加任务目录前缀）', async () => {
    allowWorkerAs(memberId);
    fetchFile.mockResolvedValue(Buffer.from('svg'));

    await service.readFile(ctx, {
      taskId,
      fileRef: `${TASK_DIR}/docs/pelican-drinking.svg`,
    });

    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(fetchFile.mock.calls[0][1]).toBe(
      `${TASK_DIR}/docs/pelican-drinking.svg`,
    );
  });

  it('非 404 失败（401）→ 立即上抛，不把「worker 不可用」当路径问题重试', async () => {
    allowWorkerAs(memberId);
    fetchFile.mockRejectedValue(
      new WorkerUnavailableException(workerId, 'file fetch HTTP 401', 401),
    );

    await expect(
      service.readFile(ctx, { taskId, fileRef: 'docs/x.svg' }),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_UNAVAILABLE' },
    });
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });
});
