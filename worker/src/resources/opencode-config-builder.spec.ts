import {
  AgentPolicyDefinition,
  buildAgentDefinitions,
  buildPermissionRules,
} from './opencode-config-builder';

function agent(name: string, extra?: Record<string, unknown>): AgentPolicyDefinition {
  return {
    name,
    description: `${name} scope`,
    mode: 'primary',
    permission: { edit: { '*': 'deny' }, task: 'deny' },
    ...extra,
  } as AgentPolicyDefinition;
}

describe('buildAgentDefinitions', () => {
  it('生成 opencode **agents** 节（key=agent 名，条目含 description/mode/permissions）', () => {
    const section = buildAgentDefinitions([agent('vteam-developer'), agent('vteam-plan')]);
    expect(Object.keys(section).sort()).toEqual(['vteam-developer', 'vteam-plan']);
    expect(section['vteam-developer']).toEqual({
      description: 'vteam-developer scope',
      mode: 'primary',
      // v1 permission 对象 → v2 permissions[]（task → subagent；另补 external_directory ask）
      permissions: [
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'subagent', resource: '*', effect: 'deny' },
        { action: 'external_directory', resource: '*', effect: 'ask' },
      ],
    });
  });

  it('空 agents → 空节（停用路径）', () => {
    expect(buildAgentDefinitions([])).toEqual({});
  });

  it('未知字段显式拒绝（agent 多余键抛错）', () => {
    expect(() => buildAgentDefinitions([agent('vteam-a', { bogus: 1 })])).toThrow(
      '未知字段: bogus',
    );
  });

  it('mode:all 通过形状校验并原样透出（计划成员子 agent 可启动）', () => {
    const section = buildAgentDefinitions([agent('vteam-plan', { mode: 'all' })]);
    expect(section['vteam-plan']).toEqual({
      description: 'vteam-plan scope',
      mode: 'all',
      permissions: [
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'subagent', resource: '*', effect: 'deny' },
        { action: 'external_directory', resource: '*', effect: 'ask' },
      ],
    });
  });

  it("mode:'bogus' 仍抛错（仅允许 'primary' | 'all'）", () => {
    const badMode = agent('vteam-a');
    (badMode as unknown as Record<string, unknown>).mode = 'bogus';
    expect(() => buildAgentDefinitions([badMode])).toThrow("仅支持 'primary' | 'all'");
  });

  it('permission 含 write 键 / mode 非 primary / 重名 / 非数组一律抛错', () => {
    const withWrite = agent('vteam-a');
    (withWrite.permission as Record<string, unknown>).write = { '*': 'deny' };
    expect(() => buildAgentDefinitions([withWrite])).toThrow("不得含 'write' 键");
    const badMode = agent('vteam-a');
    (badMode as unknown as Record<string, unknown>).mode = 'subagent';
    expect(() => buildAgentDefinitions([badMode])).toThrow("仅支持 'primary'");
    expect(() => buildAgentDefinitions([agent('vteam-a'), agent('vteam-a')])).toThrow(
      '重复',
    );
    expect(() => buildAgentDefinitions('nope' as unknown as AgentPolicyDefinition[])).toThrow(
      '必须为数组',
    );
  });

  // ───────────────────────── T15：v2 原生形状 ─────────────────────────

  it('**回归闸门**：产出条目**绝不含** `prompt` 键（v2 原生 agents 节里 prompt 会被静默丢弃）', () => {
    const section = buildAgentDefinitions([
      agent('vteam-a'),
      agent('vteam-b', { prompt: '你是 vteam-b' }),
    ]);
    for (const entry of Object.values(section)) {
      expect(Object.keys(entry)).not.toContain('prompt');
      expect(entry).not.toHaveProperty('prompt');
    }
    // v1 的 permission 键也不允许出现在 v2 条目里
    for (const entry of Object.values(section)) {
      expect(Object.keys(entry)).not.toContain('permission');
    }
  });

  it('可选静态角色提示 → 写进 **system**（v2 原生键），不是 prompt', () => {
    const section = buildAgentDefinitions([agent('vteam-a', { prompt: '你是 vteam-a' })]);
    expect(section['vteam-a'].system).toBe('你是 vteam-a');
    expect(section['vteam-a']).not.toHaveProperty('prompt');
  });

  it('无 prompt / 空白 prompt → 不写 system 键（"有没有角色提示"必须可判别）', () => {
    const section = buildAgentDefinitions([agent('vteam-a'), agent('vteam-b', { prompt: '   ' })]);
    expect(section['vteam-a']).not.toHaveProperty('system');
    expect(section['vteam-b']).not.toHaveProperty('system');
  });

  it('prompt 非字符串 → 抛错（控制面漂移不静默透传）', () => {
    expect(() => buildAgentDefinitions([agent('vteam-a', { prompt: 42 })])).toThrow(
      'prompt 非法',
    );
  });

  it('权限翻译：bash→shell、task→subagent、edit/read 同名；glob 展开成逐条规则且**保留键序**', () => {
    const section = buildAgentDefinitions([
      agent('vteam-a', {
        permission: {
          edit: { '*': 'deny', '**/tasks/*/docs/**': 'allow' },
          read: { '*': 'allow' },
          bash: 'ask',
          task: 'deny',
        },
      }),
    ]);
    expect(section['vteam-a'].permissions).toEqual([
      // v1 map 的键序原样保留（v2 用 findLast：最后一条命中者生效 ⇒ 具体的 allow 必须在 deny 之后）
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '**/tasks/*/docs/**', effect: 'allow' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
    ]);
  });

  it('权限效果非法 / 值形态非法 → 抛错（不静默产出非法 v2 规则）', () => {
    expect(() =>
      buildAgentDefinitions([agent('vteam-a', { permission: { bash: 'maybe' } })]),
    ).toThrow("效果必须是 'allow' | 'ask' | 'deny'");
    expect(() =>
      buildAgentDefinitions([agent('vteam-a', { permission: { bash: 7 } })]),
    ).toThrow('值必须是三态字符串');
  });

  it('**写闸门唯一性**：`write` / `patch` 键一律拒绝（v2 已并入 edit，认不出 = 规则不命中）', () => {
    expect(() =>
      buildAgentDefinitions([agent('vteam-a', { permission: { write: { '*': 'deny' } } })]),
    ).toThrow("不得含 'write' 键");
    expect(() =>
      buildAgentDefinitions([agent('vteam-a', { permission: { patch: 'deny' } })]),
    ).toThrow("不得含 'patch' 键");
  });

  it('**v1 语义保持**：显式补 external_directory 的 ask 规则（v2 默认放行项目外路径）', () => {
    const section = buildAgentDefinitions([agent('vteam-a')]);
    expect(section['vteam-a'].permissions).toContainEqual({
      action: 'external_directory',
      resource: '*',
      effect: 'ask',
    });
  });

  it('控制面已显式声明 external_directory → 不重复补（以它为准）', () => {
    const section = buildAgentDefinitions([
      agent('vteam-a', { permission: { external_directory: 'deny' } }),
    ]);
    const rules = section['vteam-a'].permissions.filter(
      (rule) => rule.action === 'external_directory',
    );
    expect(rules).toEqual([{ action: 'external_directory', resource: '*', effect: 'deny' }]);
  });
});

describe('buildPermissionRules（v1 权限对象 → v2 规则数组）', () => {
  it('三态字符串 → resource:"*" 的一条规则；glob 映射 → 逐 glob 一条', () => {
    expect(buildPermissionRules({ bash: 'allow' })).toEqual([
      { action: 'shell', resource: '*', effect: 'allow' },
    ]);
    expect(buildPermissionRules({ edit: { '*': 'deny', 'a/**': 'allow' } })).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'edit', resource: 'a/**', effect: 'allow' },
    ]);
  });

  it('非对象 → 抛错；空 action 键 → 抛错', () => {
    expect(() => buildPermissionRules('nope' as unknown as Record<string, unknown>)).toThrow(
      '必须为对象',
    );
    expect(() => buildPermissionRules({ '': 'allow' })).toThrow('空 action 键');
  });
});
