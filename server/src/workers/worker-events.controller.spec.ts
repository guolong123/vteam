import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { WorkerEventIngress } from './worker-event.ingress';
import { WorkerEventsController } from './worker-events.controller';
import { WorkerTokenGuard } from './worker-token.guard';

/**
 * POST /api/v1/worker/events 端点测试（T9）。
 * 经 HTTP 层验证：X-Worker-Token 鉴权（401/202）+ ingress 转发 + 幂等不影响状态码。
 * 注意：WorkerTokenGuard 在 compile 时实例化，必须补 ConfigService mock
 * （对齐 workers.controller.spec.ts 既有踩坑）。
 */
describe('WorkerEventsController (HTTP)', () => {
  let app: INestApplication;
  let ingress: { handleEvent: jest.Mock };

  beforeEach(async () => {
    ingress = { handleEvent: jest.fn().mockResolvedValue(true) };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [WorkerEventsController],
      providers: [
        { provide: WorkerEventIngress, useValue: ingress },
        // guard 依赖 WORKER_TOKEN env；mock 返回 undefined → 落到默认 dev-worker-token
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        WorkerTokenGuard,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const eventBody = {
    workerId: 'w_0000000001',
    eventId: 'evw_1',
    type: 'task.completed',
    payload: { taskId: 't_1', agentId: 'a_1', text: '完成' },
    seq: 1,
  };

  it('无 X-Worker-Token → 401 WORKER_TOKEN_INVALID', async () => {
    const res = await request(app.getHttpServer())
      .post('/worker/events')
      .send(eventBody)
      .expect(401);
    expect(res.body).toMatchObject({ code: 'WORKER_TOKEN_INVALID' });
    expect(ingress.handleEvent).not.toHaveBeenCalled();
  });

  it('token 不匹配 → 401', async () => {
    await request(app.getHttpServer())
      .post('/worker/events')
      .set('x-worker-token', 'wrong-token')
      .send(eventBody)
      .expect(401);
    expect(ingress.handleEvent).not.toHaveBeenCalled();
  });

  it('正确 token + 合法 body → 202 并转发 ingress.handleEvent', async () => {
    const res = await request(app.getHttpServer())
      .post('/worker/events')
      .set('x-worker-token', 'dev-worker-token')
      .send(eventBody)
      .expect(202);
    expect(res.body).toEqual({});
    expect(ingress.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: 'w_0000000001',
        eventId: 'evw_1',
        type: 'task.completed',
      }),
    );
  });

  it('重复事件（幂等返回 false）仍返回 202 不报错', async () => {
    ingress.handleEvent.mockResolvedValueOnce(false);
    await request(app.getHttpServer())
      .post('/worker/events')
      .set('x-worker-token', 'dev-worker-token')
      .send(eventBody)
      .expect(202);
  });
});
