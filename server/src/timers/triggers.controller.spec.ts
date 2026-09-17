import { PATH_METADATA } from '@nestjs/common/constants';
import { TriggersController } from './triggers.controller';

function makeController() {
  const service = {
    findAll: jest.fn(),
    cancelForUser: jest.fn(),
  };
  const controller = new TriggersController(service as never);
  return { controller, service };
}

function authedReq(userId = 'u_admin') {
  return { user: { id: userId, username: 'admin' } } as never;
}

describe('TriggersController（GET /triggers + DELETE /triggers/:id，service 委托）', () => {
  it('控制器挂载于 triggers 路径（全局前缀 /api/v1 下即 /api/v1/triggers）', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TriggersController)).toBe(
      'triggers',
    );
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        TriggersController.prototype.findAll,
      ),
    ).toBe('/');
    expect(
      Reflect.getMetadata(PATH_METADATA, TriggersController.prototype.remove),
    ).toBe(':id');
  });

  it('GET /triggers 透传 query + 认证 viewer 到 findAll', async () => {
    const { controller, service } = makeController();
    const query = { status: 'fired', page: 1, pageSize: 5 };
    service.findAll.mockResolvedValue({ items: [], total: 0 });

    await controller.findAll(query as never, authedReq('u_admin'));

    expect(service.findAll).toHaveBeenCalledWith(query, { id: 'u_admin' });
  });

  it('DELETE /triggers/:id 透传 id + 认证 viewer 到 cancelForUser', async () => {
    const { controller, service } = makeController();
    service.cancelForUser.mockResolvedValue({ id: 'tmr_1' });

    await controller.remove('tmr_1', authedReq('u_member'));

    expect(service.cancelForUser).toHaveBeenCalledWith('tmr_1', {
      id: 'u_member',
    });
  });

  it('无认证上下文（user 缺失）→ 401，不进 service', async () => {
    const { controller, service } = makeController();

    await expect(
      controller.findAll({} as never, {} as never),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.remove('tmr_1', {} as never),
    ).rejects.toMatchObject({ status: 401 });
    expect(service.findAll).not.toHaveBeenCalled();
    expect(service.cancelForUser).not.toHaveBeenCalled();
  });
});
