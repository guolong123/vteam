import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient } from '../workers/worker.client';
import { PlanDocsService } from './plan-docs.service';

/**
 * PlanDocsService：计划文档读写的定位链与降级语义。
 *
 * 关键约束（回归重点）：
 * - 读路径永不抛错（degraded 兜底），写路径必须抛错（用户要有成败反馈）；
 * - capabilities 必须原样带给 WorkerClient（否则静默回落 localhost:4199）；
 * - 读写用的是同一个任务目录（agent 写的 = 页面读的）。
 */
describe('PlanDocsService', () => {
  let service: PlanDocsService;
  let prisma: any;
  let workerClient: { listPlanFiles: jest.Mock; writePlanFile: jest.Mock };

  beforeEach(async () => {
    prisma = {
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      session: { findFirst: jest.fn() },
      worker: { findUnique: jest.fn() },
    };
    workerClient = { listPlanFiles: jest.fn(), writePlanFile: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanDocsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WorkerClient, useValue: workerClient },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('/data/vteam-worker') },
        },
      ],
    }).compile();
    service = module.get<PlanDocsService>(PlanDocsService);
  });

  function happyPath() {
    prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
    prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: 'tmm_main' });
    prisma.session.findFirst.mockResolvedValue({ workerId: 'w_1' });
    prisma.worker.findUnique.mockResolvedValue({
      id: 'w_1',
      status: 'online',
      capabilities: { execBaseUrl: 'http://worker:4198' },
    });
  }

  describe('listPlanDocs', () => {
    it('成功：定位主成员会话 → listPlanFiles 带 capabilities + 任务目录', async () => {
      happyPath();
      const files = [
        { name: 'plan.md', updatedAt: '2026-03-01T00:00:00.000Z', size: 3, content: '# a', truncated: false },
      ];
      workerClient.listPlanFiles.mockResolvedValue(files);

      const out = await service.listPlanDocs('t_1');

      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', teamMemberId: 'tmm_main' },
        }),
      );
      // ⚠️ capabilities 回归断言（listOpencodeAgents 踩坑同类 bug）：
      // 只传 { id } 会回退 WORKER_BASE_URL，跨容器必失败。
      expect(workerClient.listPlanFiles).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } },
        '/data/vteam-worker/tasks/t_1',
      );
      expect(out).toEqual({
        files,
        workerId: 'w_1',
        directory: '/data/vteam-worker/tasks/t_1',
        degraded: false,
      });
    });

    it('目录为空（还没写过计划）→ degraded=false + files=[]（正常态，不是错误）', async () => {
      happyPath();
      workerClient.listPlanFiles.mockResolvedValue([]);

      const out = await service.listPlanDocs('t_1');

      expect(out.degraded).toBe(false);
      expect(out.files).toEqual([]);
    });

    it('任务无团队 → degraded（不抛错、不下发调用）', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: null });

      const out = await service.listPlanDocs('t_1');

      expect(out.degraded).toBe(true);
      expect(out.files).toEqual([]);
      expect(out.directory).toBe('/data/vteam-worker/tasks/t_1');
      expect(workerClient.listPlanFiles).not.toHaveBeenCalled();
    });

    it('团队无主 Agent → degraded', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });

      const out = await service.listPlanDocs('t_1');

      expect(out.degraded).toBe(true);
    });

    it('主成员无会话 → degraded', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: 'tmm_main' });
      prisma.session.findFirst.mockResolvedValue(null);

      const out = await service.listPlanDocs('t_1');

      expect(out.degraded).toBe(true);
    });

    it('worker 行缺失 / 明确 offline → degraded，不下发调用', async () => {
      happyPath();
      prisma.worker.findUnique.mockResolvedValue(null);
      expect((await service.listPlanDocs('t_1')).degraded).toBe(true);

      happyPath();
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_1', status: 'offline', capabilities: {} });
      expect((await service.listPlanDocs('t_1')).degraded).toBe(true);

      expect(workerClient.listPlanFiles).not.toHaveBeenCalled();
    });

    it('degraded 状态 worker 仍可下发（仅 offline 阻断，调度降权≠不可达）', async () => {
      happyPath();
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_1', status: 'degraded', capabilities: {} });
      workerClient.listPlanFiles.mockResolvedValue([]);

      const out = await service.listPlanDocs('t_1');

      expect(workerClient.listPlanFiles).toHaveBeenCalled();
      expect(out.degraded).toBe(false);
    });

    it('DB/worker 异常 → degraded（不冒泡到 HTTP 层）', async () => {
      prisma.task.findUnique.mockRejectedValue(new Error('db down'));
      expect((await service.listPlanDocs('t_1')).degraded).toBe(true);

      happyPath();
      workerClient.listPlanFiles.mockRejectedValue(new Error('boom'));
      expect((await service.listPlanDocs('t_1')).degraded).toBe(true);
    });
  });

  describe('writePlanDoc', () => {
    it('成功：写进与读同一个任务目录，返回 name/updatedAt/directory', async () => {
      happyPath();
      workerClient.writePlanFile.mockResolvedValue({
        name: 'up.md',
        updatedAt: '2026-03-02T00:00:00.000Z',
      });

      const out = await service.writePlanDoc('t_1', { name: 'up.md', content: '# x' });

      expect(workerClient.writePlanFile).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } },
        { directory: '/data/vteam-worker/tasks/t_1', name: 'up.md', content: '# x' },
      );
      expect(out).toEqual({
        name: 'up.md',
        updatedAt: '2026-03-02T00:00:00.000Z',
        directory: '/data/vteam-worker/tasks/t_1',
      });
    });

    it('定位失败 → 抛出（写路径不静默降级，用户必须知道上传没成功）', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: null });

      await expect(
        service.writePlanDoc('t_1', { name: 'up.md', content: '# x' }),
      ).rejects.toThrow(/未定位到可用的 worker/);
      expect(workerClient.writePlanFile).not.toHaveBeenCalled();
    });

    it('worker 写入失败 → 异常冒泡（不被吞成成功）', async () => {
      happyPath();
      workerClient.writePlanFile.mockRejectedValue(new Error('plan-file HTTP 400: name 非法'));

      await expect(
        service.writePlanDoc('t_1', { name: 'up.md', content: '# x' }),
      ).rejects.toThrow(/name 非法/);
    });
  });

  it('taskDirectory：WORK_DIR 尾斜杠不产生 //tasks（与 worker-dispatcher 拼接一致）', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanDocsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WorkerClient, useValue: workerClient },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('/data/vteam-worker/') },
        },
      ],
    }).compile();
    const svc = module.get<PlanDocsService>(PlanDocsService);

    expect(svc.taskDirectory('t_1')).toBe('/data/vteam-worker/tasks/t_1');
  });
});
