import {
  EvaluateToolCallParams,
  GuardDecision,
  RolePolicy,
  RolesDoc,
  SessionPolicy,
  buildDenyMessage,
  evaluateToolCall,
  matchesBashDeny,
  parsePatchFilePaths,
  wildcardMatch,
} from './policy';

const TEMPLATE =
  '【越界拦截｜角色：{role}】不能调用 <tool>。职责：<scopeSummary>。请把该工作转交 {handoffTarget}，或使用 vteam_notify_agent 定向通知。';

function role(overrides?: Partial<RolePolicy>): RolePolicy {
  return {
    permission: {
      edit: { '*': 'deny', '**tasks/*/**': 'allow' },
      read: { '*': 'allow' },
      bash: 'ask',
      task: 'deny',
    },
    tools: { vteam_submit_artifact: 'allow', git_clone: 'allow' },
    bashDeny: ['>', '>>', 'tee', 'cp', 'mv', 'sed -i', 'git push', 'rm'],
    correction: {
      scopeSummary: '编码与实现说明',
      handoff: { design: 'vteam-architect', test: 'vteam-tester' },
      denyTemplate: TEMPLATE,
    },
    ...overrides,
  };
}

function doc(roles: Record<string, RolePolicy>, enabled = true): RolesDoc {
  return { enabled, roles };
}

function sess(agent: string): SessionPolicy {
  return { agent, dir: '/data/vteam-worker/tasks/t_1' };
}

function call(
  rolesDoc: RolesDoc | null,
  session: SessionPolicy | null,
  tool: string,
  args: unknown = {},
): GuardDecision {
  const params: EvaluateToolCallParams = { rolesDoc, session, tool, args };
  return evaluateToolCall(params);
}

function expectAllow(decision: GuardDecision): void {
  expect(decision).toEqual({ action: 'allow' });
}

function expectDeny(decision: GuardDecision): string {
  expect(decision.action).toBe('deny');
  return (decision as { action: 'deny'; message: string }).message;
}

describe('evaluateToolCall 分支优先级', () => {
  describe('1) rolesDoc 缺失/非法/未启用 → pass-through（绝不 fail-closed）', () => {
    const session = sess('vteam-developer');
    it('rolesDoc null → allow（含危险工具）', () => {
      expectAllow(call(null, session, 'task', {}));
      expectAllow(call(null, session, 'bash', { command: 'rm -rf /' }));
    });
    it('rolesDoc 形状非法（非对象/数组）→ allow', () => {
      expectAllow(call('not-json' as unknown as RolesDoc, session, 'task', {}));
      expectAllow(call([] as unknown as RolesDoc, session, 'task', {}));
    });
    it('enabled=false / 缺失 → allow', () => {
      expectAllow(call(doc({ 'vteam-developer': role() }, false), session, 'task', {}));
      expectAllow(
        call({ roles: { 'vteam-developer': role() } } as unknown as RolesDoc, session, 'task', {}),
      );
    });
    it('roles 缺失/非对象 → allow（文档级非法，不 fail-closed）', () => {
      expectAllow(
        call({ enabled: true } as unknown as RolesDoc, session, 'task', {}),
      );
      expectAllow(
        call({ enabled: true, roles: 'oops' } as unknown as RolesDoc, session, 'task', {}),
      );
    });
  });

  describe('2) session 未映射/未知 agent → pass-through', () => {
    const rolesDoc = doc({ 'vteam-developer': role() });
    it('session null → allow（含 task/execute）', () => {
      expectAllow(call(rolesDoc, null, 'task', {}));
      expectAllow(call(rolesDoc, null, 'vteam_evil', {}));
    });
    it('未知 agent → allow', () => {
      expectAllow(call(rolesDoc, sess('vteam-ghost'), 'task', {}));
      expectAllow(call(rolesDoc, sess('build'), 'bash', { command: 'rm -rf /' }));
    });
    it('session 形状非法（缺 agent）→ allow', () => {
      expectAllow(call(rolesDoc, {} as unknown as SessionPolicy, 'task', {}));
      expectAllow(
        call(rolesDoc, { agent: '', dir: '/tmp' } as SessionPolicy, 'task', {}),
      );
    });
  });

  describe('3) 角色条目残缺 → fail-closed（deny + 纠正）', () => {
    const session = sess('vteam-broken');
    it('缺 permission → deny（默认文案）', () => {
      const broken = { tools: {}, bashDeny: [], correction: {} } as unknown as RolePolicy;
      const message = expectDeny(call(doc({ 'vteam-broken': broken }), session, 'read', {}));
      expect(message).toBe('【越界拦截｜角色：vteam-broken】不能调用 read。');
    });
    it('permission/tools 非对象 → deny', () => {
      const badPermission = role({ permission: 'nope' as unknown as Record<string, unknown> });
      expectDeny(call(doc({ 'vteam-broken': badPermission }), session, 'read', {}));
      const badTools = role({ tools: null as unknown as Record<string, 'allow' | 'ask'> });
      expectDeny(call(doc({ 'vteam-broken': badTools }), session, 'read', {}));
    });
    it('残缺但残留 denyTemplate → 用模板组装文案', () => {
      const broken = {
        tools: {},
        bashDeny: [],
        correction: { scopeSummary: 'S', denyTemplate: TEMPLATE },
      } as unknown as RolePolicy;
      const message = expectDeny(
        call(doc({ 'vteam-broken': broken }), session, 'write', { filePath: '/x' }),
      );
      expect(message).toContain('【越界拦截｜角色：vteam-broken】');
      expect(message).toContain('不能调用 write');
    });
  });

  describe('4a) read 类 → allow（交层①）', () => {
    const rolesDoc = doc({ 'vteam-pm': role() });
    const session = sess('vteam-pm');
    it.each(['read', 'grep', 'glob', 'lsp', 'webfetch', 'websearch', 'list', 'todowrite', 'todoread'])(
      '%s 放行',
      (tool) => {
        expectAllow(call(rolesDoc, session, tool, { filePath: '/etc/secret' }));
      },
    );
  });

  describe('4b) edit 类 → 按 permission.edit glob 表', () => {
    const session = sess('vteam-developer');
    const rolesDoc = doc({ 'vteam-developer': role() });
    it('write 在 allow glob 内 → allow', () => {
      expectAllow(
        call(rolesDoc, session, 'write', { filePath: '/data/w/tasks/t_1/server/src/a.ts' }),
      );
      expectAllow(
        call(rolesDoc, session, 'edit', { filePath: '/data/w/tasks/t_9/docs/plan.md' }),
      );
    });
    it('write 在 allow glob 外 → deny + 模板纠正', () => {
      const message = expectDeny(
        call(rolesDoc, session, 'write', { filePath: '/data/w/server/src/evil.ts' }),
      );
      expect(message).toContain('【越界拦截｜角色：vteam-developer】');
      expect(message).toContain('不能调用 write');
      expect(message).toContain('编码与实现说明');
    });
    it('multiedit 多目标任一越界 → deny；全命中 → allow', () => {
      expectDeny(
        call(rolesDoc, session, 'multiedit', {
          files: ['/data/w/tasks/t_1/a.ts', '/etc/passwd'],
        }),
      );
      expectAllow(
        call(rolesDoc, session, 'multiedit', {
          files: ['/data/w/tasks/t_1/a.ts', '/data/w/tasks/t_2/b.ts'],
        }),
      );
    });
    it('apply_patch patchText 可解析：命中→allow，未命中→deny', () => {
      const inside = '*** Begin Patch\n*** Update File: tasks/t_1/server/src/a.ts\n@@\n+x\n*** End Patch';
      expectAllow(call(rolesDoc, session, 'apply_patch', { patchText: inside }));
      const outside = 'diff --git a/server/src/x.ts b/server/src/x.ts\n--- a/server/src/x.ts\n+++ b/server/src/x.ts\n@@ -1 +1 @@\n-x\n+y\n';
      expectDeny(call(rolesDoc, session, 'apply_patch', { patchText: outside }));
    });
    it('apply_patch 不可解析（无路径/非对象 args）→ allow 交层①', () => {
      expectAllow(call(rolesDoc, session, 'apply_patch', { patchText: 'hello world' }));
      expectAllow(call(rolesDoc, session, 'apply_patch', {}));
      expectAllow(call(rolesDoc, session, 'edit', null));
    });
    it('无 edit glob 表 → allow 交层①；无 * 默认拒绝 → allow', () => {
      const noEditMap = role({ permission: { task: 'deny' } });
      expectAllow(
        call(doc({ 'vteam-developer': noEditMap }), session, 'write', { filePath: '/anywhere' }),
      );
      const noStarDeny = role({ permission: { edit: { '**tasks/*/**': 'allow' } } });
      expectAllow(
        call(doc({ 'vteam-developer': noStarDeny }), session, 'write', { filePath: '/elsewhere' }),
      );
    });
    it('显式 deny glob 命中即 deny（deny 优先）', () => {
      const withDeny = role({
        permission: { edit: { '**tasks/*/**': 'allow', '**tasks/*/secret/**': 'deny' } },
      });
      expectDeny(
        call(doc({ 'vteam-developer': withDeny }), session, 'write', {
          filePath: '/w/tasks/t_1/secret/k.txt',
        }),
      );
    });
  });

  describe('4c) bash → 仅按 bashDeny 硬化', () => {
    const session = sess('vteam-developer');
    const rolesDoc = doc({ 'vteam-developer': role() });
    it('危险命令 deny（大小写不敏感）', () => {
      expectDeny(call(rolesDoc, session, 'bash', { command: 'rm -rf /tmp/x' }));
      expectDeny(call(rolesDoc, session, 'bash', { command: 'GIT PUSH origin main' }));
      expectDeny(call(rolesDoc, session, 'bash', { command: 'echo hi > /tmp/out.txt' }));
    });
    it('benign 命令 allow（再由层① permission.bash 生效）', () => {
      expectAllow(call(rolesDoc, session, 'bash', { command: 'ls -la' }));
      expectAllow(call(rolesDoc, session, 'bash', { command: 'git status' }));
    });
    it('command 缺失/非字符串 → allow', () => {
      expectAllow(call(rolesDoc, session, 'bash', {}));
      expectAllow(call(rolesDoc, session, 'bash', { command: 42 }));
    });
  });

  describe('4d) task/execute → deny', () => {
    const session = sess('vteam-developer');
    const rolesDoc = doc({ 'vteam-developer': role() });
    it.each(['task', 'execute'])('%s 拒绝', (tool) => {
      const message = expectDeny(call(rolesDoc, session, tool, {}));
      expect(message).toContain(`不能调用 ${tool}`);
    });
  });

  describe('4d2) server-gated MCP → pass-through（一律 allow，判定权在服务端）', () => {
    const session = sess('vteam-developer');
    it.each([
      'vteam_task_transition',
      'vteam_question_confirm',
      'vteam_task_create',
      'vteam_plan_mode',
      'vteam_team_add_member',
    ])('%s 未列入 tools 仍 allow', (tool) => {
      const unlisted = role({ tools: {} });
      expectAllow(call(doc({ 'vteam-developer': unlisted }), session, tool, {}));
    });
    it('task/execute 仍 deny（与 server-gated 分支独立）', () => {
      const unlisted = role({ tools: {} });
      const rolesDoc = doc({ 'vteam-developer': unlisted });
      expectDeny(call(rolesDoc, session, 'task', {}));
      expectDeny(call(rolesDoc, session, 'execute', {}));
    });
    it('非门控未列入 MCP 仍 deny（负对照）', () => {
      const unlisted = role({ tools: {} });
      const rolesDoc = doc({ 'vteam-developer': unlisted });
      expectDeny(call(rolesDoc, session, 'vteam_member_remove', {}));
      expectDeny(call(rolesDoc, session, 'vteam_bogus', {}));
    });
  });

  describe('4e) 内置通行集 + browser allowlist', () => {
    it.each(['question', 'plan_exit', 'skill'])('%s 未列入 tools 仍 allow', (tool) => {
      const minimal = role({ tools: {} });
      expectAllow(call(doc({ 'vteam-a': minimal }), sess('vteam-a'), tool, {}));
    });
    it('browser 未列入 → deny；列入 → allow', () => {
      const unlisted = role({ tools: {} });
      expectDeny(call(doc({ 'vteam-a': unlisted }), sess('vteam-a'), 'browser', {}));
      const listed = role({ tools: { browser: 'allow' } });
      expectAllow(call(doc({ 'vteam-a': listed }), sess('vteam-a'), 'browser', {}));
    });
  });

  describe('4f) 未知/自定义/MCP → tools allowlist 默认拒绝', () => {
    const session = sess('vteam-developer');
    it('vteam_* 未列入 → deny；列入 allow/ask → allow', () => {
      const rolesDoc = doc({ 'vteam-developer': role() });
      expectDeny(call(rolesDoc, session, 'vteam_issue_create', {}));
      expectAllow(call(rolesDoc, session, 'vteam_submit_artifact', {}));
      const asked = role({ tools: { vteam_doclib: 'ask' } });
      expectAllow(call(doc({ 'vteam-developer': asked }), session, 'vteam_doclib', {}));
    });
    it('自定义 git 工具未列入 → deny；列入 → allow', () => {
      const rolesDoc = doc({ 'vteam-developer': role() });
      expectDeny(call(rolesDoc, session, 'git_push', {}));
      expectAllow(call(rolesDoc, session, 'git_clone', { repo: 'x' }));
    });
    it('tools 值为非法值 → deny（仅 allow/ask 放行）', () => {
      const weird = role({
        tools: { vteam_x: 'deny' as unknown as 'allow' },
      });
      expectDeny(call(doc({ 'vteam-developer': weird }), session, 'vteam_x', {}));
    });
  });

  describe('5) 纠正文案组装', () => {
    it('模板占位符全替换（{role}/<tool>/<scopeSummary>/{handoffTarget}）', () => {
      const message = buildDenyMessage('vteam-tester', 'write', {
        scopeSummary: '用例与报告',
        handoff: { code: 'vteam-developer' },
        denyTemplate: TEMPLATE,
      });
      expect(message).toBe(
        '【越界拦截｜角色：vteam-tester】不能调用 write。职责：用例与报告。请把该工作转交 vteam-developer，或使用 vteam_notify_agent 定向通知。',
      );
    });
    it('{scopeSummary} 变体与同名工具键优先', () => {
      const message = buildDenyMessage('vteam-a', 'task', {
        scopeSummary: 'S',
        handoff: { task: 'vteam-plan', other: 'vteam-b' },
        denyTemplate: '{role}|{tool}|{scopeSummary}|{handoffTarget}',
      });
      expect(message).toBe('vteam-a|task|S|vteam-plan');
    });
    it('无模板 → 默认格式；handoff 缺失 → 占位符落空', () => {
      expect(buildDenyMessage('vteam-a', 'task', null)).toBe(
        '【越界拦截｜角色：vteam-a】不能调用 task。',
      );
      expect(
        buildDenyMessage('vteam-a', 'task', { denyTemplate: '转交 {handoffTarget}。' }),
      ).toBe('转交 。');
    });
  });
});

describe('wildcardMatch（本地复刻，不 import opencode 包）', () => {
  it('* 跨路径分隔符', () => {
    expect(wildcardMatch('/data/w/tasks/t_1/docs/a.md', '**tasks/*/docs/**')).toBe(true);
    expect(wildcardMatch('/data/w/server/src/a.ts', '**tasks/*/docs/**')).toBe(false);
    expect(wildcardMatch('anything', '*')).toBe(true);
  });
  it('? 匹配单个字符；正则特殊字符被转义', () => {
    expect(wildcardMatch('a1', 'a?')).toBe(true);
    expect(wildcardMatch('a12', 'a?')).toBe(false);
    expect(wildcardMatch('a.ts', 'a.ts')).toBe(true);
    expect(wildcardMatch('aXts', 'a.ts')).toBe(false);
  });
  it('全串锚定', () => {
    expect(wildcardMatch('xxabcyy', 'abc')).toBe(false);
    expect(wildcardMatch('abc', 'abc')).toBe(true);
  });
});

describe('matchesBashDeny（大小写不敏感子串 + glob）', () => {
  it('子串命中（大小写不敏感）', () => {
    expect(matchesBashDeny('RM -rf /tmp', ['rm'])).toBe(true);
    expect(matchesBashDeny('git status', ['rm', 'git push'])).toBe(false);
  });
  it('含通配符条目按 glob 匹配', () => {
    expect(matchesBashDeny('rm -rf /tmp/x', ['rm *'])).toBe(true);
    expect(matchesBashDeny('firmware build', ['rm *'])).toBe(false);
  });
});

describe('parsePatchFilePaths', () => {
  it('解析 unified diff 的 +++ 路径（去 a/ b/ 前缀，跳 /dev/null）', () => {
    const text = [
      '--- a/old.ts',
      '+++ b/tasks/t_1/new.ts',
      '--- /dev/null',
      '+++ b/tasks/t_1/added.ts',
    ].join('\n');
    expect(parsePatchFilePaths(text)).toEqual(['tasks/t_1/new.ts', 'tasks/t_1/added.ts']);
  });
  it('解析 *** Begin Patch 体', () => {
    const text = '*** Begin Patch\n*** Update File: tasks/t_2/a.ts\n@@\n+x\n*** End Patch';
    expect(parsePatchFilePaths(text)).toEqual(['tasks/t_2/a.ts']);
  });
  it('无路径 → 空数组（调用方 allow 交层①）', () => {
    expect(parsePatchFilePaths('hello world')).toEqual([]);
  });
});
