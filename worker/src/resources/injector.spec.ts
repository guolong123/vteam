import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InjectReport,
  readXExecution,
  ResourceInjector,
  schemaToArgs,
} from './injector';
import { OMO_AGENT_NAMES, omoConfigUserPath } from './omo-config';

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
  it('cli 工具（x-execution 命令）→ 写 <workDir>/.opencode/plugins/<action>.ts（v2 插件形态）', async () => {
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

    const filePath = path.join(workDir, '.opencode', 'plugins', 'jira-query.ts');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    // T19：产物形态 = v1/v2 双形态插件模块
    expect(content).toContain('Plugin.define');
    expect(content).toContain('ctx.tool.transform');
    expect(content).toContain('options: { codemode: false },');
    expect(content).toContain('if (!ctx?.tool?.transform) return');
    expect(content).toContain('name: "jira-query",');
    expect(content).toContain('spawnSync("jcli", ["issue", "get", ...cmdArgs], { encoding: "utf8" })');
    expect(content).toContain('jobName: tool.schema.string().describe("任务名")');
    // mcp 工具不写文件
    expect(fs.existsSync(path.join(workDir, '.opencode', 'plugins', 'github-create-issue.ts'))).toBe(false);
  });

  it('manifest 记录工具插件落点（toolPlugins），且不再声称写过 .opencode/tools/', async () => {
    const workDir = workDirFor();
    const fetchImpl = makeFetch({
      '/api/v1/tools': () => ({
        items: [
          {
            id: 'tl_1',
            action: 'jira-query',
            name: 'Jira 查询',
            execution: 'cli',
            schema: {
              type: 'object',
              properties: { jobName: { type: 'string' } },
              'x-execution': { command: ['jcli', 'issue', 'get'] },
            },
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
    await injector.injectTools();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workDir, '.opencode-worker-inject.json'), 'utf8'),
    );
    expect(manifest.toolPlugins).toEqual(['jira-query.ts']);
    expect(manifest.tools).toBeUndefined();
    expect(manifest.legacyTools).toEqual([]);
  });

  it('逐消息 system blob 的**插件交接产物**：写 <workDir>/.opencode/plugins/ 且 manifest 单列记账', async () => {
    const workDir = workDirFor();
    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: makeFetch({}),
    });
    const filePath = injector.applySystemHandoffPlugin();
    expect(filePath).toBe(
      path.join(workDir, '.opencode', 'plugins', 'vteam-system-handoff.ts'),
    );
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('Plugin.define({');
    expect(content).toContain('ctx.session.hook("context"');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workDir, '.opencode-worker-inject.json'), 'utf8'),
    );
    expect(manifest.systemHandoffPlugin).toBe('vteam-system-handoff.ts');
    // ⚠️ **不进** toolPlugins：那个键的清理语义会把"本次不在集合"的文件删掉 ⇒ 常驻插件会被误删
    expect(manifest.toolPlugins ?? []).not.toContain('vteam-system-handoff.ts');
  });

  it('工具插件清理**不误删**交接插件（它常驻，不在 toolPlugins 集合里）', async () => {
    const workDir = workDirFor();
    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: makeFetch({ '/api/v1/tools': () => ({ items: [], total: 0, page: 1, pageSize: 100 }) }),
    });
    injector.applySystemHandoffPlugin();
    await injector.injectTools();
    expect(
      fs.existsSync(path.join(workDir, '.opencode', 'plugins', 'vteam-system-handoff.ts')),
    ).toBe(true);
  });

  it('升级前的 v1 形态工具文件（.opencode/tools/）被清掉，用户手写文件保留', async () => {
    const workDir = workDirFor();
    const legacyDir = path.join(workDir, '.opencode', 'tools');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'old-tool.ts'), '// legacy v1 tool\n', 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'manual-tool.ts'), '// user\n', 'utf8');
    fs.writeFileSync(
      path.join(workDir, '.opencode-worker-inject.json'),
      JSON.stringify({ tools: ['old-tool.ts'] }),
      'utf8',
    );

    const fetchImpl = makeFetch({
      '/api/v1/tools': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
    });
    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl,
    });
    await injector.injectTools();

    expect(fs.existsSync(path.join(legacyDir, 'old-tool.ts'))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, 'manual-tool.ts'))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workDir, '.opencode-worker-inject.json'), 'utf8'),
    );
    expect(manifest.tools).toBeUndefined();
    expect(manifest.legacyTools).toEqual([]);
  });

  it('停用的工具：上次注入、本次不在集合 → 对应插件文件被删', async () => {
    const workDir = workDirFor();
    const toolItem = (action: string): unknown => ({
      id: `tl_${action}`,
      action,
      name: action,
      execution: 'cli',
      schema: {
        type: 'object',
        properties: {},
        'x-execution': { command: ['jcli', 'issue', 'get'] },
      },
    });
    const makeInjector = (actions: string[]): ResourceInjector =>
      new ResourceInjector({
        serverUrl: 'http://localhost:3000',
        workerToken: 'tok',
        workerId: 'w_test',
        workDir,
        fetchImpl: makeFetch({
          '/api/v1/tools': () => ({
            items: actions.map(toolItem),
            total: actions.length,
            page: 1,
            pageSize: 100,
          }),
        }),
      });

    await makeInjector(['a-tool', 'b-tool']).injectTools();
    expect(fs.existsSync(path.join(workDir, '.opencode', 'plugins', 'a-tool.ts'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.opencode', 'plugins', 'b-tool.ts'))).toBe(true);

    await makeInjector(['a-tool']).injectTools();
    expect(fs.existsSync(path.join(workDir, '.opencode', 'plugins', 'a-tool.ts'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.opencode', 'plugins', 'b-tool.ts'))).toBe(false);
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
    expect(fs.existsSync(path.join(workDir, '.opencode', 'plugins', 'ghost.ts'))).toBe(false);
  });
});

describe('ResourceInjector.injectMcp', () => {
  it('生成 opencode.json **mcp.servers** 节（v2 原生形；合并保留其他配置节 + local/remote 两型）', async () => {
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
    ) as { model?: string; mcp?: { servers?: Record<string, Record<string, unknown>> } };
    // 其他节保留
    expect(config.model).toBe('gpt-4o');
    // v2 原生：服务器在 mcp.servers 下；启用极性是 **disabled:false**（v1 是 enabled:true）
    expect(config.mcp?.servers?.filesystem).toEqual({
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/data'],
      disabled: false,
    });
    expect(config.mcp?.servers?.['gitee-remote']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/gitee',
      headers: { Authorization: 'Bearer {env:GITEE_TOKEN}' },
      // OAuth 字段 v2 是 snake_case（camelCase 会被 v2 忽略）
      oauth: { client_id: 'cid', scope: 'tools:read' },
      disabled: false,
    });
    // v1 扁平形不得残留（残留 = 归一化 + 双份定义）
    expect((config.mcp as Record<string, unknown>)['filesystem']).toBeUndefined();
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
    ) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
    expect(config.mcp?.servers?.vteam).toMatchObject({
      type: 'remote',
      url: 'https://vteam.example.com/api/v1/platform-mcp',
      headers: {
        'x-worker-id': 'w_external',
        'x-worker-token': 'tok-secret',
        Authorization: 'Bearer {env:UNKNOWN_VAR}',
      },
      disabled: false,
    });
  });

  it('local 型透传 cwd/environment/timeout（**timeout 是 v2 三段**；disabled 恒 false 因已过滤启用集）', async () => {
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
    ) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
    expect(config.mcp?.servers?.['rich-local']).toEqual({
      type: 'local',
      command: ['node', 'server.js'],
      cwd: '/opt/mcp',
      environment: { MY_ENV: 'v1' },
      // v2 三段 timeout：startup 段不得缺失（v1 单值归一化会丢它）
      timeout: { startup: 5000, catalog: 5000, execution: 5000 },
      disabled: false,
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
      mcp: { servers: Record<string, unknown> };
    };
    config.mcp.servers['manual-server'] = { type: 'remote', url: 'https://user.example.com' };
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
      mcp: { servers: Record<string, unknown> };
    };
    // 停用清理：filesystem 移除
    expect(after.mcp.servers.filesystem).toBeUndefined();
    // 用户手动配置保留
    expect(after.mcp.servers['manual-server']).toEqual({
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
    ) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
    expect(config.mcp?.servers?.['gitee-remote']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/gitee',
      headers: { Authorization: 'Bearer {env:GITEE_TOKEN}' },
      oauth: { client_id: 'cid', scope: 'tools:read' },
      timeout: { startup: 8000, catalog: 8000, execution: 8000 },
      disabled: false,
    });
  });

  /**
   * sensitive-command-tool todo 6：注入的 vteam 远端条目必须带显式 timeout 下限。
   * secret_command 阻塞工具最坏总预算 855s（540s 输入 + 300s 命令 + 15s 裕量），
   * 依赖 OpenCode 客户端默认超时会把调用在 855s 前掐断 → 必须硬编码 ≥900000ms。
   */
  describe('vteam 远端条目显式 timeout 下限（secret_command 阻塞调用）', () => {
    const injectVteam = async (
      record: Record<string, unknown>,
      env?: string,
    ): Promise<Record<string, unknown> | undefined> => {
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
              headers: null,
              oauth: null,
              ...record,
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
      const previous = process.env.VTEAM_MCP_TIMEOUT_MS;
      if (env === undefined) {
        delete process.env.VTEAM_MCP_TIMEOUT_MS;
      } else {
        process.env.VTEAM_MCP_TIMEOUT_MS = env;
      }
      try {
        await injector.injectMcp();
      } finally {
        if (previous === undefined) {
          delete process.env.VTEAM_MCP_TIMEOUT_MS;
        } else {
          process.env.VTEAM_MCP_TIMEOUT_MS = previous;
        }
      }
      const config = JSON.parse(
        fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'),
      ) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
      return config.mcp?.servers?.vteam;
    };

    it('缺省注入 timeout >= 900000（覆盖 855s 最坏总预算，不依赖 OpenCode 默认值）', async () => {
      const entry = await injectVteam({});
      expect(entry).toBeDefined();
      // v2 三段 timeout：每段都取同一个下限值（startup 段不得缺失）
      expect(entry?.timeout).toEqual({
        startup: 900_000,
        catalog: 900_000,
        execution: 900_000,
      });
      expect(entry).toMatchObject({
        type: 'remote',
        url: 'https://vteam.example.com/api/v1/platform-mcp',
        disabled: false,
      });
    });

    it('服务端已给 timeout 时仍 clamp 到下限（服务端 30000 → 900000）', async () => {
      const entry = await injectVteam({ timeout: 30_000 });
      expect(entry?.timeout).toMatchObject({ execution: 900_000 });
    });

    it('VTEAM_MCP_TIMEOUT_MS 覆盖且 clamp：1200000 原样生效、1000 抬到 900000、垃圾值回落缺省 900000', async () => {
      expect((await injectVteam({}, '1200000'))?.timeout).toMatchObject({
        execution: 1_200_000,
      });
      expect((await injectVteam({}, '1000'))?.timeout).toMatchObject({
        execution: 900_000,
      });
      expect((await injectVteam({}, 'not-a-number'))?.timeout).toMatchObject({
        execution: 900_000,
      });
    });

    it('非 vteam 远端条目不受下限影响（服务端 timeout 原样 / 缺省不写）', async () => {
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
              headers: null,
              oauth: null,
              timeout: 8000,
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
      ) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
      expect(config.mcp?.servers?.['gitee-remote']).toMatchObject({
        timeout: { startup: 8000, catalog: 8000, execution: 8000 },
      });
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
    ) as { mcp?: { servers?: Record<string, unknown> } };
    expect(config.mcp?.servers?.['broken-local']).toBeUndefined();
    expect(config.mcp?.servers?.['broken-remote']).toBeUndefined();
    expect(config.mcp?.servers?.['ok-local']).toBeDefined();
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

  describe('plugins 节（opencode.json，v2 原生段名）', () => {
    it('写入 oh-my-openagent 条目', async () => {
      const workDir = workDirFor();
      await injectorFor(workDir).injectMcp();
      expect(readJson(workDir, 'opencode.json').plugins).toEqual([
        'oh-my-openagent@latest',
        '-opencode.browser',
      ]);
    });

    it('禁用 v2 内置浏览器插件（否则平台的 browser 工具被同名内置工具**静默遮蔽**）', async () => {
      const workDir = workDirFor();
      await injectorFor(workDir).injectMcp();
      // 内置 opencode.browser 插件注册了一个名为 `browser` 的工具 → 与平台自己的
      // browser 工具（agent-browser）同名冲突：平台工具进注册表但**不进模型的 tools[]**
      // → 模型永远调不到，且全程无报错。精确 id 禁用是 T6 验证过的安全手段。
      expect(readJson(workDir, 'opencode.json').plugins).toContain('-opencode.browser');
    });

    it('重复注入不追加重复条目（幂等）', async () => {
      const workDir = workDirFor();
      const injector = injectorFor(workDir);
      await injector.injectMcp();
      await injector.injectMcp();
      expect(readJson(workDir, 'opencode.json').plugins).toEqual([
        'oh-my-openagent@latest',
        '-opencode.browser',
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
        expect(readJson(workDir, 'opencode.json').plugins).toEqual([
          entry,
          '-opencode.browser',
        ]);
      }
    });

    it('用户手写的其他 plugin 条目保留，OmO 追加在后', async () => {
      const workDir = workDirFor();
      fs.writeFileSync(
        path.join(workDir, 'opencode.json'),
        JSON.stringify({ plugin: ['./my-local-plugin.js'] }),
      );
      await injectorFor(workDir).injectMcp();
      expect(readJson(workDir, 'opencode.json').plugins).toEqual([
        './my-local-plugin.js',
        'oh-my-openagent@latest',
        '-opencode.browser',
      ]);
    });
  });

  describe('agent→模型配置（落点：用户级 ~/.omo/omo.jsonc）', () => {
    let omoDir: string;
    let prevOmoDir: string | undefined;

    beforeEach(() => {
      omoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-dir-'));
      prevOmoDir = process.env.OMO_CONFIG_DIR;
      process.env.OMO_CONFIG_DIR = omoDir;
    });

    afterEach(() => {
      if (prevOmoDir === undefined) delete process.env.OMO_CONFIG_DIR;
      else process.env.OMO_CONFIG_DIR = prevOmoDir;
    });

    /** 用户级配置绝对路径（惰性读 $HOME，必须在 beforeEach 之后调用）。 */
    const userCfgPath = (): string => omoConfigUserPath();
    const readUserCfg = (): any => JSON.parse(fs.readFileSync(userCfgPath(), 'utf8'));

    it('无任何文件时：新建到用户级 ~/.omo/omo.jsonc，工作目录不留配置', async () => {
      const workDir = workDirFor();
      const written = await injectorFor(workDir).writeOmoConfig({
        sisyphus: 'opencode/big-pickle',
      });
      expect(written).toBe(userCfgPath());
      expect(readUserCfg()).toEqual({
        agents: { sisyphus: { model: 'opencode/big-pickle' } },
      });
      expect(fs.existsSync(path.join(workDir, '.omo', 'omo.jsonc'))).toBe(false);
    });

    it('用户级已存在 → 写用户级，保留 [opencode] 段其他键与 _migrations', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.dirname(userCfgPath()), { recursive: true });
      fs.writeFileSync(
        userCfgPath(),
        JSON.stringify({ '[opencode]': { agents: {} }, _migrations: ['x'] }),
      );
      const written = await injectorFor(workDir).writeOmoConfig({
        atlas: 'opencode/big-pickle',
      });
      expect(written).toBe(userCfgPath());
      const cfg = readUserCfg();
      expect(cfg['[opencode]'].agents.atlas).toEqual({
        model: 'opencode/big-pickle',
      });
      expect(cfg._migrations).toEqual(['x']);
    });

    it('历史落点（工作目录 .omo/omo.jsonc）→ 迁移到用户级并删除旧文件', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.join(workDir, '.omo'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.omo', 'omo.jsonc'),
        JSON.stringify({
          '[opencode]': { agents: { sisyphus: { model: 'old/win' } } },
        }),
      );
      const injector = injectorFor(workDir);
      expect(injector.readOmoConfig()).toEqual({ sisyphus: 'old/win' });

      const written = await injector.writeOmoConfig({ atlas: 'a/b' });

      expect(written).toBe(userCfgPath());
      expect(fs.existsSync(path.join(workDir, '.omo', 'omo.jsonc'))).toBe(false);
      expect(readUserCfg()['[opencode]'].agents.sisyphus).toEqual({
        model: 'old/win',
      });
    });

    it('更早的历史落点（工作目录 .opencode/oh-my-openagent.jsonc）同样迁移', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.opencode', 'oh-my-openagent.jsonc'),
        JSON.stringify({ agents: { oracle: { model: 'a/b' } } }),
      );
      const injector = injectorFor(workDir);
      expect(injector.readOmoConfig()).toEqual({ oracle: 'a/b' });

      const written = await injector.writeOmoConfig({ atlas: 'a/b' });

      expect(written).toBe(userCfgPath());
      expect(
        fs.existsSync(path.join(workDir, '.opencode', 'oh-my-openagent.jsonc')),
      ).toBe(false);
    });

    it('用户级已存在时工作目录历史文件不干扰（不迁移、不覆盖）', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.dirname(userCfgPath()), { recursive: true });
      fs.writeFileSync(
        userCfgPath(),
        JSON.stringify({
          '[opencode]': { agents: { sisyphus: { model: 'user/win' } } },
        }),
      );
      fs.mkdirSync(path.join(workDir, '.omo'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.omo', 'omo.jsonc'),
        JSON.stringify({ agents: { sisyphus: { model: 'stale/lose' } } }),
      );
      const injector = injectorFor(workDir);
      expect(injector.readOmoConfig()).toEqual({ sisyphus: 'user/win' });

      await injector.writeOmoConfig({ atlas: 'a/b' });

      expect(readUserCfg()['[opencode]'].agents.sisyphus).toEqual({
        model: 'user/win',
      });
    });

    it('读旧格式（顶层 agents）与新格式（[opencode].agents）都认', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.dirname(userCfgPath()), { recursive: true });
      fs.writeFileSync(
        userCfgPath(),
        JSON.stringify({ agents: { oracle: { model: 'a/b' } } }),
      );
      expect(injectorFor(workDir).readOmoConfig()).toEqual({ oracle: 'a/b' });

      fs.writeFileSync(
        userCfgPath(),
        JSON.stringify({ '[opencode]': { agents: { oracle: { model: 'c/d' } } } }),
      );
      expect(injectorFor(workDir).readOmoConfig()).toEqual({ oracle: 'c/d' });
    });

    it('JSONC 注释与尾逗号可解析', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.dirname(userCfgPath()), { recursive: true });
      fs.writeFileSync(
        userCfgPath(),
        `// OMO configuration\n{\n  "[opencode]": {\n    "agents": {\n      "sisyphus": { "model": "a/b" },\n    },\n  },\n}\n`,
      );
      expect(injectorFor(workDir).readOmoConfig()).toEqual({ sisyphus: 'a/b' });
    });

    it('增量合并：只改传入项，其余保留；空串清除覆盖', async () => {
      const workDir = workDirFor();
      const injector = injectorFor(workDir);
      await injector.writeOmoConfig({ sisyphus: 'a/one', atlas: 'a/two' });
      await injector.writeOmoConfig({ sisyphus: 'b/three' });
      expect(injector.readOmoConfig()).toEqual({
        sisyphus: 'b/three',
        atlas: 'a/two',
      });
      await injector.writeOmoConfig({ sisyphus: '' });
      expect(injector.readOmoConfig()).toEqual({ atlas: 'a/two' });
    });

    it('保留 agent 的其他键（variant），只覆盖 model', async () => {
      const workDir = workDirFor();
      fs.mkdirSync(path.dirname(userCfgPath()), { recursive: true });
      fs.writeFileSync(
        userCfgPath(),
        JSON.stringify({
          '[opencode]': {
            agents: { sisyphus: { model: 'old/m', variant: 'high' } },
          },
        }),
      );
      await injectorFor(workDir).writeOmoConfig({ sisyphus: 'new/m' });
      expect(readUserCfg()['[opencode]'].agents.sisyphus).toEqual({
        model: 'new/m',
        variant: 'high',
      });
    });

    it('文件不存在/损坏 → readOmoConfig 返回空对象不抛错', () => {
      const workDir = workDirFor();
      expect(injectorFor(workDir).readOmoConfig()).toEqual({});
      fs.mkdirSync(path.dirname(userCfgPath()), { recursive: true });
      fs.writeFileSync(userCfgPath(), '{ broken');
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
    expect(cfg.plugins).toEqual(['oh-my-openagent@latest', '-opencode.browser']);
    expect(JSON.stringify(cfg.plugins)).not.toContain('slim');
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
    expect(cfg.plugins).toEqual(['oh-my-openagent@latest', './mine.js', '-opencode.browser']);
  });
});

describe('ResourceInjector：agent 策略注入（v2 原生 **agents** 节，无 guard 制品）', () => {
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

  /** v2 原生的 agent 条目（权限是**数组**）。 */
  const V2_ENTRY = {
    description: 'dev scope',
    mode: 'primary',
    permissions: [
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
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

  it('(a) 一次运行：mcp.servers + plugins + **agents** 三节，无 guard 制品写入', async () => {
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
    expect(cfg.mcp?.servers?.vteam).toBeDefined();
    expect(cfg.plugins).toEqual(['oh-my-openagent@latest', '-opencode.browser']);
    expect(cfg.agents['vteam-developer']).toEqual(V2_ENTRY);
    expect(cfg.agents['vteam-tester']).toBeDefined();
    // 用户手写的 v1 `agent:` 节被**迁移**进 `agents:`（用户条目保留）
    expect(cfg.agents['my-agent']).toBeDefined();
    // v1 段名不得残留（残留 = 双份定义 + 静默归一化）
    expect(cfg.agent).toBeUndefined();
    expect(cfg.plugin).toBeUndefined();
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
    expect(readConfig(workDir).plugins).toEqual(['oh-my-openagent@latest', '-opencode.browser']);
    expect(readManifest(workDir).agentNames).toEqual(['vteam-developer', 'vteam-tester']);
  });

  it('(c) 空 agent 集 → 中性化：受管 agent 键移除，用户文件与 plugin 条目不受影响', async () => {
    const workDir = workDirFor();
    await injectorForPolicies(workDir, POLICIES).injectAll();
    fs.mkdirSync(path.join(workDir, '.opencode', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.opencode', 'plugins', 'manual-tool.ts'), '// user\n', 'utf8');

    const report = await injectorForPolicies(workDir, { agents: [] }).injectAll();
    expect(report.agentPolicies).toEqual({ enabled: false, names: [] });

    const cfg = readConfig(workDir);
    expect(cfg.agents?.['vteam-developer']).toBeUndefined();
    expect(cfg.agents?.['vteam-tester']).toBeUndefined();
    expect(cfg.plugins).toEqual(['oh-my-openagent@latest', '-opencode.browser']);
    expect(fs.existsSync(path.join(workDir, '.opencode', 'plugins', 'manual-tool.ts'))).toBe(true);
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
    expect(readConfig(workDir).agents?.['vteam-developer']).toBeUndefined();

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
    expect(cfg.plugins).toEqual(['oh-my-openagent@latest', './mine.js', '-opencode.browser']);
    const manifest = readManifest(workDir);
    expect(manifest.guardRolesFile).toBeUndefined();
    expect(manifest.guardSessionsDir).toBeUndefined();
    expect(manifest.guardPluginFile).toBeUndefined();
    expect(manifest.agentNames).toEqual(['vteam-developer', 'vteam-tester']);
  });
});

describe('ResourceInjector：T15 —— 写出的 opencode.json 必须是 **v2 原生形状**', () => {
  const POLICIES_WITH_PROMPT = {
    agents: [
      {
        name: 'vteam-developer',
        description: 'dev scope',
        mode: 'primary',
        permission: { edit: { '*': 'deny' }, bash: 'ask' },
        prompt: '你是 vteam-developer',
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

  function injectorFor(workDir: string, policies: unknown = POLICIES_WITH_PROMPT): ResourceInjector {
    return new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: makeFetch(routesWith(policies)),
    });
  }

  function readConfig(workDir: string): any {
    return JSON.parse(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8'));
  }

  it('**回归闸门**：最终 opencode.json 的 agents 节里**没有 prompt 键**（v2 会静默丢弃它）', async () => {
    const workDir = workDirFor();
    await injectorFor(workDir).injectAll();
    const cfg = readConfig(workDir);
    for (const entry of Object.values<any>(cfg.agents)) {
      expect(Object.keys(entry)).not.toContain('prompt');
    }
    // 角色提示落在 v2 原生键 system 上
    expect(cfg.agents['vteam-developer'].system).toBe('你是 vteam-developer');
    expect(JSON.stringify(cfg)).not.toContain('"prompt"');
  });

  it('**回归闸门**：最终 opencode.json 里**没有 v1 段名**（agent / plugin / 扁平 mcp）', async () => {
    const workDir = workDirFor();
    await injectorFor(workDir).injectAll();
    const cfg = readConfig(workDir);
    expect(cfg.agent).toBeUndefined();
    expect(cfg.plugin).toBeUndefined();
    expect(Object.keys(cfg.mcp)).toEqual(['servers']);
    expect(cfg.plugins).toEqual(['oh-my-openagent@latest', '-opencode.browser']);
  });

  it('mcp 条目是 v2 原生形：disabled 极性 + 三段 timeout + snake_case OAuth', async () => {
    const workDir = workDirFor();
    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_test',
      workDir,
      fetchImpl: makeFetch({
        '/api/v1/mcp-servers': () => ({
          items: [
            {
              id: 'ms_1',
              name: 'vteam',
              type: 'remote',
              command: null,
              url: 'https://vteam.example.com/api/v1/platform-mcp',
              headers: null,
              oauth: { clientId: 'cid', clientSecret: 'sec', callbackPort: 19876 },
              enabled: true,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 100,
        }),
      }),
    });
    await injector.injectMcp();
    const entry = readConfig(workDir).mcp.servers.vteam;
    expect(entry.disabled).toBe(false);
    expect(entry.timeout).toEqual({
      startup: 900_000,
      catalog: 900_000,
      execution: 900_000,
    });
    expect(entry.oauth).toEqual({
      client_id: 'cid',
      client_secret: 'sec',
      callback_port: 19876,
    });
  });

  it('**一次性迁移**：持久卷上的 v1 形配置被迁到 v2 段名（不留 v1 段、不留 `agents.<n>.prompt`）', async () => {
    const workDir = workDirFor();
    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({
        plugin: ['oh-my-openagent@latest'],
        agent: {
          'legacy-agent': {
            description: 'legacy',
            mode: 'primary',
            permission: { edit: { '*': 'deny' } },
            prompt: 'LEGACY_ROLE_PROMPT',
          },
        },
        mcp: {
          'legacy-server': { type: 'remote', url: 'https://legacy.example.com', enabled: true },
        },
      }),
      'utf8',
    );
    await injectorFor(workDir).injectAll();
    const cfg = readConfig(workDir);
    // v1 段名全部迁走
    expect(cfg.agent).toBeUndefined();
    expect(cfg.plugin).toBeUndefined();
    expect(cfg.mcp['legacy-server']).toBeUndefined();
    // v1 `prompt` 键被搬进 v2 的 `system`（不丢角色提示）
    expect(cfg.agents['legacy-agent'].system).toBe('LEGACY_ROLE_PROMPT');
    expect(cfg.agents['legacy-agent'].prompt).toBeUndefined();
    // v1 permission 对象 → v2 permissions[]
    expect(cfg.agents['legacy-agent'].permissions).toContainEqual({
      action: 'edit',
      resource: '*',
      effect: 'deny',
    });
    // v1 扁平 mcp → v2 mcp.servers（enabled → disabled 极性反转、timeout 三段）
    expect(cfg.mcp.servers['legacy-server']).toEqual({
      type: 'remote',
      url: 'https://legacy.example.com',
      disabled: false,
    });
  });

  it('**迁移幂等**：第二次注入不改变文件字节（迁移不重复叠加）', async () => {
    const workDir = workDirFor();
    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({
        agent: { 'legacy-agent': { description: 'legacy', mode: 'primary', permission: {} } },
        mcp: { 'legacy-server': { type: 'remote', url: 'https://legacy.example.com' } },
      }),
      'utf8',
    );
    const injector = injectorFor(workDir);
    await injector.injectAll();
    const first = fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8');
    await injector.injectAll();
    expect(fs.readFileSync(path.join(workDir, 'opencode.json'), 'utf8')).toBe(first);
  });
});
