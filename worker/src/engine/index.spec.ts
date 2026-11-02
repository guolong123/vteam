/**
 * 引擎选择决策单测（P1）。
 *
 * 断言的是**纯函数决策**（`WORKER_ENGINE` → 引擎类型）与工厂的校验行为，
 * 不碰真实引擎实现（那是集成测试的事）。
 *
 * 为什么这些断言值得写：留一个"看起来能配、实际跑的还是 opencode"的入口，
 * 等于让运维在故障时按错误方向排查——所以未知值必须**响亮失败**。
 */

import {
  createEngine,
  DEFAULT_WORKER_ENGINE,
  resolveWorkerEngine,
  resolveWorkerEngineFromEnv,
  SUPPORTED_ENGINES,
  unsupportedEngineMessage,
  WORKER_ENGINE_ENV,
  type EngineFactory,
  type EngineImplementation,
} from './index';
import { DefaultWorkspaceLayout, createWorkspaceLayout } from './workspace-layout';
import type { WorkerEngineKind } from './types';

describe('resolveWorkerEngine（纯决策）', () => {
  it('缺省（undefined）→ opencode', () => {
    expect(resolveWorkerEngine(undefined)).toBe('opencode');
  });

  it('空串 → opencode（部署脚本常留空变量）', () => {
    expect(resolveWorkerEngine('')).toBe('opencode');
    expect(resolveWorkerEngine('   ')).toBe('opencode');
  });

  it('显式取值 → 对应引擎', () => {
    expect(resolveWorkerEngine('opencode')).toBe('opencode');
    expect(resolveWorkerEngine('dsh')).toBe('dsh');
  });

  it('大小写不敏感（部署脚本常写 DSH）', () => {
    expect(resolveWorkerEngine('DSH')).toBe('dsh');
    expect(resolveWorkerEngine(' OpenCode ')).toBe('opencode');
  });

  it('未知值 → 响亮失败（不静默回落 opencode）', () => {
    expect(() => resolveWorkerEngine('claude-code')).toThrow(/不支持的 WORKER_ENGINE/);
    expect(() => resolveWorkerEngine('claude-code')).toThrow(/opencode \/ dsh/);
  });

  it('错误文案带上原始值（排查时知道配了什么）', () => {
    expect(() => resolveWorkerEngine('xxx')).toThrow(/\"xxx\"/);
    expect(unsupportedEngineMessage('xxx')).toContain('"xxx"');
  });

  it('默认值与支持集一致', () => {
    expect(SUPPORTED_ENGINES).toContain(DEFAULT_WORKER_ENGINE);
    expect(DEFAULT_WORKER_ENGINE).toBe('opencode');
  });
});

describe('resolveWorkerEngineFromEnv', () => {
  it('读 WORKER_ENGINE 环境变量', () => {
    expect(resolveWorkerEngineFromEnv({ [WORKER_ENGINE_ENV]: 'dsh' } as NodeJS.ProcessEnv)).toBe('dsh');
  });

  it('未设置 → 默认引擎', () => {
    expect(resolveWorkerEngineFromEnv({} as NodeJS.ProcessEnv)).toBe('opencode');
  });

  it('未知值 → 抛错', () => {
    expect(() => resolveWorkerEngineFromEnv({ [WORKER_ENGINE_ENV]: 'nope' } as NodeJS.ProcessEnv)).toThrow(
      /不支持的 WORKER_ENGINE/,
    );
  });
});

describe('createEngine（工厂校验）', () => {
  const stub = (kind: WorkerEngineKind): EngineImplementation =>
    ({
      kind,
      runtime: {} as EngineImplementation['runtime'],
      injector: {} as EngineImplementation['injector'],
      credentials: {} as EngineImplementation['credentials'],
      layout: createWorkspaceLayout('/tmp/x'),
    }) as EngineImplementation;

  it('注入的工厂被调用并返回实现', () => {
    const factory: EngineFactory = (kind) => stub(kind);
    const impl = createEngine('opencode', {}, factory);
    expect(impl.kind).toBe('opencode');
  });

  it('工厂返回的 kind 与请求不一致 → 响亮失败（防配错引擎）', () => {
    const factory: EngineFactory = () => stub('dsh');
    expect(() => createEngine('opencode', {}, factory)).toThrow(/不一致/);
  });

  it('P2：dsh 已登记真实实现（不再报"未登记"）', () => {
    const impl = createEngine('dsh');
    expect(impl.kind).toBe('dsh');
    expect(impl.runtime.kind).toBe('dsh');
    expect(impl.injector.kind).toBe('dsh');
    expect(impl.credentials.kind).toBe('dsh');
    expect(impl.layout.plansDir).toContain('.vteam');
  });

  it('opencode 缺 serve 选项 → 明确报错（不构造半个引擎）', () => {
    expect(() => createEngine('opencode')).toThrow(/缺少 serve 选项/);
  });
});

describe('DefaultWorkspaceLayout（vteam 资产目录解耦）', () => {
  it('目录布局固定为 .vteam 下的子目录（引擎无关）', () => {
    const layout = createWorkspaceLayout('/work/demo');
    expect(layout.vteamRoot).toBe('/work/demo/.vteam');
    expect(layout.plansDir).toBe('/work/demo/.vteam/plans');
    expect(layout.systemHandoffDir).toBe('/work/demo/.vteam/system-handoff');
    expect(layout.skillsSourceDir).toBe('/work/demo/.vteam/skills');
  });

  it('既有 .opencode/plans 作为兼容回落路径保留', () => {
    const layout = createWorkspaceLayout('/work/demo');
    expect(layout.legacyPlansPath).toBe('/work/demo/.opencode/plans');
  });

  it('新布局目录不存在且无 legacy 目录 → 返回新布局路径（按空目录处理）', () => {
    const layout = new DefaultWorkspaceLayout('/definitely-not-exists-xyz');
    expect(layout.resolvePlansDir()).toBe('/definitely-not-exists-xyz/.vteam/plans');
  });

  it('新布局目录存在 → 优先新布局', () => {
    // 用真实存在的工程目录构造（其 .vteam/plans 由测试创建）
    const fs = require('node:fs') as typeof import('node:fs');
    const base = fs.mkdtempSync('/tmp/layout-test-');
    fs.mkdirSync(`${base}/.vteam/plans`, { recursive: true });
    const layout = createWorkspaceLayout(base);
    expect(layout.resolvePlansDir()).toBe(`${base}/.vteam/plans`);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('仅 legacy 目录存在 → 回落 legacy（老工作目录继续可用）', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const base = fs.mkdtempSync('/tmp/layout-legacy-');
    fs.mkdirSync(`${base}/.opencode/plans`, { recursive: true });
    const layout = createWorkspaceLayout(base);
    expect(layout.resolvePlansDir()).toBe(`${base}/.opencode/plans`);
    fs.rmSync(base, { recursive: true, force: true });
  });
});
