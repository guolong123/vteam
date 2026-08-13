import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminGuard } from '../users/admin.guard';
import { ProjectMembershipGuard } from '../common/guards/project-membership.guard';
import { CreateIssueDto } from './dto/create-issue.dto';
import { QueryIssuesDto } from './dto/query-issues.dto';
import { TransitionIssueDto } from './dto/transition-issue.dto';
import { UpdateIssueDto } from './dto/update-issue.dto';
import { IssuesController } from './issues.controller';
import { IssuesService } from './issues.service';

describe('IssuesController', () => {
  let controller: IssuesController;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    transition: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      transition: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IssuesController],
      providers: [{ provide: IssuesService, useValue: service }],
    }).compile();

    controller = module.get<IssuesController>(IssuesController);
  });

  describe('端点路由转发', () => {
    const user = { id: 'u_admin', username: 'admin', roleId: 'r_admin' };

    it('GET /issues 以 req.user.id 转发 query 到 findAll', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20 };
      service.findAll.mockResolvedValue(result);
      const query = { taskId: 't_1', status: 'open', page: 1, pageSize: 20 };

      const out = await controller.findAll(query as QueryIssuesDto, user);

      expect(service.findAll).toHaveBeenCalledWith(query, 'u_admin');
      expect(out).toEqual(result);
    });

    it('GET /issues/:id 以 req.user.id 转发 id 到 findOne', async () => {
      service.findOne.mockResolvedValue({ id: 'is_1' });
      const out = await controller.findOne('is_1', user);
      expect(service.findOne).toHaveBeenCalledWith('is_1', 'u_admin');
      expect(out).toEqual({ id: 'is_1' });
    });

    it('POST /issues 以 req.user.id 转发 dto 到 create', async () => {
      service.create.mockResolvedValue({ id: 'is_1', title: 'x' });
      const dto = { taskId: 't_1', title: 'x' };
      const out = await controller.create(dto as CreateIssueDto, user);
      expect(service.create).toHaveBeenCalledWith('u_admin', dto);
      expect(out).toEqual({ id: 'is_1', title: 'x' });
    });

    it('PATCH /issues/:id 以 req.user.id 转发 id + dto 到 update', async () => {
      service.update.mockResolvedValue({ id: 'is_1', title: '改名' });
      const dto = { title: '改名' };
      const out = await controller.update('is_1', dto as UpdateIssueDto, user);
      expect(service.update).toHaveBeenCalledWith('is_1', 'u_admin', dto);
      expect(out).toEqual({ id: 'is_1', title: '改名' });
    });

    it('POST /issues/:id/transition 以 req.user.id 转发 id + dto 到 transition', async () => {
      service.transition.mockResolvedValue({ id: 'is_1', status: 'in_progress' });
      const dto = { action: 'start' };
      const out = await controller.transition(
        'is_1',
        dto as TransitionIssueDto,
        user,
      );
      expect(service.transition).toHaveBeenCalledWith('is_1', 'u_admin', dto);
      expect(out).toEqual({ id: 'is_1', status: 'in_progress' });
    });

    it('DELETE /issues/:id 以 req.user.id 转发 id 到 remove', async () => {
      service.remove.mockResolvedValue({ id: 'is_1', deleted: true });
      const out = await controller.remove('is_1', user);
      expect(service.remove).toHaveBeenCalledWith('is_1', 'u_admin');
      expect(out).toEqual({ id: 'is_1', deleted: true });
    });
  });

  describe('DTO 校验（class-validator）', () => {
    const errorsOf = async (cls: new () => object, obj: object) =>
      validate(plainToInstance(cls, obj));

    it('CreateIssueDto：taskId/title 必填、tags 须为字符串数组', async () => {
      expect(await errorsOf(CreateIssueDto, {})).not.toHaveLength(0);
      expect(await errorsOf(CreateIssueDto, { taskId: 't_1' })).not.toHaveLength(
        0,
      );
      expect(
        await errorsOf(CreateIssueDto, { taskId: 't_1', title: 'x' }),
      ).toHaveLength(0);
      // tags 非数组 / 元素非字符串 → 拒绝
      expect(
        await errorsOf(CreateIssueDto, {
          taskId: 't_1',
          title: 'x',
          tags: '需求',
        }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(CreateIssueDto, {
          taskId: 't_1',
          title: 'x',
          tags: [42],
        }),
      ).not.toHaveLength(0);
      expect(
        await errorsOf(CreateIssueDto, {
          taskId: 't_1',
          title: 'x',
          tags: ['需求'],
          assigneeAgentId: 'a_1',
          assigneeUserId: 'u_1',
        }),
      ).toHaveLength(0);
    });

    it('UpdateIssueDto：全字段可选，tags 数组元素须字符串', async () => {
      expect(await errorsOf(UpdateIssueDto, {})).toHaveLength(0);
      expect(await errorsOf(UpdateIssueDto, { title: 'x' })).toHaveLength(0);
      expect(await errorsOf(UpdateIssueDto, { tags: [1] })).not.toHaveLength(0);
      expect(
        await errorsOf(UpdateIssueDto, {
          title: 'x',
          tags: ['缺陷'],
          assigneeAgentId: null,
        }),
      ).toHaveLength(0);
    });

    it('TransitionIssueDto：action 须在迁移表内（非法 → 400）', async () => {
      expect(await errorsOf(TransitionIssueDto, {})).not.toHaveLength(0);
      expect(
        await errorsOf(TransitionIssueDto, { action: 'bogus' }),
      ).not.toHaveLength(0);
      for (const action of ['start', 'resolve', 'close', 'reopen', 'reject']) {
        expect(await errorsOf(TransitionIssueDto, { action })).toHaveLength(0);
      }
    });

    it('QueryIssuesDto：taskId 必填、status 枚举、page/pageSize 正整数', async () => {
      expect(await errorsOf(QueryIssuesDto, {})).not.toHaveLength(0);
      expect(
        await errorsOf(QueryIssuesDto, { taskId: 't_1', status: 'bogus' }),
      ).not.toHaveLength(0);
      expect(await errorsOf(QueryIssuesDto, { taskId: 't_1', page: 0 })).not.toHaveLength(0);
      expect(
        await errorsOf(QueryIssuesDto, {
          taskId: 't_1',
          status: 'resolved',
          page: 2,
          pageSize: 50,
        }),
      ).toHaveLength(0);
    });
  });

  describe('守卫（Metis M2/M3）', () => {
    it('controller 类级不挂 AdminGuard / ProjectMembershipGuard（:id 会误解析为 taskId）', () => {
      const guards =
        (Reflect.getMetadata('__guards__', IssuesController) as
          | Array<{ name: string }>
          | undefined) ?? [];
      const guardNames = guards.map((g) => g.name);
      expect(guardNames).not.toContain(AdminGuard.name);
      expect(guardNames).not.toContain(ProjectMembershipGuard.name);
    });
  });
});
