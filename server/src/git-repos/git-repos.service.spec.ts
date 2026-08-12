import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkersService } from '../workers/workers.service';
import { GitReposService, normalizeRepoUrl } from './git-repos.service';
import { GIT_REPOS_ERRORS } from './git-repos.constants';
import { CreateGitRepoDto } from './dto/create-git-repo.dto';

describe('GitReposService（仓库凭证：加密存储/授权维护/脱敏/软撤销/下发触发）', () => {
  let service: GitReposService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let prisma: {
    gitCredential: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    gitRepoGrant: {
      findMany: jest.Mock;
      createMany: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
    agent: {
      findMany: jest.Mock;
    };
  };
  let crypto: {
    encrypt: jest.Mock;
    decrypt: jest.Mock;
    fingerprint: jest.Mock;
  };
  let workers: { dispatchGitCredentials: jest.Mock };

  let seq = 0;

  const dto = (): CreateGitRepoDto =>
    ({
      repoUrl: 'git@gitee.com:xishuhq/test-repo.git',
      authType: 'ssh_key',
      key: '-----BEGIN OPENSSH PRIVATE KEY-----\nMOCK\n-----END OPENSSH PRIVATE KEY-----',
      grantedAgents: [{ agentId: 'a_tester' }],
    }) as CreateGitRepoDto;

  const credRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'gc_0000000001',
    repoUrl: 'git@gitee.com:xishuhq/test-repo',
    authType: 'ssh_key',
    credentialRef: 'iv:tag:data',
    fingerprint: 'ssh-rsa AAAA****',
    createdBy: 'u_admin',
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
    revokedAt: null,
    ...overrides,
  });

  const grantRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'gr_0000000001',
    agentId: 'a_tester',
    repoUrl: 'git@gitee.com:xishuhq/test-repo',
    permission: 'read',
    effect: 'allow',
    grantedBy: 'u_admin',
    grantedAt: new Date('2026-08-08T00:00:00Z'),
    revokedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    seq = 0;
    idGen = {
      nextId: jest.fn(async (prefix: string) => {
        seq++;
        return `${prefix}_${String(seq).padStart(10, '0')}`;
      }),
      seed: jest.fn(),
    };
    prisma = {
      gitCredential: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      gitRepoGrant: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      agent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    crypto = {
      encrypt: jest.fn().mockReturnValue('iv:tag:data'),
      decrypt: jest.fn().mockReturnValue('key-raw'),
      fingerprint: jest.fn().mockReturnValue('ssh-rsa AAAA****'),
    };
    workers = {
      dispatchGitCredentials: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitReposService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: CredentialCryptoService, useValue: crypto },
        { provide: WorkersService, useValue: workers },
      ],
    }).compile();

    service = module.get<GitReposService>(GitReposService);
  });

  // ---------------- normalizeRepoUrl ----------------

  describe('normalizeRepoUrl（trim + 去尾部 .git + 协议小写）', () => {
    it('ssh git@ 形式去尾部 .git', () => {
      expect(normalizeRepoUrl('git@gitee.com:xishuhq/test-repo.git')).toBe(
        'git@gitee.com:xishuhq/test-repo',
      );
    });

    it('.GIT 大写后缀也去除（大小写不敏感）', () => {
      expect(normalizeRepoUrl('git@gitee.com:xishuhq/test-repo.GIT')).toBe(
        'git@gitee.com:xishuhq/test-repo',
      );
    });

    it('https 协议小写 + 去 .git，host 原样', () => {
      expect(
        normalizeRepoUrl('  HTTPS://GITEE.COM/xishuhq/test.git  '),
      ).toBe('https://GITEE.COM/xishuhq/test');
    });

    it('已无 .git 后缀原样返回（trim 后）', () => {
      expect(normalizeRepoUrl('git@gitee.com:xishuhq/test-repo')).toBe(
        'git@gitee.com:xishuhq/test-repo',
      );
    });
  });

  // ---------------- findAll ----------------

  describe('findAll', () => {
    it('只返回未吊销凭证，grantedAgents 拼 agent 名，View 无 key/credentialRef 明文', async () => {
      // mock 返回「已按 where 过滤后」的数据（findMany mock 不执行过滤）
      prisma.gitCredential.findMany.mockResolvedValue([credRow()]);
      prisma.gitRepoGrant.findMany.mockResolvedValue([grantRow()]);
      prisma.agent.findMany.mockResolvedValue([
        { id: 'a_tester', name: '测试 Agent' },
      ]);

      const result = await service.findAll();

      expect(prisma.gitCredential.findMany).toHaveBeenCalledWith({
        where: { revokedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'gc_0000000001',
        repoUrl: 'git@gitee.com:xishuhq/test-repo',
        authType: 'ssh_key',
        fingerprint: 'ssh-rsa AAAA****',
        revokedAt: null,
        createdAt: credRow().createdAt,
        grantedAgents: [
          {
            agentId: 'a_tester',
            name: '测试 Agent',
            permission: 'read',
            effect: 'allow',
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('iv:tag:data');
      expect(JSON.stringify(result)).not.toContain('key-raw');
    });
  });

  // ---------------- create ----------------

  describe('create', () => {
    it('加密+指纹+授权落库，触发 dispatchGitCredentials，返回脱敏 View', async () => {
      prisma.gitCredential.findUnique
        .mockResolvedValueOnce(null) // 冲突检查
        .mockResolvedValueOnce(credRow()); // findView
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester' }]);
      prisma.gitCredential.create.mockResolvedValue(credRow());
      prisma.gitRepoGrant.createMany.mockResolvedValue({ count: 1 });
      prisma.gitRepoGrant.findMany.mockResolvedValue([grantRow()]);

      const result = await service.create(dto(), 'u_admin');

      // 规范化去 .git 后查询唯一键
      expect(prisma.gitCredential.findUnique).toHaveBeenNthCalledWith(1, {
        where: {
          repoUrl_authType: {
            repoUrl: 'git@gitee.com:xishuhq/test-repo',
            authType: 'ssh_key',
          },
        },
        select: { id: true, revokedAt: true },
      });
      expect(crypto.encrypt).toHaveBeenCalledWith(dto().key);
      expect(crypto.fingerprint).toHaveBeenCalledWith(dto().key);
      expect(prisma.gitCredential.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'gc_0000000001',
          repoUrl: 'git@gitee.com:xishuhq/test-repo',
          authType: 'ssh_key',
          credentialRef: 'iv:tag:data',
          fingerprint: 'ssh-rsa AAAA****',
          createdBy: 'u_admin',
        }),
      });
      // 授权缺省 permission → read、effect → allow
      expect(prisma.gitRepoGrant.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: 'gr_0000000002',
            agentId: 'a_tester',
            repoUrl: 'git@gitee.com:xishuhq/test-repo',
            permission: 'read',
            effect: 'allow',
            grantedBy: 'u_admin',
          }),
        ],
      });
      expect(workers.dispatchGitCredentials).toHaveBeenCalled();
      expect(result.id).toBe('gc_0000000001');
      expect(JSON.stringify(result)).not.toContain('MOCK');
      expect(result.grantedAgents[0].permission).toBe('read');
    });

    it('write 授权缺省 effect → ask', async () => {
      prisma.gitCredential.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(credRow());
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester' }]);
      prisma.gitCredential.create.mockResolvedValue(credRow());
      prisma.gitRepoGrant.findMany.mockResolvedValue([
        grantRow({ permission: 'write', effect: 'ask' }),
      ]);

      await service.create(
        {
          repoUrl: 'git@gitee.com:xishuhq/test-repo',
          authType: 'ssh_key',
          key: 'key',
          grantedAgents: [{ agentId: 'a_tester', permission: 'write' }],
        },
        'u_admin',
      );

      expect(prisma.gitRepoGrant.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ permission: 'write', effect: 'ask' }),
        ],
      });
    });

    it('未吊销重复（repoUrl+authType 撞唯一）→ 409 REPO_EXISTS', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue({
        id: 'gc_0000000001',
        revokedAt: null,
      });

      await expect(service.create(dto(), 'u_admin')).rejects.toMatchObject({
        response: { code: GIT_REPOS_ERRORS.REPO_EXISTS },
      });
      expect(prisma.gitCredential.create).not.toHaveBeenCalled();
    });

    it('已吊销历史行 → 覆盖激活（update 清除 revokedAt，不新建）', async () => {
      prisma.gitCredential.findUnique
        .mockResolvedValueOnce({ id: 'gc_0000000009', revokedAt: new Date() })
        .mockResolvedValueOnce(credRow({ id: 'gc_0000000009' }));
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester' }]);
      prisma.gitRepoGrant.findMany.mockResolvedValue([]);

      const result = await service.create(dto(), 'u_admin');

      expect(prisma.gitCredential.create).not.toHaveBeenCalled();
      expect(prisma.gitCredential.update).toHaveBeenCalledWith({
        where: { id: 'gc_0000000009' },
        data: expect.objectContaining({ revokedAt: null }),
      });
      expect(result.id).toBe('gc_0000000009');
    });

    it('authType 非法 → 400 AUTH_TYPE_INVALID', async () => {
      await expect(
        service.create(
          { ...dto(), authType: 'plain' as never },
          'u_admin',
        ),
      ).rejects.toMatchObject({
        response: { code: GIT_REPOS_ERRORS.AUTH_TYPE_INVALID },
      });
    });

    it('授权 agent 不存在 → 400 GRANT_INVALID', async () => {
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_other' }]);

      await expect(service.create(dto(), 'u_admin')).rejects.toMatchObject({
        response: { code: GIT_REPOS_ERRORS.GRANT_INVALID },
      });
      expect(prisma.gitCredential.create).not.toHaveBeenCalled();
    });
  });

  // ---------------- update ----------------

  describe('update', () => {
    it('key 重加密覆盖 credentialRef/fingerprint，授权全量覆盖（软撤旧 + 建新）', async () => {
      prisma.gitCredential.findUnique
        .mockResolvedValueOnce(credRow()) // 存在性检查
        .mockResolvedValueOnce(credRow()); // findView
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester' }]);
      prisma.gitCredential.update.mockResolvedValue(
        credRow({ fingerprint: 'ssh-rsa NEW****' }),
      );
      prisma.gitRepoGrant.findMany.mockResolvedValue([grantRow()]);

      await service.update(
        'gc_0000000001',
        {
          key: 'new-key',
          grantedAgents: [{ agentId: 'a_tester', permission: 'write' }],
        },
        'u_admin',
      );

      expect(crypto.encrypt).toHaveBeenCalledWith('new-key');
      expect(prisma.gitCredential.update).toHaveBeenCalledWith({
        where: { id: 'gc_0000000001' },
        data: { credentialRef: 'iv:tag:data', fingerprint: 'ssh-rsa AAAA****' },
      });
      // 先软撤该仓库旧授权，再写新授权
      expect(prisma.gitRepoGrant.updateMany).toHaveBeenCalledWith({
        where: {
          repoUrl: 'git@gitee.com:xishuhq/test-repo',
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
      // 软撤行仍占 @@unique([agentId, repoUrl]) 唯一索引，createMany 前物理清理已软撤占位
      expect(prisma.gitRepoGrant.deleteMany).toHaveBeenCalledWith({
        where: { repoUrl: 'git@gitee.com:xishuhq/test-repo', revokedAt: { not: null } },
      });
      expect(prisma.gitRepoGrant.createMany).toHaveBeenCalled();
      expect(workers.dispatchGitCredentials).toHaveBeenCalled();
    });

    it('不存在 → 404 REPO_NOT_FOUND', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.update('gc_0000000001', { key: 'x' }, 'u_admin'),
      ).rejects.toMatchObject({
        response: { code: GIT_REPOS_ERRORS.REPO_NOT_FOUND },
      });
    });

    it('已吊销 → 404 REPO_NOT_FOUND', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue(
        credRow({ revokedAt: new Date() }),
      );

      await expect(
        service.update('gc_0000000001', { key: 'x' }, 'u_admin'),
      ).rejects.toMatchObject({
        response: { code: GIT_REPOS_ERRORS.REPO_NOT_FOUND },
      });
    });
  });

  // ---------------- remove ----------------

  describe('remove', () => {
    it('软撤凭证 + 该仓库全部授权，触发 dispatch，返回 {id, revokedAt}', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue(credRow());

      const result = await service.remove('gc_0000000001', 'u_admin');

      expect(prisma.gitCredential.update).toHaveBeenCalledWith({
        where: { id: 'gc_0000000001' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.gitRepoGrant.updateMany).toHaveBeenCalledWith({
        where: {
          repoUrl: 'git@gitee.com:xishuhq/test-repo',
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
      expect(workers.dispatchGitCredentials).toHaveBeenCalled();
      expect(result.id).toBe('gc_0000000001');
      expect(result.revokedAt).toBeInstanceOf(Date);
    });

    it('不存在或已吊销 → 404 REPO_NOT_FOUND', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue(null);
      await expect(
        service.remove('gc_0000000001', 'u_admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------------- dispatch 兜底 ----------------

  describe('dispatchAfterSave 兜底', () => {
    it('dispatchGitCredentials 抛错不阻断 create（warn 兜底，注册回放可恢复）', async () => {
      prisma.gitCredential.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(credRow());
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester' }]);
      prisma.gitCredential.create.mockResolvedValue(credRow());
      prisma.gitRepoGrant.findMany.mockResolvedValue([]);
      workers.dispatchGitCredentials.mockRejectedValue(
        new Error('enqueue failed'),
      );

      const result = await service.create(dto(), 'u_admin');

      expect(result.id).toBe('gc_0000000001');
    });
  });

  // ---------------- onModuleInit ----------------

  describe('onModuleInit', () => {
    it('对齐 gc_/gr_ 前缀序号（resyncIdPrefix 幂等调用）', async () => {
      prisma.gitCredential.findMany.mockResolvedValue([
        { id: 'gc_0000000012' },
        { id: 'gc_0000000003' },
      ]);
      prisma.gitRepoGrant.findMany.mockResolvedValue([]);

      await service.onModuleInit();

      expect(idGen.seed).toHaveBeenCalledWith('gc', 12);
      // gr 前缀无数字序号 → max=0 → 不调用 seed（resyncIdPrefix 只升不降语义）
      expect(idGen.seed).not.toHaveBeenCalledWith('gr', expect.any(Number));
    });
  });
});
