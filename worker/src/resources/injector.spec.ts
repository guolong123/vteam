import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InjectReport,
  readXExecution,
  ResourceInjector,
  schemaToArgs,
} from './injector';

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
