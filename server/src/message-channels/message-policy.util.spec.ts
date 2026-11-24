import {
  executeMessagePolicy,
  loadMessagePolicy,
  runMessagePolicy,
} from './message-policy.util';

describe('message-policy.util', () => {
  const channel = {
    config: {
      messagePolicies: {
        issue_hooks: {
          enabled: true,
          defaultAction: 'discard',
          filters: [
            {
              id: 'r1',
              name: '只处理打开的 Issue',
              logic: 'and',
              conditions: [
                { path: 'issue.state', op: 'eq', value: 'open' },
                { path: 'action', op: 'eq', value: 'opened' },
              ],
              action: 'deliver',
            },
            {
              id: 'r2',
              name: '丢弃机器人创建的 Issue',
              logic: 'and',
              conditions: [{ path: 'sender.type', op: 'eq', value: 'Bot' }],
              action: 'discard',
            },
          ],
          template: {
            variables: [
              { name: 'title', path: 'issue.title', fallback: '(无标题)' },
              { name: 'repo', path: 'repository.full_name', fallback: '-' },
              { name: 'author', path: 'sender.login', fallback: '未知' },
            ],
            content: '🐛 {{title}} ({{repo}}) 由 {{author}} 创建',
          },
          targets: {
            mode: 'teams',
            teams: ['team-a', 'team-b'],
            route: 'main',
          },
        },
        push_hooks: {
          enabled: true,
          defaultAction: 'deliver',
          filters: [],
          template: {
            variables: [
              { name: 'msg', path: 'head_commit.message', fallback: '' },
            ],
            content: '📦 {{msg}}',
          },
          targets: { mode: 'member', member: 'm1', route: 'mention' },
        },
      },
    },
  };

  it('loadMessagePolicy 返回事件策略（大小写不敏感）', () => {
    const p = loadMessagePolicy(channel, 'issue_hooks');
    expect(p).toBeTruthy();
    expect(p?.filters.length).toBe(2);
    expect(loadMessagePolicy(channel, 'ISSUE_HOOKS')).toBeTruthy();
  });

  it('loadMessagePolicy 未配置/策略关闭时返回 null', () => {
    expect(loadMessagePolicy(channel, 'unknown_event')).toBeNull();
    expect(loadMessagePolicy(null, 'issue_hooks')).toBeNull();
    expect(
      loadMessagePolicy(
        { config: { messagePolicies: { issue_hooks: { enabled: false } } } },
        'issue_hooks',
      ),
    ).toBeNull();
    // 防御：filters 或 variables 不是数组时返回 null
    expect(
      loadMessagePolicy(
        { config: { messagePolicies: { bad: { filters: 'x' } } } },
        'bad',
      ),
    ).toBeNull();
  });

  it('executeMessagePolicy 命中放行规则 → 提取变量并渲染正文 + 投递目标', () => {
    const data = {
      action: 'opened',
      issue: { title: '修复登录超时', state: 'open' },
      repository: { full_name: 'acme/web' },
      sender: { login: 'alice', type: 'User' },
    };
    const r = runMessagePolicy(channel, 'issue_hooks', data);
    expect(r).toBeTruthy();
    expect(r!.action).toBe('deliver');
    expect(r!.skip).toBeUndefined();
    expect(r!.matchedRule?.id).toBe('r1');
    expect(r!.variables.title).toBe('修复登录超时');
    expect(r!.variables.repo).toBe('acme/web');
    expect(r!.variables.author).toBe('alice');
    expect(r!.rendered).toBe('🐛 修复登录超时 (acme/web) 由 alice 创建');
    expect(r!.deliveryTarget).toEqual({
      mode: 'teams',
      teams: ['team-a', 'team-b'],
      route: 'main',
    });
  });

  it('executeMessagePolicy 变量缺失回退 fallback', () => {
    const data = { action: 'opened', issue: { state: 'open' }, sender: {} }; // title/repo/author 缺失
    const r = runMessagePolicy(channel, 'issue_hooks', data);
    expect(r!.action).toBe('deliver');
    expect(r!.variables.title).toBe('(无标题)');
    expect(r!.variables.repo).toBe('-');
    expect(r!.variables.author).toBe('未知');
    expect(r!.rendered).toBe('🐛 (无标题) (-) 由 未知 创建');
  });

  it('executeMessagePolicy 命中丢弃规则 → skip（含原因与规则id）', () => {
    const data = {
      action: 'opened',
      issue: { title: '修复登录' },
      sender: { type: 'Bot' },
    };
    const r = runMessagePolicy(channel, 'issue_hooks', data);
    expect(r!.action).toBe('discard');
    expect(r!.skip?.matchedRuleId).toBe('r2');
    expect(r!.skip?.reason).toBeTruthy();
  });

  it('executeMessagePolicy 无命中用默认动作丢弃（issue_hooks 默认 discard）', () => {
    const data = {
      action: 'closed',
      issue: { title: 'x', state: 'closed' },
      sender: { type: 'User' },
    };
    const r = runMessagePolicy(channel, 'issue_hooks', data);
    expect(r!.action).toBe('discard');
    expect(r!.skip?.matchedRuleId).toBeUndefined();
  });

  it('executeMessagePolicy push_hooks 默认放行 + 成员私聊投递目标', () => {
    const r = runMessagePolicy(channel, 'push_hooks', {
      head_commit: { message: 'fix: 登录' },
    });
    expect(r!.action).toBe('deliver');
    expect(r!.variables.msg).toBe('fix: 登录');
    expect(r!.rendered).toBe('📦 fix: 登录');
    expect(r!.deliveryTarget).toEqual({
      mode: 'member',
      teams: [],
      member: 'm1',
      route: 'mention',
    });
  });

  it('非法正则/缺失字段不触发异常（防御）', () => {
    const ch = {
      config: {
        messagePolicies: {
          p: {
            filters: [
              {
                logic: 'and',
                conditions: [{ path: 'a', op: 'regex', value: '[' }],
              },
              {
                logic: 'or',
                conditions: [{ path: 'missing.field', op: 'exists' }],
              },
            ],
            template: { variables: [], content: 'x' },
            targets: { mode: 'teams', teams: [], route: 'main' },
          },
        },
      },
    };
    const r = runMessagePolicy(ch, 'p', {});
    expect(r).toBeTruthy();
    expect(r!.action).toBe('deliver'); // 无命中 → 默认 deliver
  });

  it('执行结果 meta 包含事件/命中规则/动作/变量/正文/投递目标（给 adapter 链路）', () => {
    const data = {
      action: 'opened',
      issue: { title: 'T', state: 'open' },
      repository: { full_name: 'a/b' },
      sender: { login: 'u', type: 'User' },
    };
    const r = runMessagePolicy(channel, 'issue_hooks', data);
    const dm = (r as NonNullable<ReturnType<typeof runMessagePolicy>>)!
      .deliveryTarget;
    expect(dm).toBeDefined();
    expect(
      executeMessagePolicy(
        loadMessagePolicy(channel, 'issue_hooks')!,
        'issue_hooks',
        data,
      ).action,
    ).toBe('deliver');
  });
});
