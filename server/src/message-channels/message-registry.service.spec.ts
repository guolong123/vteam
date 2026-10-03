import { MessageRegistryService } from './message-registry.service';

type FakeRow = { id: string; type: string } | null;

function makePrisma(row: FakeRow) {
  return {
    messageChannel: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) =>
        row && row.id === where.id ? row : null,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

/**
 * requestStop 回归：多 bot 场景下停一个渠道不应把同类型的所有渠道一起停掉，
 * 因此优先走 adapter.stopChannel(channelId)，只有适配器没实现时才退回全量 stop()。
 */
describe('MessageRegistryService.requestStop', () => {
  const channelId = 'mc_a';

  async function build(adapter: any, row: FakeRow) {
    const registry = new MessageRegistryService([adapter], makePrisma(row));
    await registry.onModuleInit();
    return registry;
  }

  it('适配器实现了 stopChannel 时只停该渠道，且不调用全量 stop', async () => {
    const adapter: any = {
      type: 'wecom_aibot',
      supportsInbound: true,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      stopChannel: jest.fn().mockResolvedValue(undefined),
    };
    const registry = await build(adapter, { id: channelId, type: 'wecom_aibot' });

    await registry.requestStop(channelId);

    expect(adapter.stopChannel).toHaveBeenCalledTimes(1);
    expect(adapter.stopChannel).toHaveBeenCalledWith(channelId);
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it('适配器没有 stopChannel 时退回全量 stop()', async () => {
    const adapter: any = {
      type: 'wecom_aibot',
      supportsInbound: true,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    const registry = await build(adapter, { id: channelId, type: 'wecom_aibot' });

    await registry.requestStop(channelId);

    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect((adapter as any).stopChannel).toBeUndefined();
  });

  it('渠道行不存在时既不 stopChannel 也不 stop，且不抛错', async () => {
    const adapter: any = {
      type: 'wecom_aibot',
      supportsInbound: true,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      stopChannel: jest.fn().mockResolvedValue(undefined),
    };
    const registry = await build(adapter, null);

    await expect(registry.requestStop(channelId)).resolves.toBeUndefined();

    expect(adapter.stopChannel).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it('渠道类型没有已注册适配器时不抛错', async () => {
    const adapter: any = {
      type: 'wecom_aibot',
      supportsInbound: true,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      stopChannel: jest.fn().mockResolvedValue(undefined),
    };
    const registry = await build(adapter, {
      id: channelId,
      type: 'other_type',
    });

    await expect(registry.requestStop(channelId)).resolves.toBeUndefined();

    expect(adapter.stopChannel).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it('stopChannel 抛错被吞掉，不影响调用方', async () => {
    const adapter: any = {
      type: 'wecom_aibot',
      supportsInbound: true,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      stopChannel: jest.fn().mockRejectedValue(new Error('disconnect failed')),
    };
    const registry = await build(adapter, { id: channelId, type: 'wecom_aibot' });

    await expect(registry.requestStop(channelId)).resolves.toBeUndefined();

    expect(adapter.stopChannel).toHaveBeenCalledWith(channelId);
  });
});