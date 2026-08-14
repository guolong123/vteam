import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  ArtifactsService,
  validateArtifactDeclaration,
} from './artifacts.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const FIXED_DATE = new Date('2026-08-07T00:00:00.000Z');

describe('ArtifactsService', () => {
  let prisma: Record<string, any>;
  let counters: Record<string, number>;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let service: ArtifactsService;

  /** 构造 service 实例（不走 Nest DI）：$transaction 直接回调 prisma（tx === prisma mock）。 */
  const createService = () => {
    counters = {};
    idGen = {
      nextId: jest.fn(async (prefix: string) => {
        counters[prefix] = (counters[prefix] ?? 0) + 1;
        return `${prefix}_${String(counters[prefix]).padStart(10, '0')}`;
      }),
      seed: jest.fn(),
    };
    realtime = { broadcast: jest.fn() };
    prisma = {
      artifact: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      artifactVersion: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn((cb: any) => cb(prisma)),
    };
    return new ArtifactsService(prisma as any, idGen as any, realtime as any);
  };

  beforeEach(() => {
    service = createService();
  });

  describe('onModuleInit', () => {
    it('seed art/artv 两个前缀：按库内最大序号对齐 id 生成器', async () => {
      prisma.artifact.findFirst.mockResolvedValue({ id: 'art_0000000005' });
      prisma.artifactVersion.findFirst.mockResolvedValue({
        id: 'artv_0000000012',
      });

      await service.onModuleInit();

      expect(idGen.seed).toHaveBeenCalledWith('art', 5);
      expect(idGen.seed).toHaveBeenCalledWith('artv', 12);
    });
  });

  describe('validateArtifactDeclaration（12 篇 §3.1 协议校验）', () => {
    it('合法 text：type+title+content 通过', () => {
      expect(
        validateArtifactDeclaration({
          type: 'text',
          title: '验收结论',
          content: '通过',
        }),
      ).toEqual({ valid: true });
    });

    it('合法 doc/file：type+title+fileRef 通过', () => {
      expect(
        validateArtifactDeclaration({
          type: 'doc',
          title: '需求文档',
          fileRef: 'mock://t/1',
        }),
      ).toEqual({ valid: true });
      expect(
        validateArtifactDeclaration({
          type: 'file',
          title: '补丁',
          fileRef: 'mock://t/1',
        }),
      ).toEqual({ valid: true });
    });

    it('type 非法 / 缺 title / text 缺 content / doc 缺 fileRef → 拒绝', () => {
      expect(
        validateArtifactDeclaration({ type: 'code', title: 'x', content: 'c' })
          .valid,
      ).toBe(false);
      expect(
        validateArtifactDeclaration({ type: 'text', title: '  ', content: 'c' })
          .valid,
      ).toBe(false);
      expect(
        validateArtifactDeclaration({ type: 'text', title: 'x', content: '' })
          .valid,
      ).toBe(false);
      expect(
        validateArtifactDeclaration({ type: 'doc', title: 'x' }).valid,
      ).toBe(false);
      expect(
        validateArtifactDeclaration({ type: 'file', title: 'x' }).valid,
      ).toBe(false);
    });
  });

  describe('append（归档链路，12 篇 §5）', () => {
    it('text 新建 v1：create artifact(currentVersion=1) + version 1，contentRef=content，sha256 落库', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null); // 幂等未命中
      prisma.artifact.findFirst.mockResolvedValue(null); // 无现有产出物
      prisma.artifact.create.mockResolvedValue({
        id: 'art_0000000001',
        taskId: 't_0000000001',
        type: 'text',
        title: '验收结论',
        currentVersion: 1,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      });
      prisma.artifactVersion.create.mockResolvedValue({
        id: 'artv_0000000001',
        artifactId: 'art_0000000001',
        version: 1,
        contentRef: '通过',
        filePath: null,
        sha256: sha('通过'),
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: FIXED_DATE,
      });

      const result = await service.append('t_0000000001', {
        taskId: 't_0000000001',
        type: 'text',
        title: '验收结论',
        content: '通过',
      });

      expect(result.status).toBe('archived');
      expect(prisma.artifact.create).toHaveBeenCalledWith({
        data: {
          id: 'art_0000000001',
          taskId: 't_0000000001',
          type: 'text',
          title: '验收结论',
          currentVersion: 1,
        },
      });
      expect(prisma.artifactVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'artv_0000000001',
          artifactId: 'art_0000000001',
          version: 1,
          contentRef: '通过',
          filePath: null,
          sha256: sha('通过'),
          acceptedFlag: false,
        }),
      });
      expect(result.artifact).toEqual(
        expect.objectContaining({
          id: 'art_0000000001',
          taskId: 't_0000000001',
          type: 'text',
          title: '验收结论',
          currentVersion: 1,
          acceptedFlag: false,
        }),
      );
    });

    it('幂等去重：同 taskId+type+sha256 已存在 → status=duplicate，版本不增、不 create', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue({
        sha256: sha('重复内容'),
        artifact: {
          id: 'art_0000000001',
          taskId: 't_0000000001',
          type: 'text',
          title: '结论',
          currentVersion: 1,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
        },
        acceptedFlag: false,
        authorAgentId: null,
        version: 1,
      });

      const result = await service.append('t_0000000001', {
        taskId: 't_0000000001',
        type: 'text',
        title: '结论',
        content: '重复内容',
      });

      expect(result.status).toBe('duplicate');
      expect(prisma.artifact.create).not.toHaveBeenCalled();
      expect(prisma.artifactVersion.create).not.toHaveBeenCalled();
      expect(prisma.artifact.update).not.toHaveBeenCalled();
      expect(result.artifact).toEqual(
        expect.objectContaining({ id: 'art_0000000001', currentVersion: 1 }),
      );
    });

    it('版本递增：同 taskId+type+title 已有产出物 → append currentVersion+1 + 新版本', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'art_0000000001',
        taskId: 't_0000000001',
        type: 'doc',
        title: '需求文档',
        currentVersion: 1,
      });
      prisma.artifact.update.mockResolvedValue({
        id: 'art_0000000001',
        taskId: 't_0000000001',
        type: 'doc',
        title: '需求文档',
        currentVersion: 2,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      });
      prisma.artifactVersion.create.mockResolvedValue({
        id: 'artv_0000000002',
        artifactId: 'art_0000000001',
        version: 2,
        contentRef: 'mock://t_0000000001/2',
        filePath: 'mock://t_0000000001/2',
        sha256: sha('v2 内容'),
        acceptedFlag: false,
        authorAgentId: 'a_product',
        changeNote: '补充细节',
        createdAt: FIXED_DATE,
      });

      const result = await service.append(
        't_0000000001',
        {
          taskId: 't_0000000001',
          type: 'doc',
          title: '需求文档',
          content: 'v2 内容',
          fileRef: 'mock://t_0000000001/2',
        },
        { authorAgentId: 'a_product', changeNote: '补充细节' },
      );

      expect(prisma.artifact.update).toHaveBeenCalledWith({
        where: { id: 'art_0000000001' },
        data: { currentVersion: 2 },
      });
      expect(prisma.artifactVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          artifactId: 'art_0000000001',
          version: 2,
          contentRef: 'mock://t_0000000001/2',
          filePath: 'mock://t_0000000001/2',
          sha256: sha('v2 内容'),
          authorAgentId: 'a_product',
          changeNote: '补充细节',
        }),
      });
      expect(result.artifact).toEqual(
        expect.objectContaining({ currentVersion: 2 }),
      );
    });

    it('doc/file 归档：contentRef/filePath 存 fileRef（mock 占位，不真实拉取）', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      prisma.artifact.findFirst.mockResolvedValue(null);
      prisma.artifact.create.mockResolvedValue({
        id: 'art_0000000002',
        taskId: 't_0000000001',
        type: 'file',
        title: '补丁',
        currentVersion: 1,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      });
      prisma.artifactVersion.create.mockResolvedValue({
        id: 'artv_0000000001',
        artifactId: 'art_0000000002',
        version: 1,
        contentRef: 'mock://t_0000000001/1',
        filePath: 'mock://t_0000000001/1',
        sha256: sha('patch content'),
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: FIXED_DATE,
      });

      await service.append('t_0000000001', {
        taskId: 't_0000000001',
        type: 'file',
        title: '补丁',
        content: 'patch content',
        fileRef: 'mock://t_0000000001/1',
      });

      expect(prisma.artifactVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          contentRef: 'mock://t_0000000001/1',
          filePath: 'mock://t_0000000001/1',
        }),
      });
    });

    it('非法声明 → 400 ARTIFACT_INVALID_DECLARATION（不落库）', async () => {
      const cases = [
        { type: 'code', title: 'x', content: 'c' }, // type 非法
        { type: 'text', title: 'x', content: '' }, // text 缺 content
        { type: 'doc', title: 'x', content: 'c' }, // doc 缺 fileRef
      ];
      for (const input of cases) {
        await expect(
          service.append('t_0000000001', {
            taskId: 't_0000000001',
            ...input,
          } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(prisma.artifact.create).not.toHaveBeenCalled();
      expect(prisma.artifactVersion.create).not.toHaveBeenCalled();
    });

    it('12 篇 §7：当前版本已验收（accepted_flag=true）→ 409 ARTIFACT_ACCEPTED_IMMUTABLE', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null); // 幂等未命中
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'art_0000000001',
        taskId: 't_0000000001',
        type: 'text',
        title: '验收结论',
        currentVersion: 2,
      });
      prisma.artifactVersion.findUnique.mockResolvedValue({
        acceptedFlag: true,
      });

      try {
        await service.append('t_0000000001', {
          taskId: 't_0000000001',
          type: 'text',
          title: '验收结论',
          content: '验收后的新内容',
        });
        fail('应抛出 ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: 'ARTIFACT_ACCEPTED_IMMUTABLE',
        });
      }
      // 锁定版本不产生任何写操作
      expect(prisma.artifact.update).not.toHaveBeenCalled();
      expect(prisma.artifactVersion.create).not.toHaveBeenCalled();
      expect(prisma.task.updateMany).not.toHaveBeenCalled();
    });

    it('12 篇 §7：幂等优先——同 sha256 已归档（即使已验收）→ duplicate 不触发 409', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue({
        sha256: sha('重复内容'),
        artifact: {
          id: 'art_0000000001',
          taskId: 't_0000000001',
          type: 'text',
          title: '结论',
          currentVersion: 1,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
        },
        acceptedFlag: true,
        authorAgentId: null,
        version: 1,
      });

      const result = await service.append('t_0000000001', {
        taskId: 't_0000000001',
        type: 'text',
        title: '结论',
        content: '重复内容',
      });

      expect(result.status).toBe('duplicate');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.task.updateMany).not.toHaveBeenCalled();
    });

    it('12 篇 §7：验收后（completed）append 新版本 → 任务退回 in_progress + task.status.changed 广播', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      prisma.artifact.findFirst.mockResolvedValue(null);
      prisma.artifact.create.mockResolvedValue({
        id: 'art_0000000001',
        taskId: 't_0000000001',
        type: 'text',
        title: '验收结论',
        currentVersion: 1,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      });
      prisma.artifactVersion.create.mockResolvedValue({
        id: 'artv_0000000001',
        artifactId: 'art_0000000001',
        version: 1,
        contentRef: '通过',
        filePath: null,
        sha256: sha('通过'),
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: FIXED_DATE,
      });
      prisma.task.updateMany.mockResolvedValue({ count: 1 }); // CAS 命中：任务原为 completed

      const result = await service.append('t_0000000001', {
        taskId: 't_0000000001',
        type: 'text',
        title: '验收结论',
        content: '通过',
      });

      expect(result.status).toBe('archived');
      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000001', status: 'completed' },
        data: { status: 'in_progress', version: { increment: 1 } },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        'task.status.changed',
        expect.objectContaining({
          taskId: 't_0000000001',
          from: 'completed',
          to: 'in_progress',
        }),
        { type: 'global' },
      );
    });

    it('12 篇 §7：任务非 completed → append 正常归档不退回不广播', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      prisma.artifact.findFirst.mockResolvedValue(null);
      prisma.artifact.create.mockResolvedValue({
        id: 'art_0000000001',
        taskId: 't_0000000001',
        type: 'text',
        title: '验收结论',
        currentVersion: 1,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      });
      prisma.artifactVersion.create.mockResolvedValue({
        id: 'artv_0000000001',
        artifactId: 'art_0000000001',
        version: 1,
        contentRef: '通过',
        filePath: null,
        sha256: sha('通过'),
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: FIXED_DATE,
      });
      // task.updateMany 默认 count=0（CAS 未命中，任务非 completed）

      const result = await service.append('t_0000000001', {
        taskId: 't_0000000001',
        type: 'text',
        title: '验收结论',
        content: '通过',
      });

      expect(result.status).toBe('archived');
      expect(prisma.task.updateMany).toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('archiveFile（文件归档公共方法，POST /uploads 与 submit_artifact doc/file 共用）', () => {
    it('新建 v1：无幂等命中、无同 title file 产出物 → create artifact(currentVersion=1) + version 1（contentRef=storedUrl、filePath=fileRef 原文）', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      prisma.artifact.findFirst.mockResolvedValue(null);
      prisma.artifact.create.mockResolvedValue({
        id: 'art_0000000001',
        currentVersion: 1,
      });
      prisma.artifactVersion.create.mockResolvedValue({ id: 'artv_0000000001' });

      const result = await service.archiveFile('t_0000000001', {
        fileRef: '报告.docx',
        storedUrl: '/uploads/uuid-1.docx',
        storedName: '报告.docx',
        sha256: sha('文件内容'),
        title: '需求文档',
      });

      expect(prisma.artifact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: 't_0000000001',
          type: 'file',
          title: '需求文档',
          currentVersion: 1,
        }),
      });
      expect(prisma.artifactVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          artifactId: 'art_0000000001',
          version: 1,
          contentRef: '/uploads/uuid-1.docx',
          filePath: '报告.docx',
          sha256: sha('文件内容'),
          acceptedFlag: false,
          authorAgentId: null,
        }),
      });
      expect(result).toEqual({
        artifactId: 'art_0000000001',
        version: 1,
        status: 'created',
      });
    });

    it('title 缺省 → 用 storedName 作为产出物标题', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      prisma.artifact.findFirst.mockResolvedValue(null);
      prisma.artifact.create.mockResolvedValue({
        id: 'art_0000000002',
        currentVersion: 1,
      });
      prisma.artifactVersion.create.mockResolvedValue({ id: 'artv_0000000002' });

      await service.archiveFile('t_0000000001', {
        fileRef: '截图.png',
        storedUrl: '/uploads/uuid-1.png',
        storedName: '截图.png',
        sha256: sha('png 内容'),
      });

      expect(prisma.artifact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ title: '截图.png' }),
      });
    });

    it('幂等去重：同 taskId+type=file+sha256 已归档 → duplicate（版本不增、不写库）', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue({
        artifactId: 'art_existing',
        version: 2,
      });

      const result = await service.archiveFile('t_0000000001', {
        fileRef: 'dup.txt',
        storedUrl: '/uploads/uuid-2.txt',
        storedName: 'dup.txt',
        sha256: sha('重复内容'),
      });

      expect(result).toEqual({
        artifactId: 'art_existing',
        version: 2,
        status: 'duplicate',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.artifact.create).not.toHaveBeenCalled();
      expect(prisma.artifactVersion.create).not.toHaveBeenCalled();
    });

    it('版本递增：同 taskId+type=file+title 已有产出物 → append currentVersion+1 + 新版本', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'art_0000000001',
        title: '需求文档',
        currentVersion: 1,
      });
      prisma.artifact.update.mockResolvedValue({
        id: 'art_0000000001',
        currentVersion: 2,
      });
      prisma.artifactVersion.create.mockResolvedValue({ id: 'artv_0000000002' });

      const result = await service.archiveFile('t_0000000001', {
        fileRef: '报告.docx',
        storedUrl: '/uploads/uuid-2.docx',
        storedName: '报告.docx',
        sha256: sha('v2 内容'),
        title: '需求文档',
      });

      expect(prisma.artifact.update).toHaveBeenCalledWith({
        where: { id: 'art_0000000001' },
        data: { currentVersion: 2 },
      });
      expect(prisma.artifactVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          artifactId: 'art_0000000001',
          version: 2,
          contentRef: '/uploads/uuid-2.docx',
          filePath: '报告.docx',
          sha256: sha('v2 内容'),
          acceptedFlag: false,
        }),
      });
      expect(result).toEqual({
        artifactId: 'art_0000000001',
        version: 2,
        status: 'appended',
      });
    });

    it('accepted 锁定：当前版本已验收（acceptedFlag=true）→ 抛错且不产生写操作', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'art_0000000001',
        title: '需求文档',
        currentVersion: 2,
      });
      prisma.artifactVersion.findUnique.mockResolvedValue({
        acceptedFlag: true,
      });

      await expect(
        service.archiveFile('t_0000000001', {
          fileRef: '报告.docx',
          storedUrl: '/uploads/uuid-3.docx',
          storedName: '报告.docx',
          sha256: sha('锁定后内容'),
          title: '需求文档',
        }),
      ).rejects.toThrow('当前版本已验收锁定');
      expect(prisma.artifact.update).not.toHaveBeenCalled();
      expect(prisma.artifactVersion.create).not.toHaveBeenCalled();
    });
  });

  describe('onArtifactSubmitted（消费 artifact.submitted 事件）', () => {
    it('非法声明 → {status: invalid} 回退普通消息，不抛错不落库', async () => {
      const result = await service.onArtifactSubmitted({
        taskId: 't_0000000001',
        type: 'code',
        title: 'x',
        content: 'c',
      } as any);

      expect(result.status).toBe('invalid');
      expect(result.reason).toContain('type');
      expect(prisma.artifactVersion.create).not.toHaveBeenCalled();
    });

    it('合法声明 → 转 append 归档', async () => {
      const appendSpy = jest.spyOn(service, 'append').mockResolvedValue({
        status: 'archived',
        artifact: { id: 'art_0000000001' },
      });

      const result = await service.onArtifactSubmitted({
        taskId: 't_0000000001',
        type: 'text',
        title: '结论',
        content: '通过',
      });

      expect(result).toEqual({
        status: 'archived',
        artifact: { id: 'art_0000000001' },
      });
      expect(appendSpy).toHaveBeenCalledWith('t_0000000001', {
        taskId: 't_0000000001',
        type: 'text',
        title: '结论',
        content: '通过',
      });
      appendSpy.mockRestore();
    });
  });

  describe('findByTask（GET /tasks/:id/artifacts，12 篇 §6.1）', () => {
    it('分页 + type 筛选：按 currentVersion 聚合 acceptedFlag/authorAgentId', async () => {
      // mock 返回与 type=text 过滤一致的结果（mock 不真实执行 where，需自行对齐）
      prisma.artifact.findMany.mockResolvedValue([
        {
          id: 'art_0000000001',
          taskId: 't_0000000001',
          type: 'text',
          title: '结论A',
          currentVersion: 2,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
        },
      ]);
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          id: 'artv_0000000001',
          artifactId: 'art_0000000001',
          version: 1,
          acceptedFlag: false,
          authorAgentId: null,
        },
        {
          id: 'artv_0000000002',
          artifactId: 'art_0000000001',
          version: 2,
          acceptedFlag: true,
          authorAgentId: 'a_test',
        },
      ]);

      const result = await service.findByTask('t_0000000001', {
        type: 'text',
        page: 1,
        pageSize: 20,
      });

      expect(prisma.artifact.findMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', type: 'text' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result.total).toBe(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'art_0000000001',
          currentVersion: 2,
          acceptedFlag: true,
          authorAgentId: 'a_test',
        }),
      );
    });

    it('accepted 筛选：按当前版本 acceptedFlag 过滤（true/false）', async () => {
      const artifacts = [
        {
          id: 'art_0000000001',
          taskId: 't_0000000001',
          type: 'text',
          title: 'A',
          currentVersion: 1,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
        },
        {
          id: 'art_0000000002',
          taskId: 't_0000000001',
          type: 'text',
          title: 'B',
          currentVersion: 1,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
        },
      ];
      prisma.artifact.findMany.mockResolvedValue(artifacts);
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          id: 'artv_0000000001',
          artifactId: 'art_0000000001',
          version: 1,
          acceptedFlag: true,
          authorAgentId: null,
        },
        {
          id: 'artv_0000000002',
          artifactId: 'art_0000000002',
          version: 1,
          acceptedFlag: false,
          authorAgentId: null,
        },
      ]);

      const accepted = await service.findByTask('t_0000000001', {
        accepted: 'true',
      });
      expect(accepted.total).toBe(1);
      expect(accepted.items[0].id).toBe('art_0000000001');

      const rejected = await service.findByTask('t_0000000001', {
        accepted: 'false',
      });
      expect(rejected.total).toBe(1);
      expect(rejected.items[0].id).toBe('art_0000000002');
    });

    it('分页切片：pageSize 收敛与 slice 生效', async () => {
      const artifacts = Array.from({ length: 3 }, (_, i) => ({
        id: `art_000000000${i + 1}`,
        taskId: 't_0000000001',
        type: 'text',
        title: `T${i + 1}`,
        currentVersion: 1,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      }));
      prisma.artifact.findMany.mockResolvedValue(artifacts);
      prisma.artifactVersion.findMany.mockResolvedValue([]);

      const result = await service.findByTask('t_0000000001', {
        page: 2,
        pageSize: 1,
      });
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('art_0000000002');
    });
  });

  describe('findOne / findVersion（文档库查看，12 篇 §6.2）', () => {
    it('findOne 命中：返回详情 + 版本列表（升序）', async () => {
      prisma.artifact.findUnique.mockResolvedValue({
        id: 'art_0000000001',
        taskId: 't_0000000001',
        type: 'doc',
        title: '需求文档',
        currentVersion: 2,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
        versions: [
          {
            id: 'artv_0000000001',
            artifactId: 'art_0000000001',
            version: 1,
            contentRef: 'ref1',
            filePath: 'f1',
            sha256: 'h1',
            acceptedFlag: false,
            authorAgentId: null,
            changeNote: null,
            createdAt: FIXED_DATE,
          },
          {
            id: 'artv_0000000002',
            artifactId: 'art_0000000001',
            version: 2,
            contentRef: 'ref2',
            filePath: 'f2',
            sha256: 'h2',
            acceptedFlag: false,
            authorAgentId: 'a_product',
            changeNote: '补充',
            createdAt: FIXED_DATE,
          },
        ],
      });

      const result = await service.findOne('art_0000000001');

      expect(prisma.artifact.findUnique).toHaveBeenCalledWith({
        where: { id: 'art_0000000001' },
        include: { versions: { orderBy: { version: 'asc' } } },
      });
      expect(result.currentVersion).toBe(2);
      expect(result.versions).toHaveLength(2);
      expect(result.versions[1]).toEqual(
        expect.objectContaining({
          version: 2,
          contentRef: 'ref2',
          acceptedFlag: false,
          authorAgentId: 'a_product',
          changeNote: '补充',
          createdAt: '2026-08-07T00:00:00.000Z',
        }),
      );
    });

    it('findOne 不存在 → 404 ARTIFACT_NOT_FOUND', async () => {
      prisma.artifact.findUnique.mockResolvedValue(null);
      await expect(service.findOne('art_999')).rejects.toMatchObject({
        status: 404,
        response: { code: 'ARTIFACT_NOT_FOUND' },
      });
    });

    it('findVersion 命中：返回指定版本 ArtifactVersionDto', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue({
        id: 'artv_0000000002',
        artifactId: 'art_0000000001',
        version: 2,
        contentRef: 'ref2',
        filePath: null,
        sha256: 'h2',
        acceptedFlag: false,
        authorAgentId: 'a_product',
        changeNote: null,
        createdAt: FIXED_DATE,
      });

      const result = await service.findVersion('art_0000000001', 2);

      expect(prisma.artifactVersion.findFirst).toHaveBeenCalledWith({
        where: { artifactId: 'art_0000000001', version: 2 },
      });
      expect(result).toEqual(
        expect.objectContaining({ version: 2, contentRef: 'ref2' }),
      );
    });

    it('findVersion 不存在 → 404 ARTIFACT_VERSION_NOT_FOUND', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue(null);
      await expect(
        service.findVersion('art_0000000001', 99),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('FILE-02：doc/file 版本（filePath 非空）→ 附加归一化 fileUrl/fileName/fileExt（size 缺省不读盘）', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue({
        id: 'artv_0000000002',
        artifactId: 'art_0000000001',
        version: 2,
        contentRef: '/data/workspace/tasks/t_1/api-doc.PDF',
        filePath: '/data/workspace/tasks/t_1/api-doc.PDF',
        sha256: 'h2',
        acceptedFlag: false,
        authorAgentId: 'a_product',
        changeNote: null,
        createdAt: FIXED_DATE,
      });

      const result = await service.findVersion('art_0000000001', 2) as Record<
        string,
        unknown
      >;

      expect(result).toEqual(
        expect.objectContaining({
          version: 2,
          contentRef: '/data/workspace/tasks/t_1/api-doc.PDF',
          filePath: '/data/workspace/tasks/t_1/api-doc.PDF',
          // 原始路径 → 归一化为 /uploads/<basename>（浏览器可访问），派生扩展名
          fileUrl: '/uploads/api-doc.PDF',
          fileName: 'api-doc.PDF',
          fileExt: 'pdf',
        }),
      );
      expect(result.fileSize).toBeNull();
    });

    it('FILE-02：text 版本（filePath=null）→ 不附加 fileUrl 派生字段', async () => {
      prisma.artifactVersion.findFirst.mockResolvedValue({
        id: 'artv_0000000001',
        artifactId: 'art_0000000001',
        version: 1,
        contentRef: '结论正文',
        filePath: null,
        sha256: 'h1',
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: FIXED_DATE,
      });

      const result = (await service.findVersion(
        'art_0000000001',
        1,
      )) as Record<string, unknown>;

      expect(result.fileUrl).toBeUndefined();
      expect(result.fileName).toBeUndefined();
      expect(result.fileExt).toBeUndefined();
      expect(result.contentRef).toBe('结论正文');
    });
  });
});
