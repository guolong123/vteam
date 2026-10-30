/**
 * 驱动工厂单测（计划 T8；T9 起 v2 实现已交付；**T18 起单轨**：v1 驱动已删除）。
 *
 * 断言的是**选择决策**（模式 → 实现）与工厂的构造行为；v2 实现本身由
 * `v2-driver.spec.ts` 覆盖，这里只验证「工厂按开关选实现」这条契约。
 *
 * ⚠️ T18 后 v1 模式**不存在**：任何指向 v1 的选择都必须**响亮失败**（见
 * `V1_DRIVER_REMOVED_MESSAGE`）——留着「看起来能切、实际切不了」的开关比没有更危险。
 */

import {
  createOpencodeDriver,
  resolveOpencodeDriverMode,
  selectOpencodeDriverImplementation,
  V1_DRIVER_REMOVED_MESSAGE,
} from './index';
import { OpenCodeDriver } from './opencode-driver';
import { V2Driver } from './v2-driver';

/** 最小 v2 实现桩（工厂只关心「被选中并返回」）。 */
function stubDriver(): OpenCodeDriver {
  return {
    baseUrl: 'http://127.0.0.1:4199',
    authPassword: '',
    createSession: jest.fn().mockResolvedValue('ses_stub'),
    sendMessage: jest.fn().mockResolvedValue({}),
    getMessages: jest.fn().mockResolvedValue([]),
    listQuestions: jest.fn().mockResolvedValue([]),
    replyQuestion: jest.fn().mockResolvedValue(undefined),
    rejectQuestion: jest.fn().mockResolvedValue(undefined),
    listPermissions: jest.fn().mockResolvedValue([]),
    replyPermission: jest.fn().mockResolvedValue(undefined),
    abort: jest.fn().mockResolvedValue(undefined),
    listAgents: jest.fn().mockResolvedValue([]),
    listTodos: jest.fn().mockResolvedValue([]),
    listModels: jest.fn().mockResolvedValue([]),
    listIntegrations: jest.fn().mockResolvedValue([]),
    isHealthy: jest.fn().mockResolvedValue(true),
  };
}

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('驱动模式解析（OPENCODE_V2_ENABLED → 模式；T18 起单轨）', () => {
  it('true → v2 模式（目标契约，默认）', () => {
    expect(resolveOpencodeDriverMode(true)).toBe('v2');
  });

  it('T18：false → **响亮失败**（v1 驱动已删除，不再有第二个实现可选）', () => {
    expect(() => resolveOpencodeDriverMode(false)).toThrow(
      /v1 驱动已随 v2 切换移除/,
    );
    expect(() => resolveOpencodeDriverMode(false)).toThrow(
      /OPENCODE_V2_ENABLED=false/,
    );
    // 文案必须指向真正的回退手段（回滚镜像/代码 + 回滚数据卷）。
    expect(() => resolveOpencodeDriverMode(false)).toThrow(/v1\.0\.x/);
    expect(V1_DRIVER_REMOVED_MESSAGE).toContain('数据卷');
  });
});

describe('实现选择决策（模式 → 实现；T18 起只有 v2）', () => {
  it('v2 模式 → v2 实现', () => {
    expect(selectOpencodeDriverImplementation('v2')).toBe('v2');
  });

  it('T18：v1 模式 → **响亮失败**（绝不静默换实现）', () => {
    expect(() => selectOpencodeDriverImplementation('v1')).toThrow(
      /v1 驱动已随 v2 切换移除/,
    );
  });
});

describe('createOpencodeDriver（工厂按模式产出实现）', () => {
  it('T18：v1 模式 → **响亮失败**（v1 实现已删除）', () => {
    expect(() => createOpencodeDriver({ mode: 'v1' })).toThrow(
      /v1 驱动已随 v2 切换移除/,
    );
  });

  it('v2 模式（默认实现）→ 产出 v2 实现（**不再回退 v1**）', () => {
    const driver = createOpencodeDriver({ mode: 'v2' });
    expect(driver).toBeInstanceOf(V2Driver);
  });

  it('v2 模式 + 已注入 v2 实现 → 产出注入的实现（不回退）', () => {
    const v2 = stubDriver();
    const driver = createOpencodeDriver({ mode: 'v2', createV2Driver: () => v2 });
    expect(driver).toBe(v2);
  });

  it('v2 模式 + v2 实现产不出驱动 → **快速失败**（绝不静默回退 v1）', () => {
    // v1 的 legacy 路径在 v2 上返回 200 + web SPA HTML（不 404）——静默回退会让 v1 驱动
    // 把 HTML 当 JSON 解析，全程无错误信号。故此处必须抛错。
    expect(() =>
      createOpencodeDriver({ mode: 'v2', createV2Driver: () => undefined }),
    ).toThrow(/v2 驱动不可用/);
  });

  it('缺省模式 = v2（与 OPENCODE_V2_ENABLED 默认值一致）→ 产出 v2 实现', () => {
    const driver = createOpencodeDriver({});
    expect(driver).toBeInstanceOf(V2Driver);
  });

  it('v2 模式不告警（回退路径已不存在，正常模式不是异常状态）', () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    createOpencodeDriver({ mode: 'v2', logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('产出的实现满足接缝契约（编译期：V2Driver implements OpenCodeDriver）', () => {
    const driver: OpenCodeDriver = createOpencodeDriver({ mode: 'v2' });
    expect(typeof driver.createSession).toBe('function');
    expect(typeof driver.sendMessage).toBe('function');
    expect(typeof driver.abort).toBe('function');
  });
});
