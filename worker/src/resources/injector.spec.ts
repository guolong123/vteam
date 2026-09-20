import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InjectReport,
  readXExecution,
  ResourceInjector,
  schemaToArgs,
} from './injector';
import { OMO_AGENT_NAMES } from './omo-config';

/** 构造按 URL pathname 路由的 mock fetch（Response 最小形态）。 */
function makeFetch(
  routes: Record<string, (url: URL) => unknown>,
): jest.Mock {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const handler = routes[url.pathname];
    if (!handler) {
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }
    const data = handler(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => data,
    } as unknown as Response;
  });
}

function workDirFor(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keta-inject-spec-'));
}

describe('schemaToArgs / readXExecution', () => {
  it('JSON Schema properties + required → CustomToolArg[]', () => {
    const args = schemaToArgs({
      type: 'object',
      properties: {
        repoUrl: { type: 'string', description: '仓库地址' },
        limit: { type: 'number' },
        verbose: { type: 'boolean' },
      },
      required: ['repoUrl'],
    });
    expect(args).toEqual([
      { name: 'repoUrl', type: 'string', required: true, description: '仓库地址' },
      { name: 'limit', type: 'integer', required: false, description: '' },
      { name: 'verbose', type: 'boolean', required: false, description: '' },
    ]);
  });

  it('readXExecution 读取约定扩展字段', () => {
    const x = readXExecution({ 'x-execution': { command: ['jcli', 'issue'] } });
    expect(x?.command).toEqual(['jcli', 'issue']);
    expect(readXExecution(null)).toBeNull();
    expect(readXExecution({})).toBeNull();
  });
});

describe('ResourceInjector.injectSkills', () => {
  it('拉取启用技能 → 逐个拉 content → 写 <workDir>/.opencode/skills/<name>/SKILL.md', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/skills': () => ({
        items: [{ id: 'sk_0000000001', name: 'git-ops' }],
        total: 1,
        page: 1,
        pageSize: 100,
      }),
      '/api/v1/skills/sk_0000000001/content': () => ({
        id: 'sk_0000000001',
        name: 'git-ops',
        content: '---\nname: git-ops\n---\n# git ops',
      }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    const names = await injector.injectSkills();
    expect(names).toEqual(['git-ops']);

    const skillPath = path.join(workDir, '.opencode', 'skills', 'git-ops', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, 'utf8')).toContain('name: git-ops');

    // 请求必须带 X-Worker-Token
    const contentCall = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes('/skills/sk_0000000001/content'),
    );
    const headers = (contentCall?.[1] as { headers?: Record<string, string> })?.headers;
    expect(headers?.['x-worker-token']).toBe('tok');
  });
});

describe('ResourceInjector.injectTools', () => {
  it('cli 工具（x-execution 命令）→ 写 <workDir>/.opencode/tools/<action>.ts（默认导出）', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/tools': () => ({
        items: [
          {
            id: 'tl_0000000001',
            action: 'jira-query',
            name: 'Jira 查询',
            execution: 'cli',
            schema: {
              type: 'object',
              properties: { jobName: { type: 'string', description: '任务名' } },
              required: ['jobName'],
              'x-execution': { command: ['jcli', 'issue', 'get'] },
            },
          },
          {
            id: 'tl_0000000002',
            action: 'github-create-issue',
            name: '创建 Issue',
            execution: 'mcp',
            schema: null,
          },
        ],
        total: 2,
        page: 1,
        pageSize: 100,
      }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    const actions = await injector.injectTools();
    // mcp 型跳过，仅注入 cli
    expect(actions).toEqual(['jira-query']);

    const filePath = path.join(workDir, '.opencode', 'tools', 'jira-query.ts');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('export default tool({');
    expect(content).toContain('spawnSync("jcli", ["issue", "get", ...cmdArgs], { encoding: "utf8" })');
    expect(content).toContain('jobName: tool.schema.string().describe("任务名")');
    // mcp 工具不写文件
    expect(fs.existsSync(path.join(workDir, '.opencode', 'tools', 'github-create-issue.ts'))).toBe(false);
  });

  it('缺执行细节的工具跳过注入（不写文件）', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/tools': () => ({
        items: [
          {
            id: 'tl_1',
            action: 'ghost',
            name: '幽灵工具',
            execution: 'cli',
            schema: { type: 'object', properties: {} },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    const actions = await injector.injectTools();
    expect(actions).toEqual([]);
    expect(fs.existsSync(path.join(workDir, '.opencode', 'tools', 'ghost.ts'))).toBe(false);
  });
});

describe('ResourceInjector.injectMcp', () => {
  it('生成 opencode.json mcp 节（合并保留其他配置节 + local/remote 两型）', async () => {
    const workDir = workDirFor();
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({ model: 'gpt-4o' }),
    );
    const fetchImpl = makeFetch({
      '/api/v1/mcp-servers': () => ({
        items: [
          {
            id: 'ms_0000000001',
            name: 'filesystem',
            type: 'local',
            command: { command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/data'] },
            url: null,
            headers: null,
            oauth: null,
          },
          {
            id: 'ms_0000000002',
            name: 'gitee-remote',
            type: 'remote',
            command: null,
            url: 'https://mcp.example.com/gitee',
            headers: { Authorization: 'Bearer {env:GITEE_TOKEN}' },
            oauth: { clientId: 'cid', scope: 'tools:read' },
          },
        ],
        total: 2,
        page: 1,
        pageSize: 100,
      }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    const names = await injector.injectMcp();
    expect(names).toEqual(['filesystem', 'gitee-remote']);

    const config = JSON.parse(
      fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'),
    ) as { model?: string; mcp?: Record<string, unknown> };
    // 其他节保留
    expect(config.model).toBe('gpt-4o');
    // mcp 节格式（11 篇 §5.1）：local/remote 两型，服务器名作 key（含连字符）
    expect(config.mcp?.filesystem).toEqual({
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/data'],
      enabled: true,
    });
    expect(config.mcp?.['gitee-remote']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/gitee',
      headers: { Authorization: 'Bearer {env:GITEE_TOKEN}' },
      oauth: { clientId: 'cid', scope: 'tools:read' },
      enabled: true,
    });
  });

  it('remote 型 headers 的 {env:WORKER_ID}/{env:X_WORKER_TOKEN} 替换为实际值（未知变量保留）', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/mcp-servers': () => ({
        items: [
          {
            id: 'ms_vteam',
            name: 'vteam',
            type: 'remote',
            command: null,
            url: 'https://vteam.example.com/api/v1/platform-mcp',
            headers: {
              'x-worker-id': '{env:WORKER_ID}',
              'x-worker-token': '{env:X_WORKER_TOKEN}',
              Authorization: 'Bearer {env:UNKNOWN_VAR}',
            },
            oauth: null,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok-secret',
      workerId: 'w_external',
      workDir,
      fetchImpl,
    });

    await injector.injectMcp();
    const config = JSON.parse(
      fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'),
    ) as { mcp?: Record<string, unknown> };
    expect(config.mcp?.vteam).toMatchObject({
      type: 'remote',
      url: 'https://vteam.example.com/api/v1/platform-mcp',
      headers: {
        'x-worker-id': 'w_external',
        'x-worker-token': 'tok-secret',
        Authorization: 'Bearer {env:UNKNOWN_VAR}',
      },
      enabled: true,
    });
  });

  it('local 型透传 cwd/environment/timeout（enabled 恒 true 因已过滤启用集）', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/mcp-servers': () => ({
        items: [
          {
            id: 'ms_0000000001',
            name: 'rich-local',
            type: 'local',
            command: {
              command: ['node', 'server.js'],
              cwd: '/opt/mcp',
              environment: { MY_ENV: 'v1' },
              timeout: 5000,
            },
            url: null,
            headers: null,
            oauth: null,
            enabled: true,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    const names = await injector.injectMcp();
    expect(names).toEqual(['rich-local']);
    const config = JSON.parse(
      fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'),
    ) as { mcp?: Record<string, unknown> };
    expect(config.mcp?.richLocal ?? config.mcp?.['rich-local']).toEqual({
      type: 'local',
      command: ['node', 'server.js'],
      cwd: '/opt/mcp',
      environment: { MY_ENV: 'v1' },
      timeout: 5000,
      enabled: true,
    });
  });

  it('停用的注入服务器经 manifest 比对从 mcp 节移除，用户手动配置保留', async () => {
    const workDir = workDirFor();
    // 首次注入：filesystem 启用
    const fetchA = makeFetch({
      '/api/v1/mcp-servers': () => ({
        items: [
          {
            id: 'ms_1',
            name: 'filesystem',
            type: 'local',
            command: { command: ['npx', 'mcp-fs'] },
            url: null,
            headers: null,
            oauth: null,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      }),
    });
    const injectorA = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: fetchA,
    });
    await injectorA.injectMcp();

    // 用户在 opencode.json 手动追加 manual-server（非注入器管理）
    const configPath = path.join(workDir, 'opencode.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    config.mcp['manual-server'] = { type: 'remote', url: 'https://user.example.com' };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // 再次注入：filesystem 已停用（只返回 manual-server 之外的服务器，这里返回空）
    const fetchB = makeFetch({
      '/api/v1/mcp-servers': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
    });
    const injectorB = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: fetchB,
    });
    await injectorB.injectMcp();

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    // 停用清理：filesystem 移除
    expect(after.mcp.filesystem).toBeUndefined();
    // 用户手动配置保留
    expect(after.mcp['manual-server']).toEqual({
      type: 'remote',
      url: 'https://user.example.com',
    });
  });

  it('enabled=true 过滤：GET /mcp-servers 请求 query 带 enabled=true + X-Worker-Token', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/mcp-servers': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    await injector.injectMcp();

    const mcpCall = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes('/api/v1/mcp-servers'),
    );
    const url = new URL(String(mcpCall?.[0]));
    expect(url.searchParams.get('enabled')).toBe('true');
    const headers = (mcpCall?.[1] as { headers?: Record<string, string> })?.headers;
    expect(headers?.['x-worker-token']).toBe('tok');
  });

  it('remote 型透传 headers/oauth/timeout（11 §5.1 remote 字段）', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/mcp-servers': () => ({
        items: [
          {
            id: 'ms_0000000002',
            name: 'gitee-remote',
            type: 'remote',
            command: null,
            url: 'https://mcp.example.com/gitee',
            headers: { Authorization: 'Bearer {env:GITEE_TOKEN}' },
            oauth: { clientId: 'cid', scope: 'tools:read' },
            timeout: 8000,
            enabled: true,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    await injector.injectMcp();
    const config = JSON.parse(
      fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'),
    ) as { mcp?: Record<string, unknown> };
    expect(config.mcp?.['gitee-remote']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/gitee',
      headers: { Authorization: 'Bearer {env:GITEE_TOKEN}' },
      oauth: { clientId: 'cid', scope: 'tools:read' },
      timeout: 8000,
      enabled: true,
    });
  });

  it('配置不完整跳过：local 缺 command[] / remote 缺 url 不入 mcp 节', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/mcp-servers': () => ({
        items: [
          {
            id: 'ms_bad1',
            name: 'broken-local',
            type: 'local',
            command: { command: [] },
            url: null,
            headers: null,
            oauth: null,
          },
          {
            id: 'ms_bad2',
            name: 'broken-remote',
            type: 'remote',
            command: null,
            url: null,
            headers: null,
            oauth: null,
          },
          {
            id: 'ms_ok',
            name: 'ok-local',
            type: 'local',
            command: { command: ['npx', 'mcp-fs'] },
            url: null,
            headers: null,
            oauth: null,
          },
        ],
        total: 3,
        page: 1,
        pageSize: 100,
      }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    const names = await injector.injectMcp();
    expect(names).toEqual(['ok-local']);
    const config = JSON.parse(
      fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'),
    ) as { mcp?: Record<string, unknown> };
    expect(config.mcp?.['broken-local']).toBeUndefined();
    expect(config.mcp?.['broken-remote']).toBeUndefined();
    expect(config.mcp?.['ok-local']).toBeDefined();
  });
});

describe('ResourceInjector 清理与组合', () => {
  it('停用技能经 manifest 比对后清理（保留新技能与 git.ts 内置注入）', async () => {
    const workDir = workDirFor();
    // 先注入 skill-a
    const fetchA = makeFetch({
      '/api/v1/skills': () => ({ items: [{ id: 'sk_1', name: 'skill-a' }], total: 1, page: 1, pageSize: 100 }),
      '/api/v1/skills/sk_1/content': () => ({ id: 'sk_1', name: 'skill-a', content: '# a' }),
    });
    const injectorA = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: fetchA,
    });
    await injectorA.injectSkills();
    expect(fs.existsSync(path.join(workDir, '.opencode', 'skills', 'skill-a'))).toBe(true);

    // 再注入 skill-b（skill-a 已停用）→ skill-a 目录被清理
    const fetchB = makeFetch({
      '/api/v1/skills': () => ({ items: [{ id: 'sk_2', name: 'skill-b' }], total: 1, page: 1, pageSize: 100 }),
      '/api/v1/skills/sk_2/content': () => ({ id: 'sk_2', name: 'skill-b', content: '# b' }),
    });
    const injectorB = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: fetchB,
    });
    await injectorB.injectSkills();

    expect(fs.existsSync(path.join(workDir, '.opencode', 'skills', 'skill-a'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, '.opencode', 'skills', 'skill-b'))).toBe(true);
  });

  it('injectAll 组合三类注入并返回报告', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/skills': () => ({ items: [{ id: 'sk_1', name: 's1' }], total: 1, page: 1, pageSize: 100 }),
      '/api/v1/skills/sk_1/content': () => ({ id: 'sk_1', name: 's1', content: '# s1' }),
      '/api/v1/tools': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      '/api/v1/mcp-servers': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
    });

    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });

    const report: InjectReport = await injector.injectAll();
    expect(report.skills).toEqual(['s1']);
    expect(report.tools).toEqual([]);
    expect(report.mcpServers).toEqual([]);
    expect(fs.existsSync(path.join(workDir, 'opencode.json'))).toBe(true);
  });
});

describe('ResourceInjector：OmO 插件声明与 agent 模型配置', () => {
  function injectorFor(workDir: string): ResourceInjector {
    return new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: makeFetch({
        '/api/v1/mcp-servers': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      }),
    });
  }

  function readJson(workDir: string, rel: string): any {
    return JSON.parse(fs.readFileSync(path.join(workDir, rel), 'utf8'));
  }

  describe('plugin 节（opencode.json）', () => {
    it('写入 oh-my-openagent 条目', async () => {
      const workDir = workDirFor();
      await injectorFor(workDir).injectMcp();
      expect(readJson(workDir, 'opencode.json').plugin).toEqual([
        'oh-my-openagent@latest',
      ]);
    });

    it('重复注入不追加重复条目（幂等）', async () => {
      const workDir = workDirFor();
      const injector = injectorFor(workDir);
      await injector.injectMcp();
      await injector.injectMcp();
      expect(readJson(workDir, 'opencode.json').plugin).toEqual([
        'oh-my-openagent@latest',
      ]);
    });

    it('各种等价写法都识别为已存在（不重复追加）', async () => {
      for (const entry of [
        'oh-my-openagent',
        'oh-my-openagent@latest',
        'oh-my-opencode@latest',
        '/opt/omo/node_modules/oh-my-openagent',
      ]) {
        const workDir = workDirFor();
        fs.writeFileSync(
          path.join(workDir, 'opencode.json'),
          JSON.stringify({ plugin: [entry] }),
        );
        await injectorFor(workDir).injectMcp();
        expect(readJson(workDir, 'opencode.json').plugin).toEqual([entry]);
      }
    });

    it('用户手写的其他 plugin 条目保留，OmO 追加在后', async () => {
      const workDir = workDirFor();
      fs.writeFileSync(
        path.join(workDir, 'opencode.json'),
        JSON.stringify({ plugin: ['./my-local-plugin.js'] }),
      );
      await injectorFor(workDir).injectMcp();
      expect(readJson(workDir, 'opencode.json').plugin).toEqual([
        './my-local-plugin.js',
        'oh-my-openagent@latest',
      ]);
    });
  });

  describe('agent→模型配置（位置与格式自适应）', () => {
    it('无任何文件时：新建到新位置 .omo/omo.jsonc', async () => {
      const workDir = workDirFor();
      const written = await injectorFor(workDir).writeOmoConfig({
        sisyphus: 'opencode/big-pickle',
      });
      expect(written).toBe(path.join(workDir, '.omo', 'omo.jsonc'));
      expect(readJson(workDir, '.omo/omo.jsonc')).toEqual({
        agents: { sisyphus: { model: 'opencode/big-pickle' } },
      });
    });

    it('新位置存在时写新位置（回归：曾误写 .opencode 那份→完全不生效）', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.join(workDir, '.omo'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.omo', 'omo.jsonc'),
        JSON.stringify({ '[opencode]': { agents: {} }, _migrations: ['x'] }),
      );
      const injector = injectorFor(workDir);
      const written = await injector.writeOmoConfig({ atlas: 'opencode/big-pickle' });
      expect(written).toBe(path.join(workDir, '.omo', 'omo.jsonc'));
      // 写进 [opencode].agents，且保留 $schema/_migrations 等其他键
      const cfg = readJson(workDir, '.omo/omo.jsonc');
      expect(cfg['[opencode]'].agents.atlas).toEqual({ model: 'opencode/big-pickle' });
      expect(cfg._migrations).toEqual(['x']);
    });

    it('仅旧位置存在时写回旧位置（保持既有部署落点不变）', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.opencode', 'oh-my-openagent.jsonc'),
        JSON.stringify({ agents: {} }),
      );
      const written = await injectorFor(workDir).writeOmoConfig({ atlas: 'a/b' });
      expect(written).toBe(
        path.join(workDir, '.opencode', 'oh-my-openagent.jsonc'),
      );
    });

    it('两份都存在时以新位置为准（实测：.omo/omo.jsonc 胜出）', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.join(workDir, '.omo'), { recursive: true });
      fs.mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.omo', 'omo.jsonc'),
        JSON.stringify({ '[opencode]': { agents: { sisyphus: { model: 'new/win' } } } }),
      );
      fs.writeFileSync(
        path.join(workDir, '.opencode', 'oh-my-openagent.jsonc'),
        JSON.stringify({ agents: { sisyphus: { model: 'old/lose' } } }),
      );
      const injector = injectorFor(workDir);
      // 读要读生效的那份，而不是旧的
      expect(injector.readOmoConfig()).toEqual({ sisyphus: 'new/win' });
      await injector.writeOmoConfig({ atlas: 'a/b' });
      // 旧文件不得被改动
      expect(readJson(workDir, '.opencode/oh-my-openagent.jsonc').agents).toEqual({
        sisyphus: { model: 'old/lose' },
      });
    });

    it('读旧格式（顶层 agents）与新格式（[opencode].agents）都认', async () => {
      const legacy = workDirFor();
      fs.mkdirSync(path.join(legacy, '.opencode'), { recursive: true });
      fs.writeFileSync(
        path.join(legacy, '.opencode', 'oh-my-openagent.jsonc'),
        JSON.stringify({ agents: { oracle: { model: 'a/b' } } }),
      );
      expect(injectorFor(legacy).readOmoConfig()).toEqual({ oracle: 'a/b' });

      const modern = workDirFor();
      fs.mkdirSync(path.join(modern, '.omo'), { recursive: true });
      fs.writeFileSync(
        path.join(modern, '.omo', 'omo.jsonc'),
        JSON.stringify({ '[opencode]': { agents: { oracle: { model: 'c/d' } } } }),
      );
      expect(injectorFor(modern).readOmoConfig()).toEqual({ oracle: 'c/d' });
    });

    it('JSONC 注释与尾逗号可解析（新位置文件带 // 注释）', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.join(workDir, '.omo'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.omo', 'omo.jsonc'),
        `// OMO configuration\n{\n  "[opencode]": {\n    "agents": {\n      "sisyphus": { "model": "a/b" },\n    },\n  },\n}\n`,
      );
      expect(injectorFor(workDir).readOmoConfig()).toEqual({ sisyphus: 'a/b' });
    });

    it('增量合并：只改传入项，其余保留；空串清除覆盖', async () => {
      const workDir = workDirFor();
      const injector = injectorFor(workDir);
      await injector.writeOmoConfig({ sisyphus: 'a/one', atlas: 'a/two' });
      await injector.writeOmoConfig({ sisyphus: 'b/three' });
      expect(injector.readOmoConfig()).toEqual({ sisyphus: 'b/three', atlas: 'a/two' });
      await injector.writeOmoConfig({ sisyphus: '' });
      expect(injector.readOmoConfig()).toEqual({ atlas: 'a/two' });
    });

    it('保留 agent 的其他键（variant），只覆盖 model', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.join(workDir, '.omo'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.omo', 'omo.jsonc'),
        JSON.stringify({
          '[opencode]': { agents: { sisyphus: { model: 'old/m', variant: 'high' } } },
        }),
      );
      await injectorFor(workDir).writeOmoConfig({ sisyphus: 'new/m' });
      expect(
        readJson(workDir, '.omo/omo.jsonc')['[opencode]'].agents.sisyphus,
      ).toEqual({ model: 'new/m', variant: 'high' });
    });

    it('文件不存在/损坏 → readOmoConfig 返回空对象不抛错', () => {
      const workDir = workDirFor();
      expect(injectorFor(workDir).readOmoConfig()).toEqual({});
      fs.mkdirSync(path.join(workDir, '.omo'), { recursive: true });
      fs.writeFileSync(path.join(workDir, '.omo', 'omo.jsonc'), '{ broken');
      expect(injectorFor(workDir).readOmoConfig()).toEqual({});
    });

    it('OMO_AGENT_NAMES 覆盖 OmO schema 的全部 agent（含 prometheus/atlas）', () => {
      expect(OMO_AGENT_NAMES).toEqual(
        expect.arrayContaining(['sisyphus', 'prometheus', 'atlas', 'hephaestus']),
      );
      expect(OMO_AGENT_NAMES.length).toBe(14);
    });
  });
});

describe('ResourceInjector：从 slim fork 迁移到 OmO', () => {
  function injectorFor(workDir: string): ResourceInjector {
    return new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: makeFetch({
        '/api/v1/mcp-servers': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      }),
    });
  }

  it('残留的 oh-my-opencode-slim 条目被替换为 OmO（回归：宽松匹配会导致 OmO 永不加载）', async () => {
    const workDir = workDirFor();
    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({ plugin: ['/opt/omo/node_modules/oh-my-opencode-slim'] }),
    );
    await injectorFor(workDir).injectMcp();
    const cfg = JSON.parse(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'));
    expect(cfg.plugin).toEqual(['oh-my-openagent@latest']);
    expect(JSON.stringify(cfg.plugin)).not.toContain('slim');
  });

  it('slim 与 OmO 并存时只保留 OmO，且顺序稳定', async () => {
    const workDir = workDirFor();
    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({
        plugin: ['oh-my-opencode-slim', 'oh-my-openagent@latest', './mine.js'],
      }),
    );
    await injectorFor(workDir).injectMcp();
    const cfg = JSON.parse(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'));
    expect(cfg.plugin).toEqual(['oh-my-openagent@latest', './mine.js']);
  });
});

describe('ResourceInjector：agent 策略注入（原生 agent 节，无 guard 制品）', () => {
  const POLICIES = {
    agents: [
      {
        name: 'vteam-developer',
        description: 'dev scope',
        mode: 'primary',
        permission: { edit: { '*': 'deny' }, task: 'deny' },
      },
      {
        name: 'vteam-tester',
        description: 'test scope',
        mode: 'primary',
        permission: { edit: { '*': 'deny' }, task: 'deny' },
      },
    ],
  };

  function routesWith(policies: unknown): Record<string, (url: URL) => unknown> {
    return {
      '/api/v1/skills': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      '/api/v1/tools': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      '/api/v1/mcp-servers': () => ({
        items: [
          {
            id: 'ms_1',
            name: 'vteam',
            type: 'remote',
            command: null,
            url: 'https://vteam.example.com/api/v1/platform-mcp',
            headers: null,
            oauth: null,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      }),
      '/api/v1/agent-policies': () => policies,
    };
  }

  function injectorForPolicies(
    workDir: string,
    policies: unknown,
    fetchImpl?: jest.Mock,
  ): ResourceInjector {
    return new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: fetchImpl ?? makeFetch(routesWith(policies)),
    });
  }

  function readConfig(workDir: string): any {
    return JSON.parse(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'));
  }

  function readManifest(workDir: string): any {
    return JSON.parse(
      fs.readFileSync(path.join(workDir, '.opencode-worker-inject.json'), 'utf8'),
    );
  }

  it('(a) 一次运行：mcp + plugin + 原生 agent 三节，无 guard 制品写入', async () => {
    const workDir = workDirFor();
    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({
        agent: { 'my-agent': { description: 'user', mode: 'primary', permission: {} } },
      }),
    );
    const fetchImpl = makeFetch(routesWith(POLICIES));
    const report = await injectorForPolicies(workDir, POLICIES, fetchImpl).injectAll();

    expect(report.agentPolicies).toEqual({
      enabled: true,
      names: ['vteam-developer', 'vteam-tester'],
    });
    const cfg = readConfig(workDir);
    expect(cfg.mcp?.vteam).toBeDefined();
    expect(cfg.plugin).toEqual(['oh-my-openagent@latest']);
    expect(cfg.agent['vteam-developer']).toEqual({
      description: 'dev scope',
      mode: 'primary',
      permission: { edit: { '*': 'deny' }, task: 'deny' },
    });
    expect(cfg.agent['vteam-tester']).toBeDefined();
    expect(cfg.agent['my-agent']).toBeDefined();
    expect(fs.existsSync(path.join(workDir, '.vteam-role-guard'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, '.opencode', 'plugin', 'vteam-role-guard.ts'))).toBe(
      false,
    );

    const manifest = readManifest(workDir);
    expect(manifest.agentNames).toEqual(['vteam-developer', 'vteam-tester']);
    expect(manifest.guardRolesFile).toBeUndefined();
    expect(manifest.guardSessionsDir).toBeUndefined();
    expect(manifest.guardPluginFile).toBeUndefined();

    const call = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes('/api/v1/agent-policies'),
    );
    const headers = (call?.[1] as { headers?: Record<string, string> })?.headers;
    expect(headers?.['x-worker-token']).toBe('tok');
    expect(headers?.['x-worker-id']).toBe('w_test');
  });

  it('(b) 幂等重跑：opencode.json 字节一致，无重复 plugin/agent 条目', async () => {
    const workDir = workDirFor();
    const injector = injectorForPolicies(workDir, POLICIES);
    await injector.injectAll();
    const first = fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8');
    await injector.injectAll();
    expect(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8')).toBe(first);
    expect(readConfig(workDir).plugin).toEqual(['oh-my-openagent@latest']);
    expect(readManifest(workDir).agentNames).toEqual(['vteam-developer', 'vteam-tester']);
  });

  it('(c) 空 agent 集 → 中性化：受管 agent 键移除，用户文件与 plugin 条目不受影响', async () => {
    const workDir = workDirFor();
    await injectorForPolicies(workDir, POLICIES).injectAll();
    fs.mkdirSync(path.join(workDir, '.opencode', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.opencode', 'tools', 'manual-tool.ts'), '// user\n', 'utf8');

    const report = await injectorForPolicies(workDir, { agents: [] }).injectAll();
    expect(report.agentPolicies).toEqual({ enabled: false, names: [] });

    const cfg = readConfig(workDir);
    expect(cfg.agent?.['vteam-developer']).toBeUndefined();
    expect(cfg.agent?.['vteam-tester']).toBeUndefined();
    expect(cfg.plugin).toEqual(['oh-my-openagent@latest']);
    expect(fs.existsSync(path.join(workDir, '.opencode', 'tools', 'manual-tool.ts'))).toBe(true);
    expect(readManifest(workDir).agentNames).toEqual([]);
  });

  it('(d) 拉取失败后再成功：agent 中性化 → 恢复，无 guard 残留', async () => {
    const workDir = workDirFor();
    await injectorForPolicies(workDir, POLICIES).injectAll();

    const okFetch = makeFetch(routesWith(POLICIES));
    const failingFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/agent-policies') {
        return { ok: false, status: 500, statusText: 'boom', json: async () => ({}) } as unknown as Response;
      }
      return okFetch(input, init);
    });
    const report = await injectorForPolicies(workDir, POLICIES, failingFetch).injectAll();
    expect(report.agentPolicies).toEqual({ enabled: false, names: [] });
    expect(readConfig(workDir).agent?.['vteam-developer']).toBeUndefined();

    const again = await injectorForPolicies(workDir, POLICIES).injectAll();
    expect(again.agentPolicies).toEqual({
      enabled: true,
      names: ['vteam-developer', 'vteam-tester'],
    });
    expect(fs.existsSync(path.join(workDir, '.vteam-role-guard'))).toBe(false);
  });

  it('(e) 持久卷残留被清除：roles.json/sessions/插件文件/plugin 条目/manifest 键', async () => {
    const workDir = workDirFor();
    const pluginRel = '.opencode/plugin/vteam-role-guard.ts';
    fs.mkdirSync(path.join(workDir, '.opencode', 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(workDir, pluginRel), '// legacy guard\n', 'utf8');
    fs.mkdirSync(path.join(workDir, '.vteam-role-guard', 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.vteam-role-guard', 'roles.json'),
      '{"enabled":true,"roles":{}}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({
        plugin: [`./${pluginRel}`, 'oh-my-openagent@latest', './mine.js'],
        agent: {},
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workDir, '.opencode-worker-inject.json'),
      JSON.stringify({
        agentNames: ['vteam-developer'],
        guardRolesFile: '.vteam-role-guard/roles.json',
        guardSessionsDir: '.vteam-role-guard/sessions',
        guardPluginFile: pluginRel,
      }),
      'utf8',
    );

    await injectorForPolicies(workDir, POLICIES).injectAll();

    expect(fs.existsSync(path.join(workDir, '.vteam-role-guard'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, pluginRel))).toBe(false);
    const cfg = readConfig(workDir);
    expect(cfg.plugin).toEqual(['oh-my-openagent@latest', './mine.js']);
    const manifest = readManifest(workDir);
    expect(manifest.guardRolesFile).toBeUndefined();
    expect(manifest.guardSessionsDir).toBeUndefined();
    expect(manifest.guardPluginFile).toBeUndefined();
    expect(manifest.agentNames).toEqual(['vteam-developer', 'vteam-tester']);
  });
});
