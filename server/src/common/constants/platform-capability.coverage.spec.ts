import {
  VTEAM_MCP_TOOL_NAMES,
} from './agent.constants';
import {
  buildCapabilityMatrixFromTools,
  buildFactoryCapabilityMatrix,
  capabilityKeyForTool,
  capabilityMatrixToToolStates,
  isCapabilityGranted,
  isPlatformCapabilityKey,
  PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITY_KEYS,
} from './platform-capability.constants';

/**
 * 能力目录漂移守卫（2026-09-21 capability model）。
 *
 * 目录是服务端授权的单一口径：每个 `VTEAM_MCP_TOOL_NAMES` 工具必须**恰属一个**能力点，
 * 否则工具调用会命中 unknown 面（fail-closed 拒绝）或能力点口径分裂。本 spec 在编译期
 * 之后、运行时之前把这类漂移变成红灯。
 */
describe('platform capability catalogue coverage', () => {
  it('每个能力点键唯一、格式合法（ASCII 点分或单段）', () => {
    const keys = PLATFORM_CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
    }
    expect(PLATFORM_CAPABILITY_KEYS).toEqual(keys);
  });

  it('目录覆盖 VTEAM_MCP_TOOL_NAMES 全 28 项，且每项恰属一个能力点', () => {
    const owner = new Map<string, string>();
    for (const capability of PLATFORM_CAPABILITIES) {
      for (const tool of capability.tools) {
        expect(owner.has(tool)).toBe(false);
        owner.set(tool, capability.key);
      }
    }
    expect([...owner.keys()].sort()).toEqual([...VTEAM_MCP_TOOL_NAMES].sort());
    for (const tool of VTEAM_MCP_TOOL_NAMES) {
      expect(capabilityKeyForTool(tool)).toBe(owner.get(tool));
    }
  });

  it('未知工具映射为 null（unknown 面 fail-closed 的依据）', () => {
    expect(capabilityKeyForTool('vteam_member_remove')).toBeNull();
    expect(capabilityKeyForTool('vteam_plan_mode')).toBeNull();
    expect(capabilityKeyForTool('not_a_tool')).toBeNull();
  });

  it('出厂矩阵：defaultDeny ⇒ false，其余 ⇒ true；缺失键语义为允许', () => {
    const factory = buildFactoryCapabilityMatrix();
    for (const capability of PLATFORM_CAPABILITIES) {
      expect(factory[capability.key]).toBe(!capability.defaultDeny);
    }
    // default-allow 证明：空矩阵/缺失键 ⇒ granted；显式 false ⇒ 不 granted。
    expect(isCapabilityGranted({}, 'task.create')).toBe(true);
    expect(isCapabilityGranted(null, 'task.create')).toBe(true);
    expect(isCapabilityGranted({ 'task.create': false }, 'task.create')).toBe(
      false,
    );
    expect(isCapabilityGranted({ 'task.create': true }, 'task.create')).toBe(true);
  });

  it('全组工具放行才授予能力点（保守映射，不放大授权）', () => {
    const issueTools = PLATFORM_CAPABILITIES.find(
      (c) => c.key === 'issue.manage',
    )!.tools;
    const onlyFirst = buildCapabilityMatrixFromTools({
      [issueTools[0]]: 'allow',
    });
    expect(onlyFirst['issue.manage']).toBe(false);
    const all = buildCapabilityMatrixFromTools(
      Object.fromEntries(issueTools.map((t) => [t, 'allow'])),
    );
    expect(all['issue.manage']).toBe(true);
    // ask 与 allow 同视为放行（与 worker guard 三态语义一致）。
    const asked = buildCapabilityMatrixFromTools(
      Object.fromEntries(issueTools.map((t) => [t, 'ask'])),
    );
    expect(asked['issue.manage']).toBe(true);
  });

  it('能力矩阵 → 工具三态表：缺失键/true ⇒ allow，false ⇒ deny', () => {
    const states = capabilityMatrixToToolStates({ 'doc.read': false });
    expect(states['vteam_doclib']).toBe('deny');
    const empty = capabilityMatrixToToolStates({});
    expect(empty['vteam_doclib']).toBe('allow');
    expect(empty['vteam_task_create']).toBe('allow');
    // 目录内每个工具都有映射。
    for (const tool of VTEAM_MCP_TOOL_NAMES) {
      expect(empty[tool]).toBe('allow');
    }
  });

  it('isPlatformCapabilityKey：目录内 true，目录外 false', () => {
    expect(isPlatformCapabilityKey('task.create')).toBe(true);
    expect(isPlatformCapabilityKey('issue.manage')).toBe(true);
    expect(isPlatformCapabilityKey('nope')).toBe(false);
    expect(isPlatformCapabilityKey('task.create.extra')).toBe(false);
  });
});
