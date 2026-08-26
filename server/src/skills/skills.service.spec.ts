import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { SKILL_ERRORS } from '../common/constants/skill.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkersService } from '../workers/workers.service';
import { QuerySkillsDto } from './dto/query-skills.dto';
import { CreateSkillInput, SkillsService } from './skills.service';

/** 构造 Prisma 已知错误（P2002 兜底路径验证）。 */
function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`prisma ${code}`, {
    code,
    clientVersion: 'test',
  });
}

describe('SkillsService', () => {
  let service: SkillsService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let workersService: { broadcastCommand: jest.Mock };
  let prisma: {
    user: { findUnique: jest.Mock };
    skill: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const skillRow = {
    id: 'sk_0000000001',
    name: 'git-ops',
    description: 'git 工具族',
    content: '---\nname: git-ops\n---\n# git-ops',
    fileMeta: { version: '1.0.0', allowedTools: ['Bash'] },
    enabled: false,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
  };

  const adminUser = {
    id: 'u_admin',
    enabled: true,
    role: { permissions: { all: true } },
  };
  const memberUser = {
    id: 'u_member',
    enabled: true,
    role: { permissions: { users: { manage: false } } },
  };

  let seq = 0;

  beforeEach(async () => {
    seq = 0;
    idGen = {
      nextId: jest.fn(
        async (prefix: string) =>
          `${prefix}_${String(++seq).padStart(10, '0')}`,
      ),
      seed: jest.fn(),
    };
    prisma = {
      user: { findUnique: jest.fn() },
      skill: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    workersService = { broadcastCommand: jest.fn().mockResolvedValue(1) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: WorkersService, useValue: workersService },
      ],
    }).compile();

    service = module.get<SkillsService>(SkillsService);
  });

  function makeInput(
    overrides: Partial<CreateSkillInput> = {},
  ): CreateSkillInput {
    return {
      frontmatter: {
        name: 'git-ops',
        version: '1.0.0',
        description: 'git 工具族',
        'allowed-tools': ['Bash', 'Read'],
      },
      content: '---\nname: git-ops\nversion: 1.0.0\n---\n# git-ops',
      file: {
        originalname: 'SKILL.md',
        mimetype: 'text/markdown',
        size: 10,
        buffer: Buffer.from('---\nname: git-ops\n---\n# git-ops'),
      },
      ...overrides,
    };
  }

  describe('create（POST /skills multipart 上传）', () => {
    it('合法 frontmatter：content 落库 + fileMeta 元数据 + enabled 默认停用', async () => {
      prisma.skill.findUnique.mockResolvedValue(null);
      prisma.skill.create.mockResolvedValue(skillRow);

      const input = makeInput();
      const result = await service.create(input);

      expect(prisma.skill.findUnique).toHaveBeenCalledWith({
        where: { name: 'git-ops' },
      });
      expect(prisma.skill.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: 'sk_0000000001',
            name: 'git-ops',
            description: 'git 工具族',
            content: input.content,
            enabled: false,
            fileMeta: expect.objectContaining({
              version: '1.0.0',
              allowedTools: ['Bash', 'Read'],
              originalname: 'SKILL.md',
              mimetype: 'text/markdown',
            }),
          }),
        }),
      );
      expect(result).toMatchObject({ name: 'git-ops' });
    });

    it('F1 MAJOR：create 落库成功后广播 reload-config 到在线 worker', async () => {
      prisma.skill.findUnique.mockResolvedValue(null);
      prisma.skill.create.mockResolvedValue(skillRow);

      await service.create(makeInput());

      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('缺 name → 400 SKILL_FRONTMATTER_INVALID（不写库）', async () => {
      await expect(
        service.create(makeInput({ frontmatter: { version: '1.0.0' } })),
      ).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_FRONTMATTER_INVALID },
      });
      expect(prisma.skill.create).not.toHaveBeenCalled();
    });

    it('name 格式非法（大写/空格）→ 400 SKILL_FRONTMATTER_INVALID', async () => {
      await expect(
        service.create(makeInput({ frontmatter: { name: 'Git Ops' } })),
      ).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_FRONTMATTER_INVALID },
      });
      expect(prisma.skill.create).not.toHaveBeenCalled();
    });

    it('name 已存在 → 409 SKILL_NAME_EXISTS（预检拦截，不写库）', async () => {
      prisma.skill.findUnique.mockResolvedValue({ name: 'git-ops' });

      await expect(service.create(makeInput())).rejects.toThrow(
        ConflictException,
      );
      await expect(service.create(makeInput())).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_NAME_EXISTS },
      });
      expect(prisma.skill.create).not.toHaveBeenCalled();
    });

    it('并发 P2002 唯一冲突 → 409 SKILL_NAME_EXISTS（兜底）', async () => {
      prisma.skill.findUnique.mockResolvedValue(null);
      prisma.skill.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create(makeInput())).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_NAME_EXISTS },
      });
    });
  });

  describe('findAll（列表：成员只读过滤 + enabled/name 过滤 + 分页）', () => {
    it('无 viewer：遵循 query.enabled（缺省全量）', async () => {
      prisma.$transaction.mockResolvedValue([1, [skillRow]]);

      await service.findAll({ enabled: true });

      expect(prisma.skill.count).toHaveBeenCalledWith({
        where: { enabled: true },
      });
      expect(prisma.skill.findMany).toHaveBeenCalledWith({
        where: { enabled: true },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 20,
      });
    });

    it('成员 viewer：强制 enabled=true（只读可见已启用），忽略 query.enabled', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ enabled: false }, { id: 'u_member' });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u_member' },
        include: { role: true },
      });
      expect(prisma.skill.count).toHaveBeenCalledWith({
        where: { enabled: true },
      });
    });

    it('admin viewer（permissions.all）：遵循 query.enabled（false 可见）', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ enabled: false }, { id: 'u_admin' });

      expect(prisma.skill.count).toHaveBeenCalledWith({
        where: { enabled: false },
      });
    });

    it('name 模糊搜索 + 自定义分页（page=2, pageSize=10）', async () => {
      prisma.$transaction.mockResolvedValue([1, [skillRow]]);

      const query: QuerySkillsDto = { name: 'git', page: 2, pageSize: 10 };
      await service.findAll(query);

      expect(prisma.skill.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { name: { contains: 'git' } },
          skip: 10,
          take: 10,
        }),
      );
    });

    it('pageSize 超上限 100 时收敛为 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ pageSize: 999 });

      expect(prisma.skill.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });
  });

  describe('updateStatus（PATCH /skills/:id/status）', () => {
    it('技能不存在 → 404 SKILL_NOT_FOUND', async () => {
      prisma.skill.findUnique.mockResolvedValue(null);

      await expect(service.updateStatus('sk_ghost', true)).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        service.updateStatus('sk_ghost', true),
      ).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_NOT_FOUND },
      });
      expect(prisma.skill.update).not.toHaveBeenCalled();
    });

    it('启停成功：update 仅写 enabled', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow);
      prisma.skill.update.mockResolvedValue({ ...skillRow, enabled: true });

      const result = await service.updateStatus('sk_0000000001', true);

      expect(prisma.skill.update).toHaveBeenCalledWith({
        where: { id: 'sk_0000000001' },
        data: { enabled: true },
      });
      expect(result).toMatchObject({ enabled: true });
    });

    it('停用（false）同样生效', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow);
      prisma.skill.update.mockResolvedValue({ ...skillRow, enabled: false });

      await service.updateStatus('sk_0000000001', false);

      expect(prisma.skill.update).toHaveBeenCalledWith({
        where: { id: 'sk_0000000001' },
        data: { enabled: false },
      });
    });

    it('F1 MAJOR：启停成功同样广播 reload-config', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow);
      prisma.skill.update.mockResolvedValue({ ...skillRow, enabled: true });

      await service.updateStatus('sk_0000000001', true);

      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });
  });

  describe('findContent（GET /skills/:id/content worker 注入拉取）', () => {
    it('技能存在 → 返回 {id, name, content}（content 原文）', async () => {
      prisma.skill.findUnique.mockResolvedValue(skillRow);

      const result = await service.findContent('sk_0000000001');

      expect(prisma.skill.findUnique).toHaveBeenCalledWith({
        where: { id: 'sk_0000000001' },
      });
      expect(result).toEqual({
        id: 'sk_0000000001',
        name: 'git-ops',
        content: skillRow.content,
      });
    });

    it('技能不存在 → 404 SKILL_NOT_FOUND', async () => {
      prisma.skill.findUnique.mockResolvedValue(null);

      await expect(service.findContent('sk_nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update（PATCH /skills/:id 编辑元信息/内容，UX-15）', () => {
    const contentWithDesc =
      '---\nname: git-ops\ndescription: 新描述\n---\n# git-ops';

    it('更新 name + description：校验唯一性（排除自身）并同步重写 content frontmatter', async () => {
      prisma.skill.findUnique
        .mockResolvedValueOnce(skillRow) // 查 id
        .mockResolvedValueOnce(null); // 查 name 无冲突
      prisma.skill.update.mockResolvedValue({
        ...skillRow,
        name: 'git-ops-v2',
        description: '新描述',
        content: contentWithDesc.replace('git-ops', 'git-ops-v2'),
      });

      const result = await service.update('sk_0000000001', {
        name: 'git-ops-v2',
        description: '新描述',
      });

      expect(prisma.skill.findUnique).toHaveBeenNthCalledWith(1, {
        where: { id: 'sk_0000000001' },
      });
      expect(prisma.skill.findUnique).toHaveBeenNthCalledWith(2, {
        where: { name: 'git-ops-v2' },
      });
      expect(prisma.skill.update).toHaveBeenCalledWith({
        where: { id: 'sk_0000000001' },
        data: {
          name: 'git-ops-v2',
          description: '新描述',
          content: '---\nname: git-ops-v2\ndescription: 新描述\n---\n# git-ops',
        },
      });
      expect(result).toMatchObject({ name: 'git-ops-v2' });
    });

    it('frontmatter 无 description 时重写会追加该字段', async () => {
      prisma.skill.findUnique
        .mockResolvedValueOnce(skillRow)
        .mockResolvedValueOnce(null);
      prisma.skill.update.mockResolvedValue(skillRow);

      await service.update('sk_0000000001', { description: '追加描述' });

      expect(prisma.skill.update).toHaveBeenCalledWith({
        where: { id: 'sk_0000000001' },
        data: {
          name: 'git-ops',
          description: '追加描述',
          content: '---\nname: git-ops\ndescription: 追加描述\n---\n# git-ops',
        },
      });
    });

    it('更新 content：校验合法并反向同步 name/description 列', async () => {
      prisma.skill.findUnique.mockResolvedValueOnce(skillRow); // 仅 id 查（name 未变不查重）
      const newContent =
        '---\nname: git-ops\nversion: 2.0.0\ndescription: 从内容同步\n---\n正文';
      prisma.skill.update.mockResolvedValue({
        ...skillRow,
        description: '从内容同步',
        content: newContent,
      });

      await service.update('sk_0000000001', { content: newContent });

      expect(prisma.skill.update).toHaveBeenCalledWith({
        where: { id: 'sk_0000000001' },
        data: {
          name: 'git-ops',
          description: '从内容同步',
          content: newContent,
        },
      });
    });

    it('F1 MAJOR：编辑落库成功后广播 reload-config', async () => {
      prisma.skill.findUnique
        .mockResolvedValueOnce(skillRow)
        .mockResolvedValueOnce(null);
      prisma.skill.update.mockResolvedValue(skillRow);

      await service.update('sk_0000000001', { name: 'git-ops-v2' });

      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('全空请求体 → 400 SKILL_UPDATE_EMPTY（不查库不落库）', async () => {
      await expect(service.update('sk_0000000001', {})).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_UPDATE_EMPTY },
      });
      expect(prisma.skill.findUnique).not.toHaveBeenCalled();
      expect(prisma.skill.update).not.toHaveBeenCalled();
    });

    it('技能不存在 → 404 SKILL_NOT_FOUND', async () => {
      prisma.skill.findUnique.mockResolvedValue(null);

      await expect(
        service.update('sk_ghost', { description: 'x' }),
      ).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_NOT_FOUND },
      });
      expect(prisma.skill.update).not.toHaveBeenCalled();
    });

    it('name 与现有技能冲突 → 409 SKILL_NAME_EXISTS（排除自身）', async () => {
      prisma.skill.findUnique
        .mockResolvedValueOnce(skillRow) // 查 id
        .mockResolvedValueOnce({ id: 'sk_other', name: 'git-ops-v2' }); // 查 name 命中其他

      await expect(
        service.update('sk_0000000001', { name: 'git-ops-v2' }),
      ).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_NAME_EXISTS },
      });
      expect(prisma.skill.update).not.toHaveBeenCalled();
    });

    it('name 改为自身当前值 → 不查重直接落库', async () => {
      prisma.skill.findUnique.mockResolvedValueOnce(skillRow); // 仅 id 查
      prisma.skill.update.mockResolvedValue(skillRow);

      await service.update('sk_0000000001', { name: 'git-ops' });

      expect(prisma.skill.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.skill.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'git-ops' }),
        }),
      );
    });

    it('name 格式非法 → 400 SKILL_FRONTMATTER_INVALID（不落库）', async () => {
      prisma.skill.findUnique.mockResolvedValueOnce(skillRow);

      await expect(
        service.update('sk_0000000001', { name: 'Git Ops' }),
      ).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_FRONTMATTER_INVALID },
      });
      expect(prisma.skill.update).not.toHaveBeenCalled();
    });

    it('content 非合法 SKILL.md → 400 SKILL_FRONTMATTER_INVALID（不落库）', async () => {
      prisma.skill.findUnique.mockResolvedValueOnce(skillRow);

      await expect(
        service.update('sk_0000000001', { content: '纯文本无 frontmatter' }),
      ).rejects.toMatchObject({
        response: { code: SKILL_ERRORS.SKILL_FRONTMATTER_INVALID },
      });
      expect(prisma.skill.update).not.toHaveBeenCalled();
    });
  });

  it('create 非法入参（frontmatter 为 null 时 name 缺省）不抛 500', async () => {
    await expect(
      service.create(makeInput({ frontmatter: { name: undefined } })),
    ).rejects.toThrow(BadRequestException);
  });
});
