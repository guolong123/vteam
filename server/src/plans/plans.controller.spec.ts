import { Test, TestingModule } from '@nestjs/testing';
import { QueryPlansDto } from './dto/query-plans.dto';
import { ReviewPlanDto } from './dto/review-plan.dto';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

describe('PlansController', () => {
  let controller: PlansController;
  let service: {
    findByTask: jest.Mock;
    findTasks: jest.Mock;
    review: jest.Mock;
    assignReviewer: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findByTask: jest.fn(),
      findTasks: jest.fn(),
      review: jest.fn(),
      assignReviewer: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlansController],
      providers: [{ provide: PlansService, useValue: service }],
    }).compile();

    controller = module.get<PlansController>(PlansController);
  });

  describe('端点路由转发', () => {
    const user = { id: 'u_member', username: 'member', roleId: 'r_member' };

    it('GET /plans 以 req.user.id 转发 taskId 到 findByTask', async () => {
      const result = {
        id: 'pl_1',
        taskId: 't_1',
        status: 'reviewing',
        tasks: [],
      };
      service.findByTask.mockResolvedValue(result);
      const query = { taskId: 't_1' };

      const out = await controller.findByTask(query as QueryPlansDto, user);

      expect(service.findByTask).toHaveBeenCalledWith('t_1', 'u_member');
      expect(out).toEqual(result);
    });

    it('PATCH /plans/:id/review 以 req.user.id 转发 id + dto 到 review', async () => {
      service.review.mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        status: 'approved',
        reviewerInstanceId: null,
      });
      const dto = { verdict: 'approved' };

      const out = await controller.review('pl_1', dto as ReviewPlanDto, user);

      expect(service.review).toHaveBeenCalledWith(
        'pl_1',
        'u_member',
        'approved',
        undefined,
      );
      expect(out).toEqual({
        id: 'pl_1',
        taskId: 't_1',
        status: 'approved',
        reviewerInstanceId: null,
      });
    });

    it('PATCH /plans/:id/review rejected 转发 reason 到 review', async () => {
      service.review.mockResolvedValue({ id: 'pl_1', status: 'rejected' });
      const dto = { verdict: 'rejected', reason: '缺少验收标准' };

      await controller.review('pl_1', dto as ReviewPlanDto, user);

      expect(service.review).toHaveBeenCalledWith(
        'pl_1',
        'u_member',
        'rejected',
        '缺少验收标准',
      );
    });

    it('GET /plans/:id/tasks 以 req.user.id 转发 id 到 findTasks', async () => {
      service.findTasks.mockResolvedValue([]);
      const out = await controller.findTasks('pl_1', user);
      expect(service.findTasks).toHaveBeenCalledWith('pl_1', 'u_member');
      expect(out).toEqual([]);
    });
  });
});
