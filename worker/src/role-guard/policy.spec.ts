import {
  EvaluateToolCallParams,
  GuardDecision,
  RolePolicy,
  RolesDoc,
  SessionPolicy,
  buildDenyMessage,
  evaluateToolCall,
  findBashDenyMatch,
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

  describe('4d) task 精确开口（仅 vteam-plan + subagent_type vteam-plan）/ execute 恒 deny', () => {
    it('他角色 task 拒绝', () => {
      const session = sess('vteam-developer');
      const rolesDoc = doc({ 'vteam-developer': role() });
      const message = expectDeny(
        call(rolesDoc, session, 'task', { subagent_type: 'vteam-plan' }),
      );
      expect(message).toContain('不能调用 task');
    });
    it('vteam-plan + task + subagent_type vteam-plan → allow', () => {
      const session = sess('vteam-plan');
      const rolesDoc = doc({ 'vteam-plan': role() });
      expectAllow(
        call(rolesDoc, session, 'task', { subagent_type: 'vteam-plan' }),
      );
    });
    it('vteam-plan task + 他名 subagent_type → deny', () => {
      const session = sess('vteam-plan');
      const rolesDoc = doc({ 'vteam-plan': role() });
      expectDeny(
        call(rolesDoc, session, 'task', { subagent_type: 'vteam-developer' }),
      );
    });
    it('vteam-plan task + 缺失 args → deny', () => {
      const session = sess('vteam-plan');
      const rolesDoc = doc({ 'vteam-plan': role() });
      expectDeny(call(rolesDoc, session, 'task', {}));
      expectDeny(call(rolesDoc, session, 'task', null));
      expectDeny(call(rolesDoc, session, 'task', { description: 'x' }));
    });
    it('execute 恒 deny（含 vteam-plan 会话，即使 subagent_type 匹配）', () => {
      const session = sess('vteam-plan');
      const rolesDoc = doc({ 'vteam-plan': role() });
      const message = expectDeny(
        call(rolesDoc, session, 'execute', { subagent_type: 'vteam-plan' }),
      );
      expect(message).toContain('不能调用 execute');
    });
  });

  describe('4d2) formerly server-gated MCP → allowlist 决定 allow/deny（无 pass-through）', () => {
    const session = sess('vteam-developer');
    /**
     * 曾由服务端按主实例身份 gate、guard 层② pass-through 的工具。该概念已退休
     * （server-gate-removal-tool-authority）：未列入 `tools` 即 deny，列入即 allow。
     * 从授权矩阵显式列举（旧 `SERVER_GATED_TOOLS` 常量已空，不可再作循环源）。
     */
    const FORMERLY_GATED_TOOLS = [
      'vteam_task_transition',
      'vteam_question_confirm',
      'vteam_task_create',
      'vteam_plan_mode',
      'vteam_plan_complete',
      'vteam_team_add_member',
      'vteam_skill_create',
    ] as const;

    it.each(FORMERLY_GATED_TOOLS)(
      '%s 未列入 tools → deny（反转旧 pass-through allow）',
      (tool) => {
        const unlisted = role({ tools: {} });
        const message = expectDeny(
          call(doc({ 'vteam-developer': unlisted }), session, tool, {}),
        );
        expect(message).toContain('不能调用');
        expect(message).toContain(tool);
      },
    );

    it.each(FORMERLY_GATED_TOOLS)(
      '%s 列入 tools allow → allow（授权矩阵正向面）',
      (tool) => {
        const granted = role({ tools: { [tool]: 'allow' } });
        expectAllow(call(doc({ 'vteam-developer': granted }), session, tool, {}));
      },
    );

    it('非空转证明：7 个 formerly-gated 工具两态各断言一次（断言数 > 0）', () => {
      let assertions = 0;
      for (const tool of FORMERLY_GATED_TOOLS) {
        const denied = call(
          doc({ 'vteam-developer': role({ tools: {} }) }),
          session,
          tool,
          {},
        );
        const allowed = call(
          doc({ 'vteam-developer': role({ tools: { [tool]: 'allow' } }) }),
          session,
          tool,
          {},
        );
        expect(denied.action).toBe('deny');
        expect(allowed.action).toBe('allow');
        assertions += 2;
      }
      expect(assertions).toBe(FORMERLY_GATED_TOOLS.length * 2);
      expect(assertions).toBeGreaterThan(0);
    });

    it('task/execute 仍 deny（与 allowlist 分支独立）', () => {
      const unlisted = role({ tools: {} });
      const rolesDoc = doc({ 'vteam-developer': unlisted });
      expectDeny(call(rolesDoc, session, 'task', {}));
      expectDeny(call(rolesDoc, session, 'execute', {}));
    });
    it('vteam_plan_review 未列入 allowlist → deny', () => {
      const unlisted = role({ tools: {} });
      const rolesDoc = doc({ 'vteam-developer': unlisted });
      expectDeny(call(rolesDoc, session, 'vteam_plan_review', {}));
    });
    it('未列入 MCP 仍 deny（负对照）', () => {
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

  describe('4g) 外部第三方只读 passthrough（非 vteam_/git_ 命名空间）', () => {
    it('只读外部工具对任意角色放行（含 vteam-architect）', () => {
      for (const agent of ['vteam-architect', 'vteam-developer']) {
        const rolesDoc = doc({ [agent]: role({ tools: {} }) });
        const session = sess(agent);
        expectAllow(call(rolesDoc, session, 'context7_resolve-library-id', {}));
        expectAllow(call(rolesDoc, session, 'context7_query-docs', {}));
        expectAllow(call(rolesDoc, session, 'grep_app_searchGitHub', {}));
      }
    });
    it('外部写类工具同样放行（未知外部默认允许，含 create/merge 语义）', () => {
      const session = sess('vteam-architect');
      const rolesDoc = doc({ 'vteam-architect': role({ tools: {} }) });
      expectAllow(call(rolesDoc, session, 'github_create_pr', {}));
      expectAllow(call(rolesDoc, session, 'github_merge_pr', {}));
    });
    it('命名空间守卫：vteam_/git_ 不走启发式，仍按 allowlist', () => {
      const session = sess('vteam-architect');
      const rolesDoc = doc({
        'vteam-architect': role({ tools: { vteam_submit_artifact: 'allow' } }),
      });
      expectDeny(call(rolesDoc, session, 'vteam_unknown_tool', {}));
      expectDeny(call(rolesDoc, session, 'git_fetch', {}));
      expectAllow(call(rolesDoc, session, 'vteam_submit_artifact', {}));
    });
    it('不可分类外部工具放行（黑名单策略：未命中即 allow）', () => {
      const session = sess('vteam-architect');
      const rolesDoc = doc({ 'vteam-architect': role({ tools: {} }) });
      expectAllow(call(rolesDoc, session, 'acme_frobnicate_xyz', {}));
      expectAllow(call(rolesDoc, session, 'call_omo_agent', {}));
    });
  });

  describe('外部工具一律放行（未知外部默认允许）', () => {
    it('写类/只读/不可分类外部名全部 allow', () => {
      const session = sess('vteam-architect');
      const rolesDoc = doc({ 'vteam-architect': role({ tools: {} }) });
      for (const tool of [
        'github_create_pr',
        'github_merge_pr',
        'acme_search_and_delete',
        'context7_resolve-library-id',
        'grep_app_searchGitHub',
        'codegraph_codegraph_explore',
        'call_omo_agent',
        'acme_frobnicate_xyz',
      ]) {
        expectAllow(call(rolesDoc, session, tool, {}));
      }
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
    it('无模板 → 默认格式；平台工具 handoff 缺失 → 通用短语兜底', () => {
      expect(buildDenyMessage('vteam-a', 'task', null)).toBe(
        '【越界拦截｜角色：vteam-a】不能调用 task。',
      );
      expect(
        buildDenyMessage('vteam-a', 'task', { denyTemplate: '转交 {handoffTarget}。' }),
      ).toBe('转交 对应职责角色。');
    });
    it('外部工具无精确工具键 → 通用短语（不误指 handoff 首值）', () => {
      const message = buildDenyMessage('vteam-architect', 'github_create_pr', {
        scopeSummary: 'S',
        handoff: { requirements: 'vteam-product', code: 'vteam-developer' },
        denyTemplate: TEMPLATE,
      });
      expect(message).toContain('对应职责角色');
      expect(message).not.toContain('vteam-product');
      expect(message).not.toContain('转交 ，');
    });
    it('平台工具无精确工具键 → 首值兜底不变（vteam_/git_/builtin 字节一致）', () => {
      const correction = {
        scopeSummary: 'S',
        handoff: { design: 'vteam-architect', test: 'vteam-tester' },
        denyTemplate: TEMPLATE,
      };
      expect(buildDenyMessage('vteam-a', 'vteam_issue_create', correction)).toContain(
        '转交 vteam-architect',
      );
      expect(buildDenyMessage('vteam-a', 'git_push', correction)).toContain(
        '转交 vteam-architect',
      );
      expect(buildDenyMessage('vteam-a', 'browser', correction)).toContain(
        '转交 vteam-architect',
      );
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

describe('matchesBashDeny 词边界语义（layer-2 hardening）', () => {
  it('词内子串放行（cp/mcp、ln/clean、rm/firmware、patch/dispatch）', () => {
    expect(matchesBashDeny('ls -la /data/w/server/mcp/', ['cp'])).toBe(false);
    expect(matchesBashDeny('python3 -c "import mcp"', ['cp', 'python -c'])).toBe(false);
    expect(matchesBashDeny('firmware flash', ['rm'])).toBe(false);
    expect(matchesBashDeny('dispatch event', ['patch'])).toBe(false);
  });
  it('真实命中仍拦截（cp/rm/git push/ln/tee/符号>）', () => {
    expect(matchesBashDeny('cp a b', ['cp'])).toBe(true);
    expect(matchesBashDeny('rm -rf /', ['rm'])).toBe(true);
    expect(matchesBashDeny('2>err.log', ['>'])).toBe(true);
    expect(matchesBashDeny('git push origin main', ['git push'])).toBe(true);
    expect(matchesBashDeny('ln -s a b', ['ln'])).toBe(true);
    expect(matchesBashDeny('cat f | tee log', ['tee'])).toBe(true);
  });
  it('符号条目保持子串语义（重定向真命中），但 2>/dev/null 精确放行', () => {
    expect(matchesBashDeny('echo hi > out.txt', ['>'])).toBe(true);
    expect(matchesBashDeny('pip list 2>/dev/null | grep mcp', ['>', 'cp'])).toBe(false);
    expect(matchesBashDeny('echo hi > out.txt 2>/dev/null', ['>'])).toBe(true);
    expect(matchesBashDeny('find / -name x 2>/dev/null', ['>'])).toBe(false);
  });
  it('findBashDenyMatch 返回命中规则原文，未命中返回 null', () => {
    expect(findBashDenyMatch('rm -rf /', ['cp', 'rm'])).toBe('rm');
    expect(findBashDenyMatch('ls -la', ['cp', 'rm'])).toBe(null);
    expect(findBashDenyMatch('find / -name x 2>/dev/null', ['>'])).toBe(null);
  });
  it('合成 glob 回归（通配符语义不变）', () => {
    expect(matchesBashDeny('rm -rf /tmp/x', ['rm *'])).toBe(true);
    expect(matchesBashDeny('firmware build', ['rm *'])).toBe(false);
  });
});

describe('bash 词边界端到端（evaluateToolCall）', () => {
  const session = sess('vteam-developer');
  function docWithDeny(bashDeny: string[]): RolesDoc {
    return doc({ 'vteam-developer': role({ bashDeny }) });
  }
  it('误伤路径/单词放行（含 2>/dev/null 降噪）', () => {
    const rolesDoc = docWithDeny(['>', '>>', 'tee', 'cp', 'ln', 'rm', 'patch', 'git push', 'python -c']);
    expect(call(rolesDoc, session, 'bash', { command: 'ls -la /data/w/server/mcp/' }).action).toBe('allow');
    expect(call(rolesDoc, session, 'bash', { command: 'python3 -c "import mcp"' }).action).toBe('allow');
    expect(call(rolesDoc, session, 'bash', { command: 'firmware flash' }).action).toBe('allow');
    expect(call(rolesDoc, session, 'bash', { command: 'dispatch event' }).action).toBe('allow');
    expect(call(rolesDoc, session, 'bash', { command: 'git --version' }).action).toBe('allow');
    expect(call(rolesDoc, session, 'bash', { command: 'find / -name x' }).action).toBe('allow');
    expect(call(rolesDoc, session, 'bash', { command: 'cat f' }).action).toBe('allow');
    expect(call(rolesDoc, session, 'bash', { command: 'find / -name x 2>/dev/null | head' }).action).toBe('allow');
    expect(call(rolesDoc, session, 'bash', { command: 'pip list 2>/dev/null | grep mcp' }).action).toBe('allow');
  });
  it('真实危险仍拦截', () => {
    const rolesDoc = docWithDeny(['>', '>>', 'tee', 'cp', 'ln', 'rm', 'patch', 'git push']);
    for (const command of [
      'cp a b',
      'rm -rf x',
      'ln -s a b',
      'echo hi > out.txt',
      'git push origin main',
      'patch -p1 < f',
      'cat f | tee log',
    ]) {
      expect(call(rolesDoc, session, 'bash', { command }).action).toBe('deny');
    }
  });
  it('拦截文案带出命中规则名', () => {
    const rolesDoc = docWithDeny(['>', 'rm']);
    const r = call(rolesDoc, session, 'bash', { command: 'rm -rf x' });
    expect(r.action).toBe('deny');
    if (r.action === 'deny') {
      expect(r.message).toContain('命中 shell 硬化规则：rm');
    }
    const r2 = call(rolesDoc, session, 'bash', { command: 'echo hi > out.txt' });
    expect(r2.action).toBe('deny');
    if (r2.action === 'deny') {
      expect(r2.message).toContain('命中 shell 硬化规则：>');
    }
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
