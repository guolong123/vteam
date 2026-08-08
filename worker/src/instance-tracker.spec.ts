import {
  getLoad,
  onActiveSessionsIdle,
  resetInstanceCount,
  trackInstanceEnd,
  trackInstanceStart,
} from './instance-tracker';

/**
 * F2 M4 instance-tracker 测试：
 * 覆盖 start/end 计数增减、钳制 0、getLoad 快照形状；mock 断言心跳 load.instances 反映活动会话数。
 * T4c：onActiveSessionsIdle 归零回调（pending 重启执行点）。
 */

describe('instance-tracker（F2 M4：活动实例计数）', () => {
  beforeEach(() => {
    resetInstanceCount();
    onActiveSessionsIdle(null);
  });

  it('初始 load.instances = 0', () => {
    expect(getLoad()).toEqual({ instances: 0 });
  });

  it('trackInstanceStart 递增：2 个活动会话 → load.instances = 2', () => {
    expect(trackInstanceStart()).toBe(1);
    expect(trackInstanceStart()).toBe(2);
    expect(getLoad()).toEqual({ instances: 2 });
  });

  it('trackInstanceEnd 递减：start×2 + end×1 → load.instances = 1', () => {
    trackInstanceStart();
    trackInstanceStart();
    expect(trackInstanceEnd()).toBe(1);
    expect(getLoad()).toEqual({ instances: 1 });
  });

  it('end 超过 start 钳制 0（防御性，不产生负数）', () => {
    trackInstanceStart();
    trackInstanceEnd();
    expect(trackInstanceEnd()).toBe(0);
    expect(getLoad()).toEqual({ instances: 0 });
  });

  it('start/end 交错：3 start + 1 end → 2（心跳上报真实活动会话数）', () => {
    trackInstanceStart();
    trackInstanceStart();
    trackInstanceEnd();
    trackInstanceStart();
    // 心跳 payload 快照直接反映计数（registry-client sendHeartbeat 原样透传 load）
    const heartbeatLoad = getLoad();
    expect(heartbeatLoad).toEqual({ instances: 2 });
    expect(heartbeatLoad.instances).toBe(2);
  });

  it('T4c：trackInstanceEnd 归零时触发注册的 idle 回调（pending 重启执行点）', () => {
    const handler = jest.fn();
    onActiveSessionsIdle(handler);

    trackInstanceStart();
    trackInstanceStart();
    trackInstanceEnd(); // 仍有 1 个活跃：不触发
    expect(handler).not.toHaveBeenCalled();

    trackInstanceEnd(); // 归零：触发一次
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('T4c：未注册 idle 回调时 end 归零不报错', () => {
    onActiveSessionsIdle(null);
    expect(() => {
      trackInstanceStart();
      trackInstanceEnd();
    }).not.toThrow();
  });
});
