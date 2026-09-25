import { Test, TestingModule } from '@nestjs/testing';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { FileStorageService } from '../uploads/uploads.service';
import { WorkerClient } from '../workers/worker.client';
import { PlanArchiveService } from './plan-archive.service';
import { PlanDocsService } from './plan-docs.service';

describe('PlanArchiveService', () => {
  let service: PlanArchiveService;
  let planDocs: {
    taskDirectory: jest.Mock;
    locateWorkerForTask: jest.Mock;
  };
  let workerClient: { listPlanFiles: jest.Mock; fetchFile: jest.Mock };
  let artifactsService: { archiveFile: jest.Mock };

  const taskId = 't_0000000001';
  const directory = '/data/vteam-worker/agent/tasks/t_0000000001';
  const worker = { id: 'w_0000000001', capabilities: {} };

  const planFile = (overrides: Record<string, unknown> = {}) => ({
    name: 'plan.md',
    updatedAt: '2026-09-22T00:00:00.000Z',
    size: 10,
    content: '# plan',
    truncated: false,
    ...overrides,
  });

  beforeEach(async () => {
    planDocs = {
      taskDirectory: jest.fn().mockReturnValue(directory),
      locateWorkerForTask: jest.fn().mockResolvedValue({ worker }),
    };
    workerClient = {
      listPlanFiles: jest.fn().mockResolvedValue([]),
      fetchFile: jest.fn(),
    };
    artifactsService = { archiveFile: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanArchiveService,
        { provide: PlanDocsService, useValue: planDocs },
        { provide: WorkerClient, useValue: workerClient },
        { provide: ArtifactsService, useValue: artifactsService },
      ],
    }).compile();

    service = module.get<PlanArchiveService>(PlanArchiveService);

    jest
      .spyOn(FileStorageService, 'saveTextFile')
      .mockImplementation(async (content: string, originalName: string) => ({
        url: `/uploads/${originalName}`,
        name: originalName,
        size: Buffer.byteLength(content, 'utf8'),
        ext: 'md',
      }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('happy：三处目录各 1 个 .md → archiveFile 调用 3 次、每次带 category:计划、返回 archived:3', async () => {
    workerClient.listPlanFiles.mockResolvedValue([
      planFile({ name: 'impl-plan.md', content: '# impl' }),
      planFile({ name: 'design.md', content: '# design' }),
      planFile({ name: 'draft.md', content: '# draft' }),
    ]);
    artifactsService.archiveFile.mockImplementation(
      async (_taskId: string, _args: unknown) => ({
        artifactId: 'art_0000000001',
        version: 1,
        status: 'created',
      }),
    );

    const result = await service.scanAndArchivePlanDocs(taskId);

    expect(result).toEqual({ archived: 3, skipped: 0, failed: 0 });
    expect(artifactsService.archiveFile).toHaveBeenCalledTimes(3);
    for (const call of artifactsService.archiveFile.mock.calls) {
      expect(call[0]).toBe(taskId);
      expect(call[1]).toMatchObject({ category: '计划' });
      expect(call[1].title).toBeTruthy();
      expect(call[1].sha256).toBeTruthy();
    }
    // 定位/列表与读路径共用同一套入口
    expect(planDocs.taskDirectory).toHaveBeenCalledWith(taskId);
    expect(planDocs.locateWorkerForTask).toHaveBeenCalledWith(taskId);
    expect(workerClient.listPlanFiles).toHaveBeenCalledWith(worker, directory);
  });

  it('happy-truncated：truncated 文件经 fetchFile 取原文后归档', async () => {
    const full = '# full plan content';
    workerClient.listPlanFiles.mockResolvedValue([
      planFile({ name: 'big.md', content: '# part', truncated: true }),
    ]);
    workerClient.fetchFile.mockResolvedValue(Buffer.from(full, 'utf8'));
    artifactsService.archiveFile.mockResolvedValue({
      artifactId: 'art_0000000001',
      version: 1,
      status: 'created',
    });

    const result = await service.scanAndArchivePlanDocs(taskId);

    expect(result).toEqual({ archived: 1, skipped: 0, failed: 0 });
    expect(workerClient.fetchFile).toHaveBeenCalledWith(
      worker,
      `${directory}/big.md`,
    );
    const savedContent = (FileStorageService.saveTextFile as jest.Mock).mock
      .calls[0][0];
    expect(savedContent).toBe(full);
  });

  it('failure ①：同一内容重复调用 → duplicate 计 skipped、版本不涨', async () => {
    workerClient.listPlanFiles.mockResolvedValue([
      planFile({ name: 'plan.md', content: '# same' }),
    ]);
    artifactsService.archiveFile.mockResolvedValue({
      artifactId: 'art_0000000001',
      version: 1,
      status: 'duplicate',
    });

    const first = await service.scanAndArchivePlanDocs(taskId);
    const second = await service.scanAndArchivePlanDocs(taskId);

    expect(first).toEqual({ archived: 0, skipped: 1, failed: 0 });
    expect(second).toEqual({ archived: 0, skipped: 1, failed: 0 });
    expect(artifactsService.archiveFile).toHaveBeenCalledTimes(2);
  });

  it('failure ②：archiveFile 抛错（验收锁定）→ warn 降级、failed+1、不抛出', async () => {
    workerClient.listPlanFiles.mockResolvedValue([
      planFile({ name: 'a.md', content: '# a' }),
      planFile({ name: 'b.md', content: '# b' }),
    ]);
    artifactsService.archiveFile
      .mockRejectedValueOnce(
        new Error('产出物「a.md」当前版本已验收锁定，不可追加'),
      )
      .mockResolvedValueOnce({
        artifactId: 'art_0000000002',
        version: 1,
        status: 'created',
      });

    const result = await service.scanAndArchivePlanDocs(taskId);

    expect(result).toEqual({ archived: 1, skipped: 0, failed: 1 });
    expect(artifactsService.archiveFile).toHaveBeenCalledTimes(2);
  });

  it('failure ③：定位不到 worker → 返回全 0 且不抛错', async () => {
    planDocs.locateWorkerForTask.mockResolvedValue(null);

    const result = await service.scanAndArchivePlanDocs(taskId);

    expect(result).toEqual({ archived: 0, skipped: 0, failed: 0 });
    expect(workerClient.listPlanFiles).not.toHaveBeenCalled();
    expect(artifactsService.archiveFile).not.toHaveBeenCalled();
  });
});
