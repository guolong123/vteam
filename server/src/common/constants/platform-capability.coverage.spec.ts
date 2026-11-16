import {
  VTEAM_BROWSER_TOOL_NAMES,
  VTEAM_GIT_TOOL_NAMES,
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

  it('目录只覆盖 mcp 命名空间，且每项恰属一个能力点（31 点 ↔ 34 工具）', () => {
    // git_* / browser 已于 2026-09-30 整组退役：它们是 worker 注入的本地工具、不经
    // platform-mcp，服务端能力门结构上拦不到 ⇒ 目录不再登记（详见常量文件末退役记录）。
    // 补齐它们需要打通 agent 权限投影 + 重新基线化 `/agent-policies`，属独立后续工作。
    // 在此之前这 8 个工具无门（见下方那条 spec 的显式记录）。
    expect(PLATFORM_CAPABILITIES).toHaveLength(31);
    const owner = new Map<string, string>();
    let toolSum = 0;
    for (const capability of PLATFORM_CAPABILITIES) {
      toolSum += capability.tools.length;
      for (const tool of capability.tools) {
        expect(owner.has(tool)).toBe(false);
        owner.set(tool, capability.key);
      }
    }
    // 工具总数 32 = VTEAM_MCP_TOOL_NAMES 全量：git/browser 那 8 个已退役，故 mcp 侧
    // 目录现在恰好覆盖 VTEAM_MCP_TOOL_NAMES 全部 32 项（此前 29 点覆盖其中 32 工具 +
    // 另 8 个由退役三键覆盖）。
    expect(VTEAM_MCP_TOOL_NAMES).toHaveLength(34);
    expect(toolSum).toBe(34);
    expect([...owner.keys()].sort()).toEqual([...VTEAM_MCP_TOOL_NAMES].sort());
    for (const tool of VTEAM_MCP_TOOL_NAMES) {
      expect(capabilityKeyForTool(tool)).toBe(owner.get(tool));
    }
    // 仍覆盖多工具的：task.complete（完工/定稿/确认）+ hook.manage（register + cancel）。
    const multiTool = PLATFORM_CAPABILITIES.filter((c) => c.tools.length > 1);
    expect(multiTool.map((c) => c.key)).toEqual([
      'task.complete',
      'hook.manage',
    ]);
    expect(multiTool[0]?.tools).toHaveLength(3);
    expect(multiTool[1]?.tools).toHaveLength(2);
    // 已拆分的组键、以及已退役的 git/browser 键，均不再是合法能力点键。
    expect(isPlatformCapabilityKey('issue.manage')).toBe(false);
    expect(isPlatformCapabilityKey('memory.manage')).toBe(false);
    for (const retired of ['git.repo.read', 'git.repo.write', 'web.browse']) {
      expect(isPlatformCapabilityKey(retired)).toBe(false);
    }
  });

  it('退役的 git_* / browser 既不在目录、也不被任何岗位能力点治理（执行点待后续 PR）', () => {
    // 已知且**有意**的现状：这三个能力点退役后，这 8 个 worker 本地工具失去了唯一的
    // 管控入口（它们不经 platform-mcp，服务端能力门结构上拦不到），当前靠 opencode
    // 侧默认放行。补齐需要打通 agent 权限投影（NATIVE_PERMISSION_KEYS）+ 重新基线化
    // `/agent-policies` 字节基线，属独立后续工作。
    // 本断言锁住「确实无门」这个事实，避免有人误以为它们受控。
    for (const tool of [...VTEAM_GIT_TOOL_NAMES, ...VTEAM_BROWSER_TOOL_NAMES]) {
      expect(capabilityKeyForTool(tool)).toBeNull();
    }
  });

  it('secret_command：vteam_secret_command → secret.command，defaultDeny=false 且出厂 true', () => {
    expect(capabilityKeyForTool('vteam_secret_command')).toBe('secret.command');
    const capability = PLATFORM_CAPABILITIES.find(
      (c) => c.key === 'secret.command',
    );
    expect(capability).toBeDefined();
    expect(capability?.tools).toEqual(['vteam_secret_command']);
    expect(capability?.defaultDeny).toBe(false);
    expect(buildFactoryCapabilityMatrix()['secret.command']).toBe(true);
    expect(isCapabilityGranted({}, 'secret.command')).toBe(true);
    expect(
      isCapabilityGranted({ 'secret.command': false }, 'secret.command'),
    ).toBe(false);
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
    expect(isCapabilityGranted({ 'task.create': true }, 'task.create')).toBe(
      true,
    );
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
