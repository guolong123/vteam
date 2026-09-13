import {
  AgentPoliciesGuard,
  AgentPolicyDefinition,
  buildAgentDefinitions,
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

function guardFor(names: string[]): AgentPoliciesGuard {
  return {
    enabled: true,
    roles: Object.fromEntries(
      names.map((name) => [
        name,
        {
          permission: { edit: { '*': 'deny' }, task: 'deny' },
          tools: { vteam_task_context: 'allow' },
          bashDeny: ['rm'],
          correction: { scopeSummary: `${name} scope` },
        },
      ]),
    ),
  };
}

describe('buildAgentDefinitions', () => {
  it('生成 opencode agent 节（key=agent 名，条目含 description/mode/permission）', () => {
    const section = buildAgentDefinitions(
      [agent('vteam-developer'), agent('vteam-plan')],
      guardFor(['vteam-developer', 'vteam-plan']),
    );
    expect(Object.keys(section).sort()).toEqual(['vteam-developer', 'vteam-plan']);
    expect(section['vteam-developer']).toEqual({
      description: 'vteam-developer scope',
      mode: 'primary',
      permission: { edit: { '*': 'deny' }, task: 'deny' },
    });
  });

  it('空 agents → 空节（停用路径）', () => {
    expect(buildAgentDefinitions([], { enabled: true, roles: {} })).toEqual({});
  });

  it('guard 缺失 / enabled!==true 时跳过交叉校验（中性化路径不被阻断）', () => {
    expect(buildAgentDefinitions([agent('vteam-developer')])).toEqual({
      'vteam-developer': expect.objectContaining({ mode: 'primary' }),
    });
    expect(
      buildAgentDefinitions([agent('vteam-developer')], {
        enabled: false,
        roles: {},
      }),
    ).toEqual({ 'vteam-developer': expect.objectContaining({ mode: 'primary' }) });
  });

  it('未知字段显式拒绝（agent 多余键 / role 多余键均抛错）', () => {
    expect(() =>
      buildAgentDefinitions([agent('vteam-a', { bogus: 1 })], guardFor(['vteam-a'])),
    ).toThrow('未知字段: bogus');
    const badGuard = guardFor(['vteam-a']);
    (badGuard.roles['vteam-a'] as unknown as Record<string, unknown>).bogus = 1;
    expect(() => buildAgentDefinitions([agent('vteam-a')], badGuard)).toThrow(
      '未知字段: bogus',
    );
  });

  it('permission 含 write 键 / mode 非 primary / 重名 / 非数组一律抛错', () => {
    const withWrite = agent('vteam-a');
    (withWrite.permission as Record<string, unknown>).write = { '*': 'deny' };
    expect(() => buildAgentDefinitions([withWrite], guardFor(['vteam-a']))).toThrow(
      "不得含 'write' 键",
    );
    const badMode = agent('vteam-a');
    (badMode as unknown as Record<string, unknown>).mode = 'subagent';
    expect(() => buildAgentDefinitions([badMode], guardFor(['vteam-a']))).toThrow(
      "仅支持 'primary'",
    );
    expect(() =>
      buildAgentDefinitions([agent('vteam-a'), agent('vteam-a')], guardFor(['vteam-a'])),
    ).toThrow('重复');
    expect(() =>
      buildAgentDefinitions('nope' as unknown as AgentPolicyDefinition[]),
    ).toThrow('必须为数组');
  });

  it('guard.enabled 下 agent 缺少角色条目 / 条目残缺即抛错（无角色名分支）', () => {
    expect(() => buildAgentDefinitions([agent('vteam-a')], guardFor([]))).toThrow(
      '缺少 guard 角色条目',
    );
    const badGuard = guardFor(['vteam-a']);
    delete (badGuard.roles['vteam-a'] as Partial<typeof badGuard.roles['vteam-a']>).tools;
    expect(() => buildAgentDefinitions([agent('vteam-a')], badGuard)).toThrow(
      'tools 非法',
    );
  });
});
