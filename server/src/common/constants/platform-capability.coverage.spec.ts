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

  it('目录覆盖 VTEAM_MCP_TOOL_NAMES 全 31 项，且每项恰属一个能力点（28 点 ↔ 31 工具）', () => {
    expect(PLATFORM_CAPABILITIES).toHaveLength(28);
    expect(VTEAM_MCP_TOOL_NAMES).toHaveLength(31);
    const owner = new Map<string, string>();
    let toolSum = 0;
    for (const capability of PLATFORM_CAPABILITIES) {
      toolSum += capability.tools.length;
      for (const tool of capability.tools) {
        expect(owner.has(tool)).toBe(false);
        owner.set(tool, capability.key);
      }
    }
    expect(toolSum).toBe(31);
    expect([...owner.keys()].sort()).toEqual([...VTEAM_MCP_TOOL_NAMES].sort());
    for (const tool of VTEAM_MCP_TOOL_NAMES) {
      expect(capabilityKeyForTool(tool)).toBe(owner.get(tool));
    }
    // 拆分组能力点后仍覆盖多工具的：task.complete（完工/定稿/确认）+ hook.manage（register + cancel）。
    const multiTool = PLATFORM_CAPABILITIES.filter((c) => c.tools.length > 1);
    expect(multiTool.map((c) => c.key)).toEqual(['task.complete', 'hook.manage']);
    expect(multiTool[0]?.tools).toHaveLength(3);
    expect(multiTool[1]?.tools).toHaveLength(2);
    // 已拆分的组键不再是合法能力点键。
    expect(isPlatformCapabilityKey('issue.manage')).toBe(false);
    expect(isPlatformCapabilityKey('memory.manage')).toBe(false);
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

  it('全组工具放行才授予能力点（保守映射，不放大授权；现存唯一多工具点 hook.manage）', () => {
    const hookTools = PLATFORM_CAPABILITIES.find(
      (c) => c.key === 'hook.manage',
    )!.tools;
    const onlyFirst = buildCapabilityMatrixFromTools({
      [hookTools[0] as string]: 'allow',
    });
    expect(onlyFirst['hook.manage']).toBe(false);
    const all = buildCapabilityMatrixFromTools(
      Object.fromEntries(hookTools.map((t) => [t, 'allow'])),
    );
    expect(all['hook.manage']).toBe(true);
    // ask 与 allow 同视为放行（与 worker guard 三态语义一致）。
    const asked = buildCapabilityMatrixFromTools(
      Object.fromEntries(hookTools.map((t) => [t, 'ask'])),
    );
    expect(asked['hook.manage']).toBe(true);
    // 拆分后的单工具点退化为逐工具判定：该工具放行即授予，不存在组塌缩。
    const single = buildCapabilityMatrixFromTools({
      vteam_issue_create: 'allow',
    });
    expect(single['issue.create']).toBe(true);
    expect(single['issue.get']).toBe(false);
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
    expect(isPlatformCapabilityKey('issue.create')).toBe(true);
    expect(isPlatformCapabilityKey('memory.search')).toBe(true);
    expect(isPlatformCapabilityKey('nope')).toBe(false);
    expect(isPlatformCapabilityKey('task.create.extra')).toBe(false);
  });
});
