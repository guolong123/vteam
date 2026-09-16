import { PlanReviewWiring } from './plan-review-wiring';

/**
 * PlanReviewWiring 专项（gate-notifier-wiring）：启动装配只调
 * gate.attachPlanSink（先）与 gate.attachNotifier（后）；任一
 * attach 抛错只 warn、不阻断另一路与启动；nullish 依赖跳过不抛。
 * 全程 mock，无 DB。
 */

const setup = () => {
  const gate = {
    attachPlanSink: jest.fn(),
    attachNotifier: jest.fn(),
  };
  const workerDispatcher = { dispatchAgentMention: jest.fn() };
  const planLifecycle = { transition: jest.fn() };
  return { gate, workerDispatcher, planLifecycle };
};

describe('PlanReviewWiring', () => {
  it('onModuleInit 先装 sink 再装 notifier', () => {
    const { gate, workerDispatcher, planLifecycle } = setup();
    const order: string[] = [];
    gate.attachPlanSink.mockImplementation(() => {
      order.push('sink');
    });
    gate.attachNotifier.mockImplementation(() => {
      order.push('notifier');
    });
    const wiring = new PlanReviewWiring(
      gate as never,
      workerDispatcher as never,
      planLifecycle as never,
    );
    wiring.onModuleInit();
    expect(gate.attachPlanSink).toHaveBeenCalledTimes(1);
    expect(gate.attachPlanSink).toHaveBeenCalledWith(planLifecycle);
    expect(gate.attachNotifier).toHaveBeenCalledTimes(1);
    expect(gate.attachNotifier).toHaveBeenCalledWith(workerDispatcher);
    expect(order).toEqual(['sink', 'notifier']);
  });

  it('sink 装配抛错：warn 后 notifier 照常装配，启动不抛', () => {
    const { gate, workerDispatcher, planLifecycle } = setup();
    gate.attachPlanSink.mockImplementation(() => {
      throw new Error('sink boom');
    });
    const wiring = new PlanReviewWiring(
      gate as never,
      workerDispatcher as never,
      planLifecycle as never,
    );
    expect(() => wiring.onModuleInit()).not.toThrow();
    expect(gate.attachNotifier).toHaveBeenCalledTimes(1);
    expect(gate.attachNotifier).toHaveBeenCalledWith(workerDispatcher);
  });

  it('notifier 装配抛错：warn 后启动不抛，sink 已装配保留', () => {
    const { gate, workerDispatcher, planLifecycle } = setup();
    gate.attachNotifier.mockImplementation(() => {
      throw new Error('notifier boom');
    });
    const wiring = new PlanReviewWiring(
      gate as never,
      workerDispatcher as never,
      planLifecycle as never,
    );
    expect(() => wiring.onModuleInit()).not.toThrow();
    expect(gate.attachPlanSink).toHaveBeenCalledTimes(1);
  });

  it('nullish 依赖跳过对应装配且不抛（部分 DI / 降级装配）', () => {
    const { gate, planLifecycle } = setup();
    const wiring = new PlanReviewWiring(
      gate as never,
      null,
      planLifecycle as never,
    );
    expect(() => wiring.onModuleInit()).not.toThrow();
    expect(gate.attachPlanSink).toHaveBeenCalledTimes(1);
    expect(gate.attachNotifier).not.toHaveBeenCalled();

    const gate2 = { attachPlanSink: jest.fn(), attachNotifier: jest.fn() };
    const wiring2 = new PlanReviewWiring(gate2 as never, null, null);
    expect(() => wiring2.onModuleInit()).not.toThrow();
    expect(gate2.attachPlanSink).not.toHaveBeenCalled();
    expect(gate2.attachNotifier).not.toHaveBeenCalled();
  });
});
