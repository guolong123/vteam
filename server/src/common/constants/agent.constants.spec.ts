import {
  buildEditPermission,
  buildModelSeedRows,
  buildReadPermission,
  planDirGlob,
  ROLE_BOUNDARIES,
  ROLE_SERVER_GATED_TOOLS,
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
  'vteam-librarian',
];

const COORDINATION_ROLES = [
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-plan',
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
  it('7 个 opencode agent 名 key 齐全（5 角色 + vteam-plan + vteam-librarian）', () => {
    expect(Object.keys(ROLE_BOUNDARIES).sort()).toEqual([...ROLE_NAMES].sort());
    expect(Object.keys(ROLE_BOUNDARIES)).toHaveLength(7);
  });

  it('toolAllows 的 MCP 键必须带 vteam_ 前缀（禁止裸 MCP 名；browser 例外，见下）', () => {
    for (const name of ROLE_NAMES) {
      for (const tool of Object.keys(ROLE_BOUNDARIES[name].toolAllows)) {
        if (tool.startsWith('git_')) continue;
        if (tool === 'browser') continue;
        expect(VTEAM_MCP_TOOL_NAMES).toContain(tool);
        expect(tool).toMatch(/^vteam_/);
      }
    }
  });

  it('browser 仅干活角色放行（项目经理除外）', () => {
    for (const name of ROLE_NAMES) {
      const has = Object.prototype.hasOwnProperty.call(
        ROLE_BOUNDARIES[name].toolAllows,
        'browser',
      );
      expect(has).toBe(name !== 'vteam-project_manager');
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

  /**
   * 曾由服务端按主实例身份 gate 的工具（server-gate-removal-tool-authority）。
   * 该概念已退休：`ROLE_SERVER_GATED_TOOLS` 恒为空，权限唯一来源 = 角色 `toolAllows`。
   * 本清单从**授权矩阵**派生（见 plan §(d)），不是旧常量——旧常量为空会使任何
   * `for (const gated of ROLE_SERVER_GATED_TOOLS)` 变成空转假绿，故此处显式列举。
   */
  const FORMERLY_GATED_TOOLS: readonly string[] = [
    'vteam_task_transition',
    'vteam_question_confirm',
    'vteam_task_create',
    'vteam_plan_complete',
    'vteam_team_add_member',
    'vteam_skill_create',
  ];

  /** 授权矩阵（plan §(d)）：每个 formerly-gated 工具被授予的角色集合。 */
  const GRANT_MATRIX: Record<string, readonly VteamAgentName[]> = {
    vteam_task_transition: ['vteam-product', 'vteam-project_manager'],
    vteam_task_create: ['vteam-product', 'vteam-project_manager'],
    vteam_team_add_member: ['vteam-product', 'vteam-project_manager'],
    vteam_question_confirm: ['vteam-product', 'vteam-project_manager'],
    vteam_plan_complete: ['vteam-plan', 'vteam-project_manager'],
    vteam_skill_create: ['vteam-project_manager'],
  };

  it('ROLE_SERVER_GATED_TOOLS 已退休为空（语义移交 worker guard allowlist，不再有服务端身份门）', () => {
    expect([...ROLE_SERVER_GATED_TOOLS]).toEqual([]);
    // 旧门控工具仍存在于 MCP 注册表，只是不再有“服务端专属”标记。
    for (const tool of FORMERLY_GATED_TOOLS) {
      expect(VTEAM_MCP_TOOL_NAMES).toContain(tool);
    }
  });

  it('mcpDenies = 全部 MCP 工具中未列入 toolAllows 者（无 server-gated 例外），且全为 vteam_ 真实名', () => {
    expect(VTEAM_MCP_TOOL_NAMES).toHaveLength(28);
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

  it('未获授权的 formerly-gated 工具一律进 mcpDenies（显式 deny，不再放行到服务端判定）', () => {
    // 非空转证明：清单 7 个 + 角色 7 个，断言数 > 0（旧循环因空常量恒 0 断言）。
    let assertions = 0;
    for (const tool of FORMERLY_GATED_TOOLS) {
      for (const name of ROLE_NAMES) {
        const granted = GRANT_MATRIX[tool].includes(name);
        const denied = ROLE_BOUNDARIES[name].mcpDenies.includes(tool);
        const allowed = Object.prototype.hasOwnProperty.call(
          ROLE_BOUNDARIES[name].toolAllows,
          tool,
        );
        expect(allowed).toBe(granted);
        expect(denied).toBe(!granted);
        assertions += 2;
      }
    }
    expect(assertions).toBe(FORMERLY_GATED_TOOLS.length * ROLE_NAMES.length * 2);
    expect(assertions).toBeGreaterThan(0);
  });

  it('mcpDenies ∪ toolAllows(MCP) 恰覆盖 VTEAM_MCP_TOOL_NAMES（二者互斥、无遗漏）', () => {
    for (const name of ROLE_NAMES) {
      const { toolAllows, mcpDenies } = ROLE_BOUNDARIES[name];
      const allowedMcp = new Set(
        Object.keys(toolAllows).filter((t) => VTEAM_MCP_TOOL_NAMES.includes(t)),
      );
      const denied = new Set(mcpDenies);
      for (const tool of allowedMcp) {
        expect(denied.has(tool)).toBe(false);
      }
      const union = new Set([...allowedMcp, ...denied]);
      expect([...union].sort()).toEqual([...VTEAM_MCP_TOOL_NAMES].sort());
    }
  });

  it('D4 按角色 allow 补齐（wecom_reply/channel_send/chat_history/doclib）', () => {
    const allowsOf = (name: VteamAgentName): ReadonlySet<string> =>
      new Set(Object.keys(ROLE_BOUNDARIES[name].toolAllows));
    for (const name of [
      'vteam-product',
      'vteam-architect',
      'vteam-developer',
      'vteam-tester',
      'vteam-project_manager',
    ] as const) {
      expect(allowsOf(name).has('vteam_wecom_reply')).toBe(true);
      expect(allowsOf(name).has('vteam_channel_send')).toBe(true);
    }
    expect(allowsOf('vteam-plan').has('vteam_chat_history')).toBe(true);
    expect(allowsOf('vteam-plan').has('vteam_wecom_reply')).toBe(true);
    expect(allowsOf('vteam-plan').has('vteam_channel_send')).toBe(false);
    expect(allowsOf('vteam-project_manager').has('vteam_chat_history')).toBe(
      true,
    );
    expect(allowsOf('vteam-developer').has('vteam_doclib')).toBe(true);
  });

  it('writeGlobs 使用根无关通用形式且不含绝对路径', () => {
    for (const name of ROLE_NAMES) {
      for (const glob of ROLE_BOUNDARIES[name].writeGlobs) {
        expect(glob.startsWith('/')).toBe(false);
        const isTaskGlob = /^\*\*tasks\/\*/.test(glob);
        const isPlansGlob = glob === planDirGlob();
        expect(isTaskGlob || isPlansGlob).toBe(true);
      }
    }
    expect(ROLE_BOUNDARIES['vteam-plan'].writeGlobs).toEqual([planDirGlob()]);
  });

  it('planDirGlob 命中 plans 子树、不命中仓库常规路径', () => {
    const glob = planDirGlob();
    expect(glob.startsWith('/')).toBe(false);
    expect(wildcardMatch('.opencode/plans/x.md', glob)).toBe(true);
    expect(wildcardMatch('data/vteam-worker/.opencode/plans/x.md', glob)).toBe(
      true,
    );
    expect(wildcardMatch('tasks/t_1/.opencode/plans/x.md', glob)).toBe(true);
    expect(wildcardMatch('src/a.ts', glob)).toBe(false);
    expect(wildcardMatch('tasks/t_1/code/x.ts', glob)).toBe(false);
  });

  it('readGlobs 统一为 ["*"]（= {"*":"allow"}）', () => {
    for (const name of ROLE_NAMES) {
      expect(ROLE_BOUNDARIES[name].readGlobs).toEqual(['*']);
    }
    expect(buildReadPermission()).toEqual({ '*': 'allow' });
  });

  it('handoffTo 目标 ⊆ 协作角色，且无 UI 设计目标', () => {
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
      expect(
        wildcardMatch(`data/vteam-worker/tasks/t_1/${subdir}/x`, glob),
      ).toBe(true);
    }
    expect(wildcardMatch('tasks/t_1/prototypes/x', '**tasks/*/docs/**')).toBe(
      false,
    );
  });

  it('Permission matrix 精确值（层①/层② 单一口径）', () => {
    expect(ROLE_BOUNDARIES['vteam-product'].bashEffect).toBe('allow');
    expect(ROLE_BOUNDARIES['vteam-architect'].bashEffect).toBe('allow');
    expect(ROLE_BOUNDARIES['vteam-developer'].bashEffect).toBe('allow');
    expect(ROLE_BOUNDARIES['vteam-tester'].bashEffect).toBe('allow');
    expect(ROLE_BOUNDARIES['vteam-project_manager'].bashEffect).toBe('deny');
    expect(ROLE_BOUNDARIES['vteam-plan'].bashEffect).toBe('allow');
    expect(ROLE_BOUNDARIES['vteam-librarian'].bashEffect).toBe('allow');

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
    ).toEqual({ '*': 'deny', [planDirGlob()]: 'allow' });

    expect(ROLE_BOUNDARIES['vteam-plan'].toolAllows).toEqual({
      vteam_task_context: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_chat_history: 'allow',
      vteam_wecom_reply: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_search: 'allow',
      vteam_plan_complete: 'allow',
      browser: 'allow',
    });
    expect(ROLE_BOUNDARIES['vteam-librarian'].toolAllows).toEqual({
      vteam_chat_history: 'allow',
      vteam_task_context: 'allow',
      vteam_doclib: 'allow',
      vteam_read_file: 'allow',
      vteam_memory_search: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_group_post: 'allow',
      vteam_git_repos_list: 'allow',
      git_clone: 'allow',
      git_pull: 'allow',
      git_fetch: 'allow',
      git_status: 'allow',
      git_diff: 'allow',
      git_log: 'allow',
      browser: 'allow',
    });
    // 反转旧断言：formerly-gated 工具按授权矩阵进/不进 toolAllows（不再一律不进）。
    for (const name of ROLE_NAMES) {
      for (const tool of FORMERLY_GATED_TOOLS) {
        const granted = GRANT_MATRIX[tool].includes(name);
        if (granted) {
          expect(ROLE_BOUNDARIES[name].toolAllows).toHaveProperty(
            tool,
            'allow',
          );
        } else {
          expect(ROLE_BOUNDARIES[name].toolAllows).not.toHaveProperty(tool);
        }
      }
      expect(Object.keys(ROLE_BOUNDARIES[name].toolAllows)).not.toContain(
        'execute',
      );
      expect(Object.keys(ROLE_BOUNDARIES[name].toolAllows)).not.toContain(
        'task',
      );
    }
  });
});
