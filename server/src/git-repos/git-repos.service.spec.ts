import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkersService } from '../workers/workers.service';
import { GitReposService, normalizeRepoUrl } from './git-repos.service';
import { GIT_REPOS_ERRORS } from './git-repos.constants';

describe('GitReposService（凭证池分离后：仓库引用凭证+授权按repoId）', () => {
  let service: GitReposService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let prisma: any;
  let workers: { dispatchGitCredentials: jest.Mock };
  let seq = 0;

  const cred = { id: 'gc_0000000001', name: 'gitee-main', authType: 'ssh_key', credentialRef: 'iv:tag:data', fingerprint: 'ssh-rsa AAAA****', description: null, createdBy: 'u_admin', createdAt: new Date('2026-08-08T00:00:00Z'), updatedAt: new Date('2026-08-08T00:00:00Z'), revokedAt: null };
  const repoRow = (overrides: Record<string, unknown> = {}) => ({ id: 'gro_0000000001', repoUrl: 'git@gitee.com:xishuhq/test-repo', credentialId: 'gc_0000000001', createdBy: 'u_admin', createdAt: new Date('2026-08-08T00:00:00Z'), updatedAt: new Date('2026-08-08T00:00:00Z'), revokedAt: null, ...overrides });
  const grantRow = (overrides: Record<string, unknown> = {}) => ({ id: 'gr_0000000001', agentId: 'a_tester', repoId: 'gro_0000000001', permission: 'read', effect: 'allow', grantedBy: 'u_admin', grantedAt: new Date('2026-08-08T00:00:00Z'), revokedAt: null, ...overrides });

  beforeEach(async () => {
    seq = 0;
    idGen = { nextId: jest.fn(async (prefix: string) => { seq++; return `${prefix}_${String(seq).padStart(10, '0')}`; }), seed: jest.fn() };
    prisma = {
      gitCredential: { findMany: jest.fn().mockResolvedValue([cred]), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      gitRepo: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      gitRepoGrant: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 0 }), updateMany: jest.fn().mockResolvedValue({ count: 0 }), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      agent: { findMany: jest.fn().mockResolvedValue([{ id: 'a_tester' }]) },
      taskAgent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    workers = { dispatchGitCredentials: jest.fn().mockResolvedValue(1) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [GitReposService, { provide: PrismaService, useValue: prisma }, { provide: IdGeneratorService, useValue: idGen }, { provide: WorkersService, useValue: workers }],
    }).compile();
    service = module.get<GitReposService>(GitReposService);
  });

  describe('normalizeRepoUrl', () => {
    it('ssh 去 .git', () => expect(normalizeRepoUrl('git@gitee.com:xishuhq/test-repo.git')).toBe('git@gitee.com:xishuhq/test-repo'));
    it('https 协议小写', () => expect(normalizeRepoUrl('  HTTPS://GITEE.COM/xishuhq/test.git  ')).toBe('https://GITEE.COM/xishuhq/test'));
  });

  describe('findAll', () => {
    it('join 凭证与授权，返回脱敏视图', async () => {
      prisma.gitRepo.findMany.mockResolvedValue([repoRow()]);
      prisma.gitCredential.findMany.mockResolvedValue([cred]);
      prisma.gitRepoGrant.findMany.mockResolvedValue([grantRow()]);
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester', name: '测试 Agent' }]);
      const result = await service.findAll();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({ id: 'gro_0000000001', repoUrl: 'git@gitee.com:xishuhq/test-repo', credentialId: 'gc_0000000001', credentialName: 'gitee-main', authType: 'ssh_key', fingerprint: 'ssh-rsa AAAA****' }));
      expect(result[0].grantedAgents[0].permission).toBe('read');
    });
  });

  describe('create', () => {
    it('校验凭证存在，创建仓库并授权，触发下发', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue(cred);
      prisma.gitRepo.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(repoRow());
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester' }]);
      prisma.gitRepo.create.mockResolvedValue(repoRow());
      prisma.gitRepoGrant.findMany.mockResolvedValue([grantRow()]);
      const result = await service.create({ repoUrl: 'git@gitee.com:xishuhq/test-repo.git', credentialId: 'gc_0000000001', grantedAgents: [{ agentId: 'a_tester' }] } as any, 'u_admin');
      expect(prisma.gitRepo.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ repoUrl: 'git@gitee.com:xishuhq/test-repo', credentialId: 'gc_0000000001' }) }));
      expect(workers.dispatchGitCredentials).toHaveBeenCalled();
      expect(result.id).toBe('gro_0000000001');
    });
    it('凭证不存在 → 404 CREDENTIAL_NOT_FOUND', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue(null);
      await expect(service.create({ repoUrl: 'git@gitee.com:xishuhq/test-repo', credentialId: 'gc_missing' } as any, 'u_admin')).rejects.toMatchObject({ response: { code: GIT_REPOS_ERRORS.CREDENTIAL_NOT_FOUND } });
    });
    it('repoUrl 重复 → 409 REPO_EXISTS', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue(cred);
      prisma.gitRepo.findUnique.mockResolvedValue({ id: 'gro_0000000001', revokedAt: null });
      await expect(service.create({ repoUrl: 'git@gitee.com:xishuhq/test-repo', credentialId: 'gc_0000000001' } as any, 'u_admin')).rejects.toMatchObject({ response: { code: GIT_REPOS_ERRORS.REPO_EXISTS } });
    });
    it('同一凭证可被多仓库复用（无 repoUrl+authType 复合唯一限制）', async () => {
      prisma.gitCredential.findUnique.mockResolvedValue(cred);
      prisma.gitRepo.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(repoRow({ id: 'gro_0000000002', repoUrl: 'git@gitee.com:xishuhq/other-repo' }));
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.gitRepo.create.mockResolvedValue(repoRow({ id: 'gro_0000000002', repoUrl: 'git@gitee.com:xishuhq/other-repo' }));
      prisma.gitRepoGrant.findMany.mockResolvedValue([]);
      const result = await service.create({ repoUrl: 'git@gitee.com:xishuhq/other-repo', credentialId: 'gc_0000000001' } as any, 'u_admin');
      expect(result.repoUrl).toBe('git@gitee.com:xishuhq/other-repo');
      expect(result.credentialId).toBe('gc_0000000001');
    });
  });

  describe('update', () => {
    it('切换 credentialId 并覆盖授权', async () => {
      const newCred = { ...cred, id: 'gc_0000000002', name: 'new-cred', fingerprint: 'ssh-rsa BBBB****' };
      prisma.gitRepo.findUnique.mockResolvedValueOnce(repoRow()).mockResolvedValueOnce(repoRow({ credentialId: 'gc_0000000002' }));
      prisma.gitCredential.findUnique.mockResolvedValueOnce(newCred).mockResolvedValueOnce(newCred);
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester' }]);
      prisma.gitRepo.update.mockResolvedValue(repoRow({ credentialId: 'gc_0000000002' }));
      prisma.gitRepoGrant.findMany.mockResolvedValue([grantRow({ permission: 'write', effect: 'ask' })]);
      await service.update('gro_0000000001', { credentialId: 'gc_0000000002', grantedAgents: [{ agentId: 'a_tester', permission: 'write' }] } as any, 'u_admin');
      expect(prisma.gitRepo.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'gro_0000000001' }, data: { credentialId: 'gc_0000000002' } }));
      expect(prisma.gitRepoGrant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { repoId: 'gro_0000000001', revokedAt: null } }));
    });
    it('不存在 → 404', async () => {
      prisma.gitRepo.findUnique.mockResolvedValue(null);
      await expect(service.update('gro_missing', { credentialId: 'gc_0000000001' } as any, 'u_admin')).rejects.toMatchObject({ response: { code: GIT_REPOS_ERRORS.REPO_NOT_FOUND } });
    });
  });

  describe('remove', () => {
    it('软撤仓库+授权并触发下发', async () => {
      prisma.gitRepo.findUnique.mockResolvedValue(repoRow());
      const result = await service.remove('gro_0000000001', 'u_admin');
      expect(prisma.gitRepo.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'gro_0000000001' }, data: { revokedAt: expect.any(Date) } }));
      expect(prisma.gitRepoGrant.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { repoId: 'gro_0000000001', revokedAt: null } }));
      expect(result.id).toBe('gro_0000000001');
    });
  });
});
