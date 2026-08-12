import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from '../users/admin.guard';
import { CreateGitRepoDto } from './dto/create-git-repo.dto';
import { UpdateGitRepoDto } from './dto/update-git-repo.dto';
import { GitReposController } from './git-repos.controller';
import { GitReposService } from './git-repos.service';

describe('GitReposController（仓库凭证 CRUD：GET 成员只读 + 写操作 AdminGuard）', () => {
  let controller: GitReposController;
  let service: {
    findAll: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const view = {
    id: 'gc_0000000001',
    repoUrl: 'git@gitee.com:xishuhq/test-repo',
    authType: 'ssh_key',
    fingerprint: 'ssh-rsa AAAA****',
    revokedAt: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    grantedAgents: [
      { agentId: 'a_tester', name: '测试 Agent', permission: 'read', effect: 'allow' },
    ],
  };

  const user = { id: 'u_admin', username: 'admin', roleId: 'r_admin' };

  const guardsOf = (method: string) =>
    (Reflect.getMetadata(GUARDS_METADATA, GitReposController.prototype[method]) ??
      []) as unknown[];

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GitReposController],
      providers: [
        { provide: GitReposService, useValue: service },
        // 方法级 @UseGuards(AdminGuard) 会在 compile 时实例化 guard，
        // AdminGuard 依赖全局 PrismaService，提供 mock 占位
        { provide: PrismaService, useValue: { user: { findUnique: jest.fn() } } },
      ],
    }).compile();

    controller = module.get<GitReposController>(GitReposController);
  });

  it('GET /git-repos 转发 findAll（成员只读，不挂 AdminGuard）', async () => {
    service.findAll.mockResolvedValue([view]);

    const result = await controller.findAll();

    expect(service.findAll).toHaveBeenCalled();
    expect(result).toEqual([view]);
    expect(guardsOf('findAll')).not.toContain(AdminGuard);
  });

  it('POST /git-repos 挂 AdminGuard 并转发 create(dto, user.id)', async () => {
    service.create.mockResolvedValue(view);
    const dto = new CreateGitRepoDto();

    const result = await controller.create(dto, user);

    expect(guardsOf('create')).toContain(AdminGuard);
    expect(service.create).toHaveBeenCalledWith(dto, 'u_admin');
    expect(result).toEqual(view);
  });

  it('PATCH /git-repos/:id 挂 AdminGuard 并转发 update(id, dto, user.id)', async () => {
    service.update.mockResolvedValue(view);
    const dto = new UpdateGitRepoDto();

    const result = await controller.update('gc_0000000001', dto, user);

    expect(guardsOf('update')).toContain(AdminGuard);
    expect(service.update).toHaveBeenCalledWith(
      'gc_0000000001',
      dto,
      'u_admin',
    );
    expect(result).toEqual(view);
  });

  it('DELETE /git-repos/:id 挂 AdminGuard 并转发 remove(id, user.id)', async () => {
    service.remove.mockResolvedValue({
      id: 'gc_0000000001',
      revokedAt: new Date(),
    });

    const result = await controller.remove('gc_0000000001', user);

    expect(guardsOf('remove')).toContain(AdminGuard);
    expect(service.remove).toHaveBeenCalledWith('gc_0000000001', 'u_admin');
    expect(result).toMatchObject({ id: 'gc_0000000001' });
  });

  it('service 抛 404 时 controller 原样透传（仓库不存在）', async () => {
    service.update.mockRejectedValue({ status: 404, code: 'REPO_NOT_FOUND' });

    await expect(
      controller.update('gc_nope', {}, user),
    ).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
  });
});

describe('GitReposController DTO 校验（class-validator）', () => {
  it('CreateGitRepoDto：合法输入无错误', async () => {
    const dto = plainToInstance(CreateGitRepoDto, {
      repoUrl: 'git@gitee.com:xishuhq/test-repo.git',
      authType: 'ssh_key',
      key: '-----BEGIN OPENSSH PRIVATE KEY-----',
      grantedAgents: [{ agentId: 'a_tester' }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('CreateGitRepoDto：authType 非法 → 400 校验错误', async () => {
    const dto = plainToInstance(CreateGitRepoDto, {
      repoUrl: 'git@gitee.com:xishuhq/test-repo',
      authType: 'plain',
      key: 'k',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('authType');
  });

  it('CreateGitRepoDto：repoUrl 空 / key 空 → 校验错误', async () => {
    const dto = plainToInstance(CreateGitRepoDto, {
      repoUrl: '',
      authType: 'https_token',
      key: '',
    });
    const errors = await validate(dto);
    const props = errors.map((e) => e.property).sort();
    expect(props).toEqual(['key', 'repoUrl']);
  });

  it('CreateGitRepoDto：grantedAgents.permission 越界 → 嵌套校验错误', async () => {
    const dto = plainToInstance(CreateGitRepoDto, {
      repoUrl: 'git@gitee.com:xishuhq/test-repo',
      authType: 'ssh_key',
      key: 'k',
      grantedAgents: [{ agentId: 'a_tester', permission: 'admin' }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('grantedAgents');
  });

  it('CreateGitRepoDto：grantedAgents 缺省合法（创建不授权）', async () => {
    const dto = plainToInstance(CreateGitRepoDto, {
      repoUrl: 'git@gitee.com:xishuhq/test-repo',
      authType: 'ssh_key',
      key: 'k',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('UpdateGitRepoDto：全缺省合法（幂等空更新）', async () => {
    const dto = plainToInstance(UpdateGitRepoDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('UpdateGitRepoDto：grantedAgents.effect 越界 → 嵌套校验错误', async () => {
    const dto = plainToInstance(UpdateGitRepoDto, {
      grantedAgents: [{ agentId: 'a_tester', effect: 'deny' }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
  });
});
