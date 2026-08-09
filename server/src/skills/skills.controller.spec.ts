import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SKILL_ERRORS } from '../common/constants/skill.constants';
import { PermissionGuard } from '../common/guards/permission.guard';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { QuerySkillsDto } from './dto/query-skills.dto';
import { UpdateSkillStatusDto } from './dto/update-skill-status.dto';
import { UploadedSkillFile } from './skill-frontmatter.util';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

/** 断言同步抛出的 400 业务异常（code 校验，response 为 HttpException getter 需显式读取）。 */
function expectBadRequest(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
    fail('应抛出 BadRequestException');
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(BadRequestException);
  expect((caught as BadRequestException).getResponse()).toMatchObject({ code });
}

describe('SkillsController', () => {
  let controller: SkillsController;
  let service: {
    findAll: jest.Mock;
    create: jest.Mock;
    updateStatus: jest.Mock;
    findContent: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      findContent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SkillsController],
      providers: [{ provide: SkillsService, useValue: service }],
    })
      .overrideGuard(WorkerOrJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SkillsController>(SkillsController);
  });

  function makeFile(raw: string): UploadedSkillFile {
    return {
      originalname: 'SKILL.md',
      mimetype: 'text/markdown',
      size: raw.length,
      buffer: Buffer.from(raw, 'utf-8'),
    };
  }

  const VALID_SKILL = [
    '---',
    'name: git-ops',
    'version: 1.0.0',
    'description: |',
    '  git 工具族',
    'allowed-tools:',
    '  - Bash',
    '  - Read',
    '---',
    '# git-ops',
  ].join('\n');

  it('GET /skills 透传查询参数 + viewer（request.user）', async () => {
    service.findAll.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    const query: QuerySkillsDto = { enabled: true, name: 'git', page: 1, pageSize: 20 };
    const req = { user: { id: 'u_1', username: 'admin' } } as never;
    const result = await controller.findAll(query, req);

    expect(service.findAll).toHaveBeenCalledWith(query, { id: 'u_1' });
    expect(result).toMatchObject({ items: [], total: 0 });
  });

  it('GET /skills 无 user 时不传 viewer（undefined）', async () => {
    service.findAll.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await controller.findAll({}, { user: undefined } as never);

    expect(service.findAll).toHaveBeenCalledWith({}, undefined);
  });

  it('POST /skills 上传合法 SKILL.md → 解析 frontmatter + 转发 create', async () => {
    service.create.mockResolvedValue({ id: 'sk_0000000001', name: 'git-ops' });
    const file = makeFile(VALID_SKILL);

    const result = await controller.create(file);

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        content: VALID_SKILL,
        file,
        frontmatter: expect.objectContaining({
          name: 'git-ops',
          version: '1.0.0',
          description: 'git 工具族',
          'allowed-tools': ['Bash', 'Read'],
        }),
      }),
    );
    expect(result).toMatchObject({ id: 'sk_0000000001' });
  });

  it('POST /skills 未携带 file → 400 SKILL_FILE_REQUIRED（不落库）', () => {
    expectBadRequest(
      () => controller.create(undefined),
      SKILL_ERRORS.SKILL_FILE_REQUIRED,
    );
    expect(service.create).not.toHaveBeenCalled();
  });

  it('POST /skills frontmatter 无结束标记 → 400 SKILL_FRONTMATTER_INVALID', () => {
    const file = makeFile('---\nname: git-ops\n# 无结束 ---');

    expectBadRequest(
      () => controller.create(file),
      SKILL_ERRORS.SKILL_FRONTMATTER_INVALID,
    );
    expect(service.create).not.toHaveBeenCalled();
  });

  it('POST /skills 首行非 ---（非技能包）→ 400 SKILL_FRONTMATTER_INVALID', () => {
    const file = makeFile('# git-ops\n纯 markdown 无 frontmatter');

    expectBadRequest(
      () => controller.create(file),
      SKILL_ERRORS.SKILL_FRONTMATTER_INVALID,
    );
    expect(service.create).not.toHaveBeenCalled();
  });

  it('PATCH /skills/:id/status 转发 updateStatus（enabled）', async () => {
    service.updateStatus.mockResolvedValue({ id: 'sk_0000000001', enabled: true });

    const dto: UpdateSkillStatusDto = { enabled: true };
    const result = await controller.updateStatus('sk_0000000001', dto);

    expect(service.updateStatus).toHaveBeenCalledWith('sk_0000000001', true);
    expect(result).toMatchObject({ enabled: true });
  });

  it('GET /skills/:id/content 转发 findContent（worker 注入拉取）', async () => {
    service.findContent.mockResolvedValue({
      id: 'sk_0000000001',
      name: 'git-ops',
      content: '---\nname: git-ops\n---\n# git-ops',
    });

    const result = await controller.findContent('sk_0000000001');

    expect(service.findContent).toHaveBeenCalledWith('sk_0000000001');
    expect(result).toMatchObject({
      id: 'sk_0000000001',
      name: 'git-ops',
      content: expect.stringContaining('name: git-ops'),
    });
  });
});
