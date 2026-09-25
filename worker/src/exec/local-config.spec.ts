/**
 * 本地配置下推（独立模式 /config/*）单元测试：入参校验 + 分派 + 声明式替换语义。
 * - os.homedir 用模块级 mock（jest 下不可 spy），默认回落真实值以免模块级常量崩；
 * - 模型凭据的两个写盘函数以 mock 隔离（避免触碰真实 ~/.config/opencode）；
 * - git 凭据走真实写盘（homedir 被 mock 到临时目录）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeAuthJson, writeOpencodeConfig } from '../credentials/model-credential-injector';
import { ResourceInjector } from '../resources/injector';
import { LocalConfigApplier, LocalConfigError } from './local-config';

jest.mock('os', () => {
  const actual = jest.requireActual<typeof os>('os');
  return { ...actual, homedir: jest.fn(() => actual.homedir()) };
});

jest.mock('../credentials/model-credential-injector', () => {
  const actual = jest.requireActual('../credentials/model-credential-injector');
  return {
    ...actual,
    writeAuthJson: jest.fn(() => ({ authJsonPath: '/fake/auth.json' })),
    writeOpencodeConfig: jest.fn(() => ({ changed: true, path: '/fake/opencode.json' })),
  };
});

const mockHomedir = os.homedir as jest.Mock;
const mockWriteAuthJson = writeAuthJson as jest.Mock;
const mockWriteOpencodeConfig = writeOpencodeConfig as jest.Mock;

let tmpRoot: string;
let workDir: string;
let homeDir: string;
let applier: LocalConfigApplier;

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-config-'));
  workDir = path.join(tmpRoot, 'work');
  homeDir = path.join(tmpRoot, 'home');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  mockHomedir.mockReturnValue(homeDir);
  mockWriteAuthJson.mockClear();
  mockWriteOpencodeConfig.mockClear();
  applier = new LocalConfigApplier({
    injector: new ResourceInjector({
      serverUrl: 'http://unused',
      workerToken: 't',
      workerId: 'w',
      workDir,
    }),
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('applySkills', () => {
  it('写入 SKILL.md 并返回名；再次调用为声明式替换（旧目录被清）', () => {
    const first = applier.applySkills({ skills: [{ name: 'sk-a', content: '# A' }] });
    expect(first).toEqual({ written: { skills: ['sk-a'] }, restart: 'required' });
    expect(fs.readFileSync(path.join(workDir, '.opencode/skills/sk-a/SKILL.md'), 'utf8')).toBe('# A');

    applier.applySkills({ skills: [{ name: 'sk-b', content: '# B' }] });
    expect(fs.existsSync(path.join(workDir, '.opencode/skills/sk-a'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, '.opencode/skills/sk-b/SKILL.md'))).toBe(true);
  });

  it('空数组 = 清空受管技能', () => {
    applier.applySkills({ skills: [{ name: 'sk-a', content: '# A' }] });
    applier.applySkills({ skills: [] });
    expect(fs.existsSync(path.join(workDir, '.opencode/skills/sk-a'))).toBe(false);
  });

  it('技能名非法（路径穿越/空）→ LocalConfigError', () => {
    expect(() => applier.applySkills({ skills: [{ name: '../evil', content: 'x' }] })).toThrow(
      LocalConfigError,
    );
    expect(() => applier.applySkills({ skills: [{ name: '', content: 'x' }] })).toThrow(
      LocalConfigError,
    );
  });

  it('缺 skills 数组 / 缺 content → LocalConfigError', () => {
    expect(() => applier.applySkills({})).toThrow(LocalConfigError);
    expect(() => applier.applySkills({ skills: [{ name: 'ok' }] })).toThrow(LocalConfigError);
  });
});

describe('applyTools', () => {
  it('cli + x-execution 渲染为 .opencode/tools/<action>.ts', () => {
    const result = applier.applyTools({
      tools: [
        {
          action: 'demo-echo',
          execution: 'cli',
          name: 'Demo Echo',
          schema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            'x-execution': { command: ['echo'] },
          },
        },
      ],
    });
    expect(result.written).toEqual({ tools: ['demo-echo'] });
    expect(fs.existsSync(path.join(workDir, '.opencode/tools/demo-echo.ts'))).toBe(true);
  });

  it('缺执行细节（无 x-execution）→ 跳过不落盘（不报错）', () => {
    const result = applier.applyTools({ tools: [{ action: 'noexec', execution: 'cli' }] });
    expect(result.written).toEqual({ tools: [] });
    expect(fs.existsSync(path.join(workDir, '.opencode/tools/noexec.ts'))).toBe(false);
  });

  it('缺 action → LocalConfigError', () => {
    expect(() => applier.applyTools({ tools: [{ execution: 'cli' }] })).toThrow(LocalConfigError);
  });
});

describe('applyMcpServers / applyAgentPolicies（互不覆盖）', () => {
  it('写 mcp 节保留 agent 节；写 agent 节保留 mcp 节', () => {
    applier.applyAgentPolicies({
      agents: [{ name: 'ag-1', description: 'd', mode: 'primary', permission: { edit: 'allow' } }],
    });
    applier.applyMcpServers({
      mcpServers: [{ id: 'm1', name: 'mcp-1', type: 'remote', url: 'http://x/mcp' }],
    });

    const config = readJson(path.join(workDir, 'opencode.json'));
    expect(Object.keys(config.mcp as Record<string, unknown>)).toContain('mcp-1');
    expect(Object.keys(config.agent as Record<string, unknown>)).toContain('ag-1');
  });

  it('agent 定义非法（缺 description）→ LocalConfigError', () => {
    expect(() =>
      applier.applyAgentPolicies({ agents: [{ name: 'ag', mode: 'primary', permission: {} }] }),
    ).toThrow(LocalConfigError);
  });

  it('mcp type 非 local|remote → LocalConfigError', () => {
    expect(() => applier.applyMcpServers({ mcpServers: [{ name: 'm', type: 'weird' }] })).toThrow(
      LocalConfigError,
    );
  });
});

describe('applyModelCredentials / applyGitCredentials', () => {
  it('调用两个写盘器（auth.json + provider 段）并返回路径；restart required', () => {
    const result = applier.applyModelCredentials({
      providerKeys: [{ providerID: 'p1', key: 'sk-1' }],
      providerConfigs: { p1: { baseUrl: 'http://base/v1', models: ['m1'] } },
    });
    expect(result.restart).toBe('required');
    expect(result.written).toEqual({
      authJsonPath: '/fake/auth.json',
      opencodeConfigPath: '/fake/opencode.json',
    });
    expect(mockWriteAuthJson).toHaveBeenCalledWith([{ providerID: 'p1', key: 'sk-1' }]);
    expect(mockWriteOpencodeConfig).toHaveBeenCalledTimes(1);
  });

  it('不传 providerConfigs → 不触碰 opencode.json', () => {
    const result = applier.applyModelCredentials({ providerKeys: [{ providerID: 'p', key: 'k' }] });
    expect(result.written).toEqual({ authJsonPath: '/fake/auth.json', opencodeConfigPath: null });
    expect(mockWriteOpencodeConfig).not.toHaveBeenCalled();
  });

  it('缺 providerKeys / 缺 key → LocalConfigError', () => {
    expect(() => applier.applyModelCredentials({})).toThrow(LocalConfigError);
    expect(() => applier.applyModelCredentials({ providerKeys: [{ providerID: 'p' }] })).toThrow(
      LocalConfigError,
    );
  });

  it('git 凭据写 $HOME/.keta-git-creds.json；restart not-required', () => {
    const result = applier.applyGitCredentials({
      credentials: [{ repoUrl: 'git@x:o/r.git', key: 'K', authType: 'ssh_key', fingerprint: 'fp' }],
    });
    expect(result.restart).toBe('not-required');
    const file = readJson(path.join(homeDir, '.keta-git-creds.json'));
    const entries = file.credentials as Array<Record<string, unknown>>;
    expect(entries[0].repoUrl).toBe('git@x:o/r.git');
  });

  it('缺 repoUrl → LocalConfigError', () => {
    expect(() => applier.applyGitCredentials({ credentials: [{ key: 'K' }] })).toThrow(
      LocalConfigError,
    );
  });
});
