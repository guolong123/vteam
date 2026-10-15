import {
  getLoad,
  onActiveSessionsIdle,
  resetInstanceCount,
  trackInstanceEnd,
  trackInstanceRekey,
  trackInstanceStart,
} from './instance-tracker';

/**
 * F2 M4 instance-tracker 测试（metric 变更：load.instances = **去重活跃会话数**）。
 * 覆盖 per-session refcount、同键去重、end 递减/删除、rekey 迁移、idle 归零回调（T4c）、
 * 两条泄漏护栏（>4x 膨胀 / 30min 陈旧）清零、getLoad 快照形状。
 */

describe('instance-tracker（F2 M4：去重活跃会话计数）', () => {
  beforeEach(() => {
    resetInstanceCount();
    onActiveSessionsIdle(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('初始 load.instances = 0', () => {
    expect(getLoad()).toEqual({ instances: 0 });
  });

  it('同一 sessionKey 两次 start → 去重后仍为 1（refcount，不重复计数）', () => {
    expect(trackInstanceStart('ses_a')).toBe(1);
    expect(trackInstanceStart('ses_a')).toBe(1);
    expect(getLoad()).toEqual({ instances: 1 });
  });

  it('两个不同 sessionKey → 2', () => {
    trackInstanceStart('ses_a');
    expect(trackInstanceStart('ses_b')).toBe(2);
    expect(getLoad()).toEqual({ instances: 2 });
  });

  it('end 递减 refcount：同键 start×2 后 end×1 仍为 1，end×2 → 0', () => {
    trackInstanceStart('ses_a');
    trackInstanceStart('ses_a');
    expect(trackInstanceEnd('ses_a')).toBe(1);
    expect(trackInstanceEnd('ses_a')).toBe(0);
    expect(getLoad().instances).toBe(0);
  });

  it('end 返回去重会话数（多会话场景）', () => {
    trackInstanceStart('ses_a');
    trackInstanceStart('ses_b');
    expect(trackInstanceEnd('ses_a')).toBe(1);
    expect(trackInstanceEnd('ses_b')).toBe(0);
  });

  it('end 未 start 的键：不产生负数、不清掉其它会话（防御性）', () => {
    trackInstanceStart('ses_a');
    expect(trackInstanceEnd('ses_unknown')).toBe(1);
    expect(getLoad().instances).toBe(1);
  });

  it('rekey：把一个 refcount 从旧键移到新键（去重会话数不变）', () => {
    trackInstanceStart('anon');
    trackInstanceStart('anon');
    trackInstanceStart('ses_b');
    trackInstanceRekey('anon', 'ses_c');
    expect(getLoad().instances).toBe(2); // ses_c(2) + ses_b(1)
    // 旧键已迁移：end('anon') 不再影响计数
    expect(trackInstanceEnd('anon')).toBe(2);
    // 新键保留原 refcount：end 两次才清除 ses_c（返回的是全局去重会话数）
    expect(trackInstanceEnd('ses_c')).toBe(2); // ses_c 2→1，仍存在
    expect(trackInstanceEnd('ses_c')).toBe(1); // ses_c 删除，仅剩 ses_b
    expect(trackInstanceEnd('ses_b')).toBe(0);
  });

  it('rekey：新旧键相同 / 旧键无条目 → 空操作（幂等）', () => {
    trackInstanceStart('ses_a');
    trackInstanceRekey('ses_a', 'ses_a');
    expect(getLoad().instances).toBe(1);
    trackInstanceRekey('missing', 'ses_x');
    expect(getLoad().instances).toBe(1);
  });

  it('T4c：会话归零时触发注册的 idle 回调（pending 重启执行点）', () => {
    const handler = jest.fn();
    onActiveSessionsIdle(handler);

    trackInstanceStart('ses_a');
    trackInstanceStart('ses_b');
    trackInstanceEnd('ses_a'); // 仍有 1 个活跃：不触发
    expect(handler).not.toHaveBeenCalled();

    trackInstanceEnd('ses_b'); // 归零：触发一次
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('T4c：未注册 idle 回调时归零不报错', () => {
    onActiveSessionsIdle(null);
    expect(() => {
      trackInstanceStart('ses_a');
      trackInstanceEnd('ses_a');
    }).not.toThrow();
  });

  it('护栏：去重会话数 > maxInstances*4 → 清空重置', () => {
    for (let i = 0; i < 9; i++) {
      trackInstanceStart(`ses_${i}`);
    }
    // maxInstances=2 → 阈值 8；9 > 8 触发清零
    expect(getLoad(2)).toEqual({ instances: 0 });
  });

  it('护栏：maxInstances 缺省/≤0 不做膨胀清零', () => {
    for (let i = 0; i < 9; i++) {
      trackInstanceStart(`ses_${i}`);
    }
    expect(getLoad().instances).toBe(9);
    expect(getLoad(0).instances).toBe(9);
  });

  it('护栏：lastStartAt 距今 > 30 分钟 → 清空重置', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    trackInstanceStart('ses_a');
    nowSpy.mockReturnValue(1_000_000 + 30 * 60 * 1000 + 1);
    expect(getLoad().instances).toBe(0);
  });

  it('护栏：30 分钟内不误清', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    trackInstanceStart('ses_a');
    nowSpy.mockReturnValue(1_000_000 + 30 * 60 * 1000);
    expect(getLoad().instances).toBe(1);
  });
});
