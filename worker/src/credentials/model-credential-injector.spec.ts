/**
 * model-credential-injector 单测（C5b）：auth.json 格式（{providerID:{type:'api',key}}）、
 * 600 权限、固定写入 $HOME/.local/share/opencode/auth.json（opencode 1.18.16 实测路径）、
 * cleanup 幂等且只删 auth.json 文件不删目录；C6：opencode.json provider 段
 * 组装/合并/写入（幂等）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AUTH_FILE_MODE,
  AuthJsonResult,
  buildAuthJson,
  buildProviderSection,
  cleanupAuthJson,
  DEFAULT_OPENCODE_CONFIG_PATH,
  mergeProviderSection,
  ModelCredentialEntry,
  writeAuthJson,
  writeOpencodeConfig,
} from './model-credential-injector';

// os.homedir 在 Node 中是只读 getter，jest.spyOn 无法替换 → 模块级部分 mock
// （默认代理真实实现，beforeAll 再 mockReturnValue 指向临时 HOME）。
jest.mock('os', () => {
  const actual = jest.requireActual('os') as typeof os;
  return { ...actual, homedir: jest.fn(actual.homedir) };
});

/** 用临时目录 mock os.homedir()（测试不触碰真实 $HOME）。 */
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-injector-test-'));
const AUTH_JSON_PATH = path.join(TMP_HOME, '.local', 'share', 'opencode', 'auth.json');
const OPENCODE_DATA_DIR = path.dirname(AUTH_JSON_PATH);

beforeAll(() => {
  (os.homedir as jest.Mock).mockReturnValue(TMP_HOME);
});

afterEach(() => {
  cleanupAuthJson(AUTH_JSON_PATH);
  fs.rmSync(DEFAULT_OPENCODE_CONFIG_PATH, { force: true });
});

afterAll(() => {
  (os.homedir as jest.Mock).mockRestore();
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('buildAuthJson（实测格式 {providerID:{type:"api",key}}）', () => {
  it('单凭据 → 标准格式 map', () => {
    const json = buildAuthJson([{ providerID: 'opencode-go', key: 'sk-secret' }]);
    expect(JSON.parse(json)).toEqual({
      'opencode-go': { type: 'api', key: 'sk-secret' },
    });
  });

  it('多凭据按 providerID 聚合', () => {
    const entries: ModelCredentialEntry[] = [
      { providerID: 'opencode-go', key: 'sk-a' },
      { providerID: 'opencode', key: 'sk-b' },
    ];
    const parsed = JSON.parse(buildAuthJson(entries)) as Record<string, unknown>;
    expect(parsed['opencode-go']).toEqual({ type: 'api', key: 'sk-a' });
    expect(parsed.opencode).toEqual({ type: 'api', key: 'sk-b' });
  });

  it('空/空白 providerID 或空 key 的条目被跳过（防御脏负载不产生非法 JSON）', () => {
    const json = buildAuthJson([
      { providerID: '  ', key: 'sk-x' },
      { providerID: 'opencode', key: '' },
      { providerID: 'opencode-go', key: 'sk-ok' },
    ] as ModelCredentialEntry[]);
    expect(JSON.parse(json)).toEqual({
      'opencode-go': { type: 'api', key: 'sk-ok' },
    });
  });

  it('空列表 → 空对象（无凭据时删除/空 auth.json 语义）', () => {
    expect(JSON.parse(buildAuthJson([]))).toEqual({});
  });
});

describe('writeAuthJson（600 权限 + 固定 $HOME/.local/share/opencode 路径）', () => {
  it('写入 $HOME/.local/share/opencode/auth.json，权限 600，内容正确', () => {
    const result = writeAuthJson([{ providerID: 'deepseek', key: 'sk-123' }]);
    expect(result.authJsonPath).toBe(AUTH_JSON_PATH);
    expect(fs.existsSync(result.authJsonPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(result.authJsonPath, 'utf8'))).toEqual({
      deepseek: { type: 'api', key: 'sk-123' },
    });
  });

  it('文件权限 = 0o600（仅属主读写，明文 key 唯一防线）', () => {
    const result = writeAuthJson([{ providerID: 'x', key: 'sk' }]);
    const mode = fs.statSync(result.authJsonPath).mode & 0o777;
    expect(mode).toBe(AUTH_FILE_MODE);
  });

  it('写前自动 mkdir -p $HOME/.local/share/opencode/（目录缺失也能写）', () => {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
    const result = writeAuthJson([{ providerID: 'x', key: 'sk' }]);
    expect(result.authJsonPath).toBe(AUTH_JSON_PATH);
    expect(fs.existsSync(result.authJsonPath)).toBe(true);
  });

  it('固定路径重复写覆盖旧内容（新凭据替换旧凭据）', () => {
    writeAuthJson([{ providerID: 'a', key: 'sk-old' }]);
    const second = writeAuthJson([{ providerID: 'a', key: 'sk-new' }]);
    expect(second.authJsonPath).toBe(AUTH_JSON_PATH);
    expect(JSON.parse(fs.readFileSync(second.authJsonPath, 'utf8'))).toEqual({
      a: { type: 'api', key: 'sk-new' },
    });
  });
});

describe('cleanupAuthJson（幂等删除，只删 auth.json 文件不删目录）', () => {
  it('删除 auth.json 文件但保留 $HOME/.local/share/opencode 目录（含 opencode.db 会话库）', () => {
    const result = writeAuthJson([{ providerID: 'a', key: 'sk' }]);
    expect(fs.existsSync(result.authJsonPath)).toBe(true);
    cleanupAuthJson(result.authJsonPath);
    expect(fs.existsSync(result.authJsonPath)).toBe(false);
    expect(fs.existsSync(OPENCODE_DATA_DIR)).toBe(true);
  });

  it('文件不存在时静默忽略（幂等，不抛错）', () => {
    expect(() =>
      cleanupAuthJson(path.join(TMP_HOME, 'no-such-auth.json')),
    ).not.toThrow();
  });

  it('空路径静默忽略', () => {
    expect(() => cleanupAuthJson('')).not.toThrow();
  });
});

describe('buildProviderSection（C6：opencode.json provider 段组装）', () => {
  it('有效条目 → 单数 provider key + npm + options.baseURL + models map（opencode 1.18.31 实测格式）', () => {
    const section = buildProviderSection({
      'my-local': { baseUrl: 'http://192.168.10.10:18020/v1', models: ['qwen3.8-27b'] },
    });
    expect(section).toEqual({
      'my-local': {
        npm: '@ai-sdk/openai-compatible',
        name: 'my-local',
        options: { baseURL: 'http://192.168.10.10:18020/v1' },
        models: { 'qwen3.8-27b': {} },
      },
    });
  });

  it('C8：新形状 models Record + 全量能力 → camelCase 译为 opencode snake_case（toolCall→tool_call）', () => {
    const section = buildProviderSection({
      'my-local': {
        baseUrl: 'http://192.168.10.10:18020/v1',
        models: {
          'qwen3.8-27b': {
            name: 'Qwen3.8 27B',
            capabilities: {
              limit: { context: 262144, output: 16384 },
              reasoning: true,
              toolCall: true,
              temperature: true,
              attachment: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              options: { reasoningEffort: 'high' },
            },
          },
        },
      },
    });
    expect(section).toEqual({
      'my-local': {
        npm: '@ai-sdk/openai-compatible',
        name: 'my-local',
        options: { baseURL: 'http://192.168.10.10:18020/v1' },
        models: {
          'qwen3.8-27b': {
            name: 'Qwen3.8 27B',
            limit: { context: 262144, output: 16384 },
            reasoning: true,
            temperature: true,
            attachment: true,
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            options: { reasoningEffort: 'high' },
          },
        },
      },
    });
  });

  it('C8：未提供的能力键一律不写（留给 opencode 默认值），值为 {} 与 C6 等价', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: { m1: {}, m2: { capabilities: {} } },
      },
    });
    expect((section.p as { models: Record<string, unknown> }).models).toEqual({
      m1: {},
      m2: {},
    });
  });

  it('C8：limit 残缺（只有 context 或只有 output）→ 整体丢弃（opencode 要求两者同时存在）', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: {
          onlyCtx: { capabilities: { limit: { context: 4096 } } },
          onlyOut: { capabilities: { limit: { output: 1024 } } },
          both: { capabilities: { limit: { context: 4096, output: 1024 } } },
        },
      },
    });
    const models = (section.p as { models: Record<string, Record<string, unknown>> })
      .models;
    expect(models.onlyCtx.limit).toBeUndefined();
    expect(models.onlyOut.limit).toBeUndefined();
    expect(models.both.limit).toEqual({ context: 4096, output: 1024 });
  });

  it('C8：limit 非法值（0/负数/非数）→ 不写（防脏值破坏 serve 配置解析）', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: {
          neg: { capabilities: { limit: { context: -1, output: 100 } } },
          zero: { capabilities: { limit: { context: 0, output: 0 } } },
          nan: { capabilities: { limit: { context: 100 as unknown as number } } },
        },
      },
    });
    const models = (section.p as { models: Record<string, Record<string, unknown>> })
      .models;
    expect(models.neg.limit).toBeUndefined();
    expect(models.zero.limit).toBeUndefined();
    expect(models.nan.limit).toBeUndefined();
  });

  it('C8：modalities 过滤非枚举值 + 去重；空数组视为未声明（不误关 text）', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: {
          dirty: {
            capabilities: {
              modalities: {
                input: ['text', 'image', 'image', 'bogus'],
                output: [] as string[],
              },
            },
          },
          allBad: { capabilities: { modalities: { input: ['nope'] } } },
        },
      },
    });
    const models = (section.p as { models: Record<string, Record<string, unknown>> })
      .models;
    expect(models.dirty.modalities).toEqual({ input: ['text', 'image'] });
    expect(models.allBad.modalities).toBeUndefined();
  });

  it('C8：options 为 {} → 不写（避免写空对象）', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: { m: { capabilities: { options: {} } } },
      },
    });
    expect(
      (section.p as { models: Record<string, unknown> }).models.m,
    ).toEqual({});
  });

  it('C8：旧 server 的 string[] models 仍兼容（向后兼容旧负载）', () => {
    const section = buildProviderSection({
      legacy: { baseUrl: 'http://h:1/v1', models: ['m1', ' m2 ', ''] },
    });
    expect((section.legacy as { models: unknown }).models).toEqual({
      m1: {},
      m2: {},
    });
  });


  it('无效条目跳过（空 providerID / 非 http(s) baseUrl / 无有效模型）', () => {
    const section = buildProviderSection({
      '  ': { baseUrl: 'http://x', models: ['m'] },
      bad: { baseUrl: 'ftp://nope', models: ['m'] },
      'no-models': { baseUrl: 'http://ok', models: ['  '] },
      'ok-1': { baseUrl: 'http://ok', models: ['m1', 'm2'] },
    });
    expect(Object.keys(section)).toEqual(['ok-1']);
  });

  it('undefined 入参 → 空段（不抛错）', () => {
    expect(buildProviderSection(undefined)).toEqual({});
  });
});

describe('mergeProviderSection（C6：只替换 provider 段，其余 key 保留）', () => {
  const section = buildProviderSection({
    'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
  });

  it('保留 mcp/agent/plugin 等既有 key，整体替换 provider 段', () => {
    const existing = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { vteam: { enabled: true } },
      plugin: ['./.opencode/plugin/vteam-role-guard.ts'],
      provider: { old: { npm: 'x' } },
    });
    const merged = mergeProviderSection(existing, section);
    expect(merged).not.toBeNull();
    const parsed = JSON.parse(merged as string) as Record<string, unknown>;
    expect(parsed.mcp).toEqual({ vteam: { enabled: true } });
    expect(parsed.plugin).toEqual(['./.opencode/plugin/vteam-role-guard.ts']);
    expect(Object.keys(parsed.provider as object)).toEqual(['my-local']);
  });

  it('section={} → 删除 provider key（清空）', () => {
    const existing = JSON.stringify({ mcp: {}, provider: { old: {} } });
    const merged = mergeProviderSection(existing, {});
    const parsed = JSON.parse(merged as string) as Record<string, unknown>;
    expect(parsed.mcp).toEqual({});
    expect(parsed.provider).toBeUndefined();
  });

  it('section=undefined → 原样返回（不触碰）', () => {
    const existing = JSON.stringify({ mcp: {} });
    expect(mergeProviderSection(existing, undefined)).toBe(existing);
    expect(mergeProviderSection(null, undefined)).toBeNull();
  });

  it('existingRaw=null 且 section 空 → 返回 null（不创建空文件）', () => {
    expect(mergeProviderSection(null, {})).toBeNull();
  });

  it('existingRaw 损坏 JSON → 重建（不抛错）', () => {
    const merged = mergeProviderSection('not-json{{{', section);
    const parsed = JSON.parse(merged as string) as Record<string, unknown>;
    expect(parsed.provider).toEqual(section);
  });

  it('幂等：同 section 二次 merge 输出字节一致（F3 对比基础）', () => {
    const first = mergeProviderSection(null, section);
    const second = mergeProviderSection(first, section);
    expect(second).toBe(first);
  });
});

describe('writeOpencodeConfig（C6：600 权限 + 幂等写盘）', () => {
  it('写入 $HOME/.config/opencode/opencode.json，权限 600，保留既有 key', () => {
    fs.mkdirSync(path.dirname(DEFAULT_OPENCODE_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      DEFAULT_OPENCODE_CONFIG_PATH,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: ['a@1'] }),
    );
    const section = buildProviderSection({
      'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
    });
    const result = writeOpencodeConfig(
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: ['a@1'] }),
      section,
    );
    expect(result.changed).toBe(true);
    const mode = fs.statSync(DEFAULT_OPENCODE_CONFIG_PATH).mode & 0o777;
    expect(mode).toBe(AUTH_FILE_MODE);
    const parsed = JSON.parse(
      fs.readFileSync(DEFAULT_OPENCODE_CONFIG_PATH, 'utf8'),
    ) as Record<string, unknown>;
    expect(parsed.plugin).toEqual(['a@1']);
    expect(parsed.provider).toEqual(section);
  });

  it('内容未变 → changed=false 且不写盘（mtime 不变）', () => {
    const section = buildProviderSection({
      'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
    });
    writeOpencodeConfig(null, section);
    const mtimeBefore = fs
      .statSync(DEFAULT_OPENCODE_CONFIG_PATH)
      .mtimeMs;
    const result = writeOpencodeConfig(
      fs.readFileSync(DEFAULT_OPENCODE_CONFIG_PATH, 'utf8'),
      section,
    );
    expect(result.changed).toBe(false);
    expect(
      fs.statSync(DEFAULT_OPENCODE_CONFIG_PATH).mtimeMs,
    ).toBe(mtimeBefore);
  });
});

/** 类型/工具存在性编译断言（防重构漏导出）。 */
export function _typeGuard(result: AuthJsonResult): void {
  void result.authJsonPath;
}
