import { AgentPolicyDefinition, buildAgentDefinitions } from './opencode-config-builder';

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
  it('生成 opencode agent 节（key=agent 名，条目含 description/mode/permission）', () => {
    const section = buildAgentDefinitions([agent('vteam-developer'), agent('vteam-plan')]);
    expect(Object.keys(section).sort()).toEqual(['vteam-developer', 'vteam-plan']);
    expect(section['vteam-developer']).toEqual({
      description: 'vteam-developer scope',
      mode: 'primary',
      permission: { edit: { '*': 'deny' }, task: 'deny' },
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
      permission: { edit: { '*': 'deny' }, task: 'deny' },
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
});
