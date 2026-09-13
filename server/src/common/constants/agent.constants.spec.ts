import {
  buildEditPermission,
  buildModelSeedRows,
  buildReadPermission,
  ROLE_BOUNDARIES,
  STATIC_AVAILABLE_MODELS,
  TEMPLATE_DEFAULT_MODELS,
  VTEAM_GIT_TOOL_NAMES,
  VTEAM_MCP_TOOL_NAMES,
  type VteamAgentName,
} from './agent.constants';

const ROLE_NAMES: VteamAgentName[] = [
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-plan',
];

const COORDINATION_ROLES = [
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
];

// 复刻 opencode `Wildcard.match`：先转义 regex 特殊字符（不含 * ?），再 *→.*、?→.，锚定 ^...$。
function wildcardMatch(input: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(input);
}

describe('模型目录 seed 预置（改为动态：静态目录清空，防空目录假数据回归）', () => {
  it('STATIC_AVAILABLE_MODELS 已清空（模型改为 worker 动态上报合并）', () => {
    expect(STATIC_AVAILABLE_MODELS).toHaveLength(0);
  });

  it('buildModelSeedRows 空目录返回空数组（seed 不预置任何静态模型）', () => {
    expect(buildModelSeedRows()).toEqual([]);
  });

  it('TEMPLATE_DEFAULT_MODELS 已清空（seed 落 null，由 worker 上报动态目录选择）', () => {
    expect(TEMPLATE_DEFAULT_MODELS).toEqual({});
  });
});

describe('ROLE_BOUNDARIES — 角色边界映射（agent 名 + 真实工具名）', () => {
  it('6 个 opencode agent 名 key 齐全（5 角色 + vteam-plan）', () => {
    expect(Object.keys(ROLE_BOUNDARIES).sort()).toEqual([...ROLE_NAMES].sort());
    expect(Object.keys(ROLE_BOUNDARIES)).toHaveLength(6);
  });

  it('toolAllows 的 MCP 键必须带 vteam_ 前缀（禁止裸 MCP 名）', () => {
    for (const name of ROLE_NAMES) {
      for (const tool of Object.keys(ROLE_BOUNDARIES[name].toolAllows)) {
        if (tool.startsWith('git_')) continue;
        expect(VTEAM_MCP_TOOL_NAMES).toContain(tool);
        expect(tool).toMatch(/^vteam_/);
      }
    }
  });

  it('toolAllows 的 git 键必须是 GIT_TOOLS 子集（自定义命名空间用注入 action 名）', () => {
    for (const name of ROLE_NAMES) {
      for (const tool of Object.keys(ROLE_BOUNDARIES[name].toolAllows)) {
        if (!tool.startsWith('git_')) continue;
        expect(VTEAM_GIT_TOOL_NAMES).toContain(tool);
      }
    }
  });

  it('mcpDenies = 全部 MCP 工具中未列入 toolAllows 者，且全为 vteam_ 真实名', () => {
    expect(VTEAM_MCP_TOOL_NAMES).toHaveLength(22);
    for (const mcp of VTEAM_MCP_TOOL_NAMES) expect(mcp).toMatch(/^vteam_/);
    for (const name of ROLE_NAMES) {
      const { toolAllows, mcpDenies } = ROLE_BOUNDARIES[name];
      const allowedMcp = Object.keys(toolAllows).filter((t) =>
        VTEAM_MCP_TOOL_NAMES.includes(t),
      );
      const expectedDenies = VTEAM_MCP_TOOL_NAMES.filter(
        (mcp) => !allowedMcp.includes(mcp),
      );
      expect([...mcpDenies].sort()).toEqual(expectedDenies.sort());
      for (const denied of mcpDenies) expect(denied).toMatch(/^vteam_/);
    }
  });

  it('writeGlobs 使用根无关通用形式且不含绝对路径', () => {
    for (const name of ROLE_NAMES) {
      for (const glob of ROLE_BOUNDARIES[name].writeGlobs) {
        expect(glob.startsWith('/')).toBe(false);
        expect(glob).toMatch(/^\*\*tasks\/\*/);
      }
    }
  });

  it('readGlobs 统一为 ["*"]（= {"*":"allow"}）', () => {
    for (const name of ROLE_NAMES) {
      expect(ROLE_BOUNDARIES[name].readGlobs).toEqual(['*']);
    }
    expect(buildReadPermission()).toEqual({ '*': 'allow' });
  });

  it('handoffTo 目标 ⊆ 5 协作角色，且无 UI 设计目标', () => {
    for (const name of ROLE_NAMES) {
      const targets = Object.values(ROLE_BOUNDARIES[name].handoffTo);
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(COORDINATION_ROLES).toContain(target);
        expect(target).not.toMatch(/ui|designer/i);
      }
    }
  });

  it('buildEditPermission 生成 {"*":"deny", ...writeGlobs:"allow"}', () => {
    const product = ROLE_BOUNDARIES['vteam-product'];
    const edit = buildEditPermission(product.writeGlobs);
    expect(edit).toEqual({
      '*': 'deny',
      '**tasks/*/prototypes/**': 'allow',
      '**tasks/*/docs/**': 'allow',
    });
    expect(buildEditPermission([])).toEqual({ '*': 'deny' });
  });

  it('通用根无关 glob 同时命中省略基址与带 worktree 前缀两种相对路径', () => {
    const cases: Array<[string, string]> = [
      ['**tasks/*/prototypes/**', 'prototypes'],
      ['**tasks/*/docs/**', 'docs'],
      ['**tasks/*/tests/**', 'tests'],
      ['**tasks/*/**', 'src'],
    ];
    for (const [glob, subdir] of cases) {
      expect(wildcardMatch(`tasks/t_1/${subdir}/x`, glob)).toBe(true);
      expect(wildcardMatch(`data/vteam-worker/tasks/t_1/${subdir}/x`, glob)).toBe(
        true,
      );
    }
    expect(wildcardMatch('tasks/t_1/prototypes/x', '**tasks/*/docs/**')).toBe(
      false,
    );
  });

  it('Permission matrix 精确值（层①/层② 单一口径）', () => {
    expect(ROLE_BOUNDARIES['vteam-product'].bashEffect).toBe('deny');
    expect(ROLE_BOUNDARIES['vteam-architect'].bashEffect).toBe('ask');
    expect(ROLE_BOUNDARIES['vteam-developer'].bashEffect).toBe('ask');
    expect(ROLE_BOUNDARIES['vteam-tester'].bashEffect).toBe('ask');
    expect(ROLE_BOUNDARIES['vteam-project_manager'].bashEffect).toBe('deny');
    expect(ROLE_BOUNDARIES['vteam-plan'].bashEffect).toBe('deny');

    expect(
      buildEditPermission(ROLE_BOUNDARIES['vteam-architect'].writeGlobs),
    ).toEqual({ '*': 'deny', '**tasks/*/docs/**': 'allow' });
    expect(
      buildEditPermission(ROLE_BOUNDARIES['vteam-developer'].writeGlobs),
    ).toEqual({ '*': 'deny', '**tasks/*/**': 'allow' });
    expect(
      buildEditPermission(ROLE_BOUNDARIES['vteam-tester'].writeGlobs),
    ).toEqual({
      '*': 'deny',
      '**tasks/*/tests/**': 'allow',
      '**tasks/*/docs/**': 'allow',
    });
    expect(
      buildEditPermission(ROLE_BOUNDARIES['vteam-project_manager'].writeGlobs),
    ).toEqual({ '*': 'deny' });
    expect(
      buildEditPermission(ROLE_BOUNDARIES['vteam-plan'].writeGlobs),
    ).toEqual({ '*': 'deny' });

    expect(ROLE_BOUNDARIES['vteam-plan'].toolAllows).toEqual({
      vteam_task_context: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
    });
    for (const name of ROLE_NAMES) {
      expect(Object.keys(ROLE_BOUNDARIES[name].toolAllows)).not.toContain(
        'vteam_task_transition',
      );
      expect(Object.keys(ROLE_BOUNDARIES[name].toolAllows)).not.toContain(
        'vteam_question_confirm',
      );
      expect(Object.keys(ROLE_BOUNDARIES[name].toolAllows)).not.toContain(
        'execute',
      );
      expect(Object.keys(ROLE_BOUNDARIES[name].toolAllows)).not.toContain(
        'task',
      );
    }
  });
});
