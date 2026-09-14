/**
 * guard 插件发现/hook 覆盖 spike（vteam-role-behavior-enforcement Todo 18）。
 *
 * 覆盖：
 * 1. 渲染产物为合法 TS（含 `tool.execute.before` hook、deny 时 `throw new Error`、
 *    `roles.json` + `sessions/<sessionID>.json` 读取、缺席 pass-through）；
 * 2. 内联判定快照与 `role-guard/policy.ts` 的 parity 矩阵（漂移即红）；
 * 3. 模拟 `tool.execute.before` 调用：deny 抛纠正文案、allow 放行、文件缺席放行；
 * 4. injector 成功路径写插件文件 + 注册 `plugin` 条目 + manifest，中性化路径清理。
 *
 * 明确 UNVERIFIED（无 live opencode 运行）：MCP/自定义/git 工具 id 是否原样到达
 * hook 的运行时确认（静态推理见 `.omo/evidence/role-enforcement/guard-plugin-spike.md`）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { evaluateToolCall, EvaluateToolCallParams, RolesDoc, SessionPolicy } from '../role-guard/policy';
import { GUARD_PLUGIN_REL, ResourceInjector } from './injector';
import { DECISION_MARKERS, renderRoleGuardPlugin } from './role-guard-plugin';

/** 从渲染产物提取判定块并求值为可调用的 `evaluateToolCall` 等价函数。 */
function extractDecisionFn(): (params: EvaluateToolCallParams) => { action: string; message?: string } {
  const rendered = renderRoleGuardPlugin();
  const begin = rendered.indexOf(DECISION_MARKERS.begin);
  const end = rendered.indexOf(DECISION_MARKERS.end);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  const block = rendered.slice(begin + DECISION_MARKERS.begin.length, end);
  expect(block).toContain('function evaluateToolCall(');
  // 判定块为纯 JS（无 import/export/类型注解），可直接求值
  expect(block).not.toMatch(/^\s*(import|export)\s/m);
  const factory = new Function(
    `${block}; return { evaluateToolCall, buildDenyMessage, wildcardMatch, matchesBashDeny, parsePatchFilePaths };`,
  ) as () => {
    evaluateToolCall: (params: EvaluateToolCallParams) => { action: string; message?: string };
  };
  return factory().evaluateToolCall;
}

const TEMPLATE =
  '【越界拦截｜角色：{role}】不能调用 <tool>。职责：{scopeSummary}。转交 {handoffTarget}。';

function rolesDoc(): RolesDoc {
  return {
    enabled: true,
    roles: {
      'vteam-developer': {
        permission: {
          edit: { '*': 'deny', '**tasks/*/**': 'allow' },
          read: { '*': 'allow' },
          bash: 'ask',
          task: 'deny',
        },
        tools: { vteam_submit_artifact: 'allow', git_clone: 'allow' },
        bashDeny: ['rm', 'git push'],
        correction: {
          scopeSummary: '编码与实现说明',
          handoff: { default: 'vteam-tester' },
          denyTemplate: TEMPLATE,
        },
      },
    },
  };
}

function session(): SessionPolicy {
  return { agent: 'vteam-developer', dir: 'tasks/t_1' };
}

/** parity 矩阵：双方同输入必须逐字节一致。 */
const PARITY_CASES: Array<{ name: string; params: EvaluateToolCallParams }> = [
  { name: 'rolesDoc null → pass-through', params: { rolesDoc: null, session: session(), tool: 'write', args: { filePath: 'x' } } },
  { name: 'disabled → pass-through', params: { rolesDoc: { enabled: false, roles: {} }, session: session(), tool: 'bash', args: { command: 'rm -rf /' } } },
  { name: 'session null → pass-through', params: { rolesDoc: rolesDoc(), session: null, tool: 'task', args: {} } },
  { name: '未知 agent → pass-through', params: { rolesDoc: rolesDoc(), session: { agent: 'ghost', dir: '' }, tool: 'execute', args: {} } },
  {
    name: '残缺角色 → fail-closed',
    params: { rolesDoc: { enabled: true, roles: { 'vteam-developer': { permission: {}, tools: null } } } as unknown as EvaluateToolCallParams['rolesDoc'], session: session(), tool: 'read', args: {} },
  },
  { name: 'read 放行（交层①）', params: { rolesDoc: rolesDoc(), session: session(), tool: 'read', args: { filePath: '/etc/passwd' } } },
  { name: 'write 白名单内放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'write', args: { filePath: 'tasks/t_1/server/a.ts' } } },
  { name: 'write 越界 deny', params: { rolesDoc: rolesDoc(), session: session(), tool: 'write', args: { filePath: 'server/secret.ts' } } },
  { name: 'apply_patch patchText 越界 deny', params: { rolesDoc: rolesDoc(), session: session(), tool: 'apply_patch', args: { patchText: '*** Begin Patch\n*** Update File: server/x.ts\n@@\n+1\n*** End Patch' } } },
  { name: 'edit 无目标路径 → 交层①放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'edit', args: {} } },
  { name: 'bash 命中硬化 deny', params: { rolesDoc: rolesDoc(), session: session(), tool: 'bash', args: { command: 'git push origin main' } } },
  { name: 'bash 未命中放行（交层①）', params: { rolesDoc: rolesDoc(), session: session(), tool: 'bash', args: { command: 'ls -la' } } },
  { name: 'task 恒 deny', params: { rolesDoc: rolesDoc(), session: session(), tool: 'task', args: { description: 'x' } } },
  { name: 'execute 恒 deny', params: { rolesDoc: rolesDoc(), session: session(), tool: 'execute', args: {} } },
  { name: 'server-gated vteam_task_transition 放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'vteam_task_transition', args: {} } },
  { name: 'server-gated vteam_question_confirm 放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'vteam_question_confirm', args: {} } },
  { name: 'server-gated vteam_task_create 放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'vteam_task_create', args: {} } },
  { name: 'server-gated vteam_plan_mode 放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'vteam_plan_mode', args: {} } },
  { name: 'server-gated vteam_team_add_member 放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'vteam_team_add_member', args: {} } },
  { name: 'question 通行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'question', args: {} } },
  { name: 'browser 未 allowlist deny', params: { rolesDoc: rolesDoc(), session: session(), tool: 'browser', args: {} } },
  { name: 'allowlist 内 MCP 放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'vteam_submit_artifact', args: {} } },
  { name: 'allowlist 外 MCP deny', params: { rolesDoc: rolesDoc(), session: session(), tool: 'vteam_issue_create', args: {} } },
  { name: 'allowlist 内自定义 git 放行', params: { rolesDoc: rolesDoc(), session: session(), tool: 'git_clone', args: {} } },
  { name: '未知自定义工具 deny', params: { rolesDoc: rolesDoc(), session: session(), tool: 'jira-query', args: {} } },
];

describe('renderRoleGuardPlugin（渲染产物 spike）', () => {
  it('产物为合法 TS（transpile 无语法错误）且含 hook 签名三要素', () => {
    const rendered = renderRoleGuardPlugin();
    const out = ts.transpileModule(rendered, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    const errors = (out.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))).toEqual([]);
    expect(rendered).toContain('"tool.execute.before"');
    expect(rendered).toContain('input.tool');
    expect(rendered).toContain('input.sessionID');
    expect(rendered).toContain('output.args');
    expect(rendered).toContain('throw new Error(');
    expect(rendered).toContain('.vteam-role-guard');
    expect(rendered).toContain('roles.json');
    expect(rendered).toContain('sessions');
    expect(rendered).toContain('export const VteamRoleGuard');
  });

  it('同输入多次渲染字节一致（injector 幂等依赖）', () => {
    expect(renderRoleGuardPlugin()).toBe(renderRoleGuardPlugin());
  });

  it('内联判定快照与 policy.ts parity（25 例矩阵逐字节一致）', () => {
    const snapshotEval = extractDecisionFn();
    for (const c of PARITY_CASES) {
      const expected = evaluateToolCall(c.params);
      const actual = snapshotEval(c.params);
      expect({ case: c.name, decision: actual }).toEqual({ case: c.name, decision: expected });
    }
  });
});

describe('模拟 tool.execute.before（磁盘 harness，仿插件读盘流程）', () => {
  function workDirWith(roleDoc: unknown, sessions: Record<string, unknown>): string {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-guard-spike-'));
    fs.mkdirSync(path.join(workDir, '.vteam-role-guard', 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.vteam-role-guard', 'roles.json'),
      JSON.stringify(roleDoc),
    );
    for (const [id, doc] of Object.entries(sessions)) {
      fs.writeFileSync(
        path.join(workDir, '.vteam-role-guard', 'sessions', `${id}.json`),
        JSON.stringify(doc),
      );
    }
    return workDir;
  }

  /** 与发射插件同流程：读盘（缺席→null）→ 判定 → deny 时 throw 纠正文案。 */
  function simulateHook(workDir: string, tool: string, sessionID: string, args: unknown): void {
    const readJson = (rel: string): unknown => {
      try {
        return JSON.parse(fs.readFileSync(path.join(workDir, rel), 'utf8'));
      } catch {
        return null;
      }
    };
    const evalFn = extractDecisionFn();
    const decision = evalFn({
      rolesDoc: readJson('.vteam-role-guard/roles.json') as EvaluateToolCallParams['rolesDoc'],
      session: readJson(`.vteam-role-guard/sessions/${sessionID}.json`) as EvaluateToolCallParams['session'],
      tool,
      args,
    });
    if (decision.action === 'deny') {
      throw new Error((decision as { message: string }).message);
    }
  }

  it('deny 抛纠正文案（含角色/工具/职责/转交）', () => {
    const workDir = workDirWith(rolesDoc(), { ses_1: session() });
    expect(() => simulateHook(workDir, 'write', 'ses_1', { filePath: 'server/x.ts' })).toThrow(
      /越界拦截｜角色：vteam-developer.*write.*编码与实现说明.*vteam-tester/,
    );
  });

  it('allow 放行不抛（白名单写 + 未命中 bash + 通行 question）', () => {
    const workDir = workDirWith(rolesDoc(), { ses_1: session() });
    expect(() => simulateHook(workDir, 'write', 'ses_1', { filePath: 'tasks/t_1/a.ts' })).not.toThrow();
    expect(() => simulateHook(workDir, 'bash', 'ses_1', { command: 'ls' })).not.toThrow();
    expect(() => simulateHook(workDir, 'question', 'ses_1', {})).not.toThrow();
  });

  it('roles.json 缺席 / session 未映射 → pass-through（Todo 19 缺席不误伤）', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-guard-spike-bare-'));
    expect(() => simulateHook(bare, 'task', 'ses_x', {})).not.toThrow();
    const workDir = workDirWith(rolesDoc(), {});
    expect(() => simulateHook(workDir, 'task', 'ses_unknown', {})).not.toThrow();
  });
});

describe('injector guard 插件写 + 注册（Todo 18 路径）', () => {
  const POLICIES = {
    agents: [
      { name: 'vteam-developer', description: 'dev', mode: 'primary', permission: { edit: { '*': 'deny' }, task: 'deny' } },
    ],
    guard: {
      enabled: true,
      roles: {
        'vteam-developer': {
          permission: { edit: { '*': 'deny' }, task: 'deny' },
          tools: { vteam_task_context: 'allow' },
          bashDeny: ['rm'],
          correction: { scopeSummary: 'dev' },
        },
      },
    },
  };

  function makeFetch(routes: Record<string, (url: URL) => unknown>): jest.Mock {
    return jest.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const handler = routes[url.pathname];
      if (!handler) {
        throw new Error(`unexpected fetch: ${url.pathname}`);
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => handler(url),
      } as unknown as Response;
    });
  }

  function routesWith(policies: unknown): Record<string, (url: URL) => unknown> {
    return {
      '/api/v1/skills': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      '/api/v1/tools': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      '/api/v1/mcp-servers': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      '/api/v1/agent-policies': () => policies,
    };
  }

  function injectorFor(workDir: string, policies: unknown): ResourceInjector {
    return new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: makeFetch(routesWith(policies)),
    });
  }

  it('成功路径：插件文件落盘 + 内容即渲染器输出 + plugin 数组注册 + manifest', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-guard-inject-'));
    const report = await injectorFor(workDir, POLICIES).injectAll();
    expect(report.agentPolicies.enabled).toBe(true);

    const pluginAbs = path.join(workDir, GUARD_PLUGIN_REL);
    expect(fs.existsSync(pluginAbs)).toBe(true);
    expect(fs.readFileSync(pluginAbs, 'utf8')).toBe(renderRoleGuardPlugin());

    const cfg = JSON.parse(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8')) as {
      plugin?: unknown[];
    };
    expect(cfg.plugin).toContain(`./${GUARD_PLUGIN_REL}`);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(workDir, '.opencode-worker-inject.json'), 'utf8'),
    ) as { guardPluginFile?: string | null };
    expect(manifest.guardPluginFile).toBe(GUARD_PLUGIN_REL);
  });

  it('幂等：重跑 opencode.json 字节一致，plugin 条目不重复', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-guard-inject-'));
    const injector = injectorFor(workDir, POLICIES);
    await injector.injectAll();
    const first = fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8');
    await injector.injectAll();
    expect(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8')).toBe(first);
    const cfg = JSON.parse(first) as { plugin?: unknown[] };
    expect(cfg.plugin?.filter((e) => typeof e === 'string' && e.includes('vteam-role-guard'))).toHaveLength(1);
  });

  it('用户手写 plugin 条目保留，guard 条目追加在后（OmO 共存）', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-guard-inject-'));
    fs.writeFileSync(path.join(workDir, 'opencode.json'), JSON.stringify({ plugin: ['./my-local.js'] }));
    await injectorFor(workDir, POLICIES).injectAll();
    const cfg = JSON.parse(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8')) as {
      plugin?: string[];
    };
    expect(cfg.plugin?.[0]).toBe('./my-local.js');
    expect(cfg.plugin).toContain(`./${GUARD_PLUGIN_REL}`);
    expect(cfg.plugin).toContain('oh-my-openagent@latest');
  });

  it('中性化：插件文件删除 + plugin 条目移除 + manifest 清零', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-guard-inject-'));
    await injectorFor(workDir, POLICIES).injectAll();
    expect(fs.existsSync(path.join(workDir, GUARD_PLUGIN_REL))).toBe(true);

    await injectorFor(workDir, { agents: [], guard: { enabled: true, roles: {} } }).injectAll();
    expect(fs.existsSync(path.join(workDir, GUARD_PLUGIN_REL))).toBe(false);
    const cfg = JSON.parse(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8')) as {
      plugin?: unknown[];
    };
    expect(JSON.stringify(cfg.plugin)).not.toContain('vteam-role-guard');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workDir, '.opencode-worker-inject.json'), 'utf8'),
    ) as { guardPluginFile?: string | null };
    expect(manifest.guardPluginFile).toBeNull();
  });
});
