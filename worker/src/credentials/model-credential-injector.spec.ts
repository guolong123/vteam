/**
 * model-credential-injector 单测（C5b）：auth.json 格式（{providerID:{type:'api',key}}）、
 * 600 权限、写入**隔离配置域**的 `<data>/opencode/auth.json`（T16b；v2.0.28 实测认
 * XDG_DATA_HOME，不认宿主 HOME）、cleanup 幂等且只删 auth.json 文件不删目录、不碰同目录的
 * opencode.db（D11 铁律）；C6/T7：opencode.json 的 `providers` 段组装/合并/写入（幂等）+
 * **v2 形态**断言 + 写后回读断言（缺 v2 必备键 → 抛配置错误）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveIsolationScope } from '../config';
import {
  AUTH_FILE_MODE,
  AuthJsonResult,
  assertProviderConfigValid,
  buildAuthJson,
  buildProviderSection,
  cleanupAuthJson,
  DEFAULT_OPENCODE_CONFIG_PATH,
  findProviderConfigIssues,
  mergeProviderSection,
  ModelCredentialEntry,
  ProviderConfigError,
  readAuthJsonKeys,
  writeAuthJson,
  writeOpencodeConfig,
} from './model-credential-injector';

// os.homedir 在 Node 中是只读 getter，jest.spyOn 无法替换 → 模块级部分 mock
// （默认代理真实实现，beforeAll 再 mockReturnValue 指向临时 HOME）。
// ⚠️ mock 工厂里直接算出假 HOME：模块级常量（DEFAULT_*_PATH）在 import 时就会求值，
// 必须那时就落到临时目录，绝不写真实 $HOME。
jest.mock('os', () => {
  const actual = jest.requireActual('os') as typeof os;
  const fakeHome = actual.tmpdir() + '/keta-injector-test-' + process.pid;
  return { ...actual, homedir: jest.fn(() => fakeHome) };
});

/** 用临时目录 mock os.homedir()（测试不触碰真实 $HOME）。 */
const TMP_HOME = path.join(os.tmpdir(), `keta-injector-test-${process.pid}`);
/**
 * T16b：隔离配置域（测试内显式指定 HOME → 落点全部在临时目录里，
 * **绝不写真实 $HOME**，也不写宿主的 `~/.config/opencode` / `~/.local/share/opencode`）。
 */
const SCOPE = resolveIsolationScope({ HOME: TMP_HOME });
const AUTH_JSON_PATH = SCOPE.authJsonFile;
const OPENCODE_DATA_DIR = path.dirname(AUTH_JSON_PATH);
const OPENCODE_CONFIG_PATH = SCOPE.configFile;

beforeAll(() => {
  (os.homedir as jest.Mock).mockReturnValue(TMP_HOME);
});

afterEach(() => {
  cleanupAuthJson(AUTH_JSON_PATH);
  fs.rmSync(OPENCODE_CONFIG_PATH, { force: true });
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

describe('writeAuthJson（600 权限 + 隔离配置域的 <data>/opencode/auth.json）', () => {
  it('写入隔离配置域的 <data>/opencode/auth.json，权限 600，内容正确', () => {
    const result = writeAuthJson([{ providerID: 'deepseek', key: 'sk-123' }], SCOPE);
    expect(result.authJsonPath).toBe(AUTH_JSON_PATH);
    expect(fs.existsSync(result.authJsonPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(result.authJsonPath, 'utf8'))).toEqual({
      deepseek: { type: 'api', key: 'sk-123' },
    });
  });

  it('T16b：落点在隔离配置域内（不写宿主 HOME 的 ~/.local/share/opencode/auth.json）', () => {
    const result = writeAuthJson([{ providerID: 'x', key: 'sk' }], SCOPE);
    expect(result.authJsonPath.startsWith(SCOPE.root + path.sep)).toBe(true);
    expect(result.authJsonPath).toBe(
      path.join(SCOPE.root, 'data', 'opencode', 'auth.json'),
    );
    // 宿主 HOME 侧的老路径（v1 落点）必须**没有**被写
    expect(
      fs.existsSync(path.join(TMP_HOME, '.local', 'share', 'opencode', 'auth.json')),
    ).toBe(false);
  });

  it('文件权限 = 0o600（仅属主读写，明文 key 唯一防线）', () => {
    const result = writeAuthJson([{ providerID: 'x', key: 'sk' }], SCOPE);
    const mode = fs.statSync(result.authJsonPath).mode & 0o777;
    expect(mode).toBe(AUTH_FILE_MODE);
  });

  it('写前自动 mkdir -p 隔离域的 data/opencode/（目录缺失也能写）', () => {
    fs.rmSync(SCOPE.dataHome, { recursive: true, force: true });
    const result = writeAuthJson([{ providerID: 'x', key: 'sk' }], SCOPE);
    expect(result.authJsonPath).toBe(AUTH_JSON_PATH);
    expect(fs.existsSync(result.authJsonPath)).toBe(true);
  });

  it('固定路径重复写覆盖旧内容（新凭据替换旧凭据）', () => {
    writeAuthJson([{ providerID: 'a', key: 'sk-old' }], SCOPE);
    const second = writeAuthJson([{ providerID: 'a', key: 'sk-new' }], SCOPE);
    expect(second.authJsonPath).toBe(AUTH_JSON_PATH);
    expect(JSON.parse(fs.readFileSync(second.authJsonPath, 'utf8'))).toEqual({
      a: { type: 'api', key: 'sk-new' },
    });
  });
});

describe('cleanupAuthJson（幂等删除，只删 auth.json 文件不删目录）', () => {
  it('删除 auth.json 文件但保留隔离域的 data/opencode 目录（含 opencode.db 会话库）', () => {
    const result = writeAuthJson([{ providerID: 'a', key: 'sk' }], SCOPE);
    expect(fs.existsSync(result.authJsonPath)).toBe(true);
    cleanupAuthJson(result.authJsonPath);
    expect(fs.existsSync(result.authJsonPath)).toBe(false);
    expect(fs.existsSync(OPENCODE_DATA_DIR)).toBe(true);
  });

  it('D11 铁律：同目录的 opencode.db（v2 的 SQLite 会话库）必须原样存在', () => {
    const result = writeAuthJson([{ providerID: 'a', key: 'sk' }], SCOPE);
    const dbPath = path.join(OPENCODE_DATA_DIR, 'opencode.db');
    fs.writeFileSync(dbPath, 'sqlite-placeholder');
    cleanupAuthJson(result.authJsonPath);
    expect(fs.existsSync(result.authJsonPath)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('sqlite-placeholder');
  });

  it('D11 铁律：传入 opencode.db 路径时拒绝删除（防误传路径丢会话历史）', () => {
    const dbPath = path.join(OPENCODE_DATA_DIR, 'opencode.db');
    fs.writeFileSync(dbPath, 'sqlite-placeholder');
    cleanupAuthJson(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('D11 铁律：隔离域里的 opencode.db 路径（scope.dbFile）同样拒绝删除', () => {
    const dbPath = SCOPE.dbFile;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'sqlite-placeholder');
    cleanupAuthJson(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    fs.rmSync(dbPath, { force: true });
  });

  it('文件不存在时静默忽略（幂等，不抛错）', () => {
    expect(() =>
      cleanupAuthJson(path.join(TMP_HOME, 'no-such-auth.json')),
    ).not.toThrow();
  });

  it('auth.json 路径上的文件不存在（ENOENT）→ 静默忽略', () => {
    expect(() =>
      cleanupAuthJson(path.join(TMP_HOME, 'missing-dir', 'auth.json')),
    ).not.toThrow();
  });

  it('空路径静默忽略', () => {
    expect(() => cleanupAuthJson('')).not.toThrow();
  });
});

/** 递归收集对象里出现过的所有键名（用于断言"v1 键一个都不许出现"）。 */
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, acc);
    }
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.add(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

describe('buildProviderSection（T7：opencode v2 形态的 providers 段组装）', () => {
  it('有效条目 → v2 段名 providers + package + settings.baseURL + models map', () => {
    const section = buildProviderSection({
      'my-local': { baseUrl: 'http://192.168.10.10:18020/v1', models: ['qwen3.8-27b'] },
    });
    expect(section).toEqual({
      'my-local': {
        name: 'my-local',
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'http://192.168.10.10:18020/v1' },
        models: {
          'qwen3.8-27b': {
            modelID: 'qwen3.8-27b',
            capabilities: { tools: true, input: ['text'], output: ['text'] },
          },
        },
      },
    });
  });

  it('T7：v1 键一个都不许出现（npm/options/reasoning/tool_call/attachment/modalities 全被 v2 丢弃）', () => {
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
    const provider = (section['my-local'] as { models: Record<string, unknown> })
      .models['qwen3.8-27b'];
    expect(provider).toEqual({
      modelID: 'qwen3.8-27b',
      name: 'Qwen3.8 27B',
      limit: { context: 262144, output: 16384 },
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      settings: { reasoningEffort: 'high' },
    });
    const keys = collectKeys(section);
    for (const legacyKey of [
      'npm',
      'options',
      'reasoning',
      'tool_call',
      'attachment',
      'modalities',
    ]) {
      expect(keys.has(legacyKey)).toBe(false);
    }
  });

  it('T7：v1 能力键 → v2 capabilities 的映射（toolCall→tools、modalities→input/output、options→settings）', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: {
          m: {
            capabilities: {
              toolCall: false,
              modalities: { input: ['image', 'text'], output: ['text'] },
            },
          },
        },
      },
    });
    const model = (section.p as { models: Record<string, Record<string, unknown>> })
      .models.m;
    expect(model.capabilities).toEqual({
      tools: false,
      input: ['image', 'text'],
      output: ['text'],
    });
    expect(model.settings).toBeUndefined();
  });

  it('T7：attachment=true → capabilities.input 并入 image（v2 无附件布尔键）', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: { m: { capabilities: { attachment: true } } },
      },
    });
    const model = (section.p as { models: Record<string, Record<string, unknown>> })
      .models.m;
    expect(model.capabilities).toEqual({
      tools: true,
      input: ['text', 'image'],
      output: ['text'],
    });
  });

  it('C8：未提供的能力键 → capabilities 用保守默认（tools=true / 仅 text），不臆造视觉能力', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: { m1: {}, m2: { capabilities: {} } },
      },
    });
    const models = (section.p as { models: Record<string, unknown> }).models;
    expect(models.m1).toEqual({
      modelID: 'm1',
      capabilities: { tools: true, input: ['text'], output: ['text'] },
    });
    expect(models.m2).toEqual({
      modelID: 'm2',
      capabilities: { tools: true, input: ['text'], output: ['text'] },
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
    expect(models.dirty.capabilities).toEqual({
      tools: true,
      input: ['text', 'image'],
      output: ['text'],
    });
    expect(models.allBad.capabilities).toEqual({
      tools: true,
      input: ['text'],
      output: ['text'],
    });
  });

  it('C8：options 为 {} → 不写 settings（避免写空对象）', () => {
    const section = buildProviderSection({
      p: {
        baseUrl: 'http://h:1/v1',
        models: { m: { capabilities: { options: {} } } },
      },
    });
    const model = (section.p as { models: Record<string, unknown> }).models.m;
    expect((model as { settings?: unknown }).settings).toBeUndefined();
  });

  it('C8：旧 server 的 string[] models 仍兼容（向后兼容旧负载）', () => {
    const section = buildProviderSection({
      legacy: { baseUrl: 'http://h:1/v1', models: ['m1', ' m2 ', ''] },
    });
    expect((section.legacy as { models: unknown }).models).toEqual({
      m1: {
        modelID: 'm1',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
      },
      m2: {
        modelID: 'm2',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
      },
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

describe('mergeProviderSection（C6/T7：只替换 providers 段，其余 key 保留）', () => {
  const section = buildProviderSection({
    'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
  });

  it('保留 mcp/agent/plugin 等既有 key，整体替换 providers 段', () => {
    const existing = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { vteam: { enabled: true } },
      plugin: ['oh-my-openagent@latest'],
      providers: { old: { package: 'x' } },
    });
    const merged = mergeProviderSection(existing, section);
    expect(merged).not.toBeNull();
    const parsed = JSON.parse(merged as string) as Record<string, unknown>;
    expect(parsed.mcp).toEqual({ vteam: { enabled: true } });
    expect(parsed.plugin).toEqual(['oh-my-openagent@latest']);
    expect(Object.keys(parsed.providers as object)).toEqual(['my-local']);
  });

  it('T7：v1 段名 `provider` 被清掉（两段并存 = 留一份注定被 v2 静默丢弃的配置）', () => {
    const existing = JSON.stringify({
      provider: {
        'old-local': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://x' },
          models: { m: { reasoning: true } },
        },
      },
    });
    const merged = mergeProviderSection(existing, section);
    const parsed = JSON.parse(merged as string) as Record<string, unknown>;
    expect(parsed.provider).toBeUndefined();
    expect(Object.keys(parsed.providers as object)).toEqual(['my-local']);
  });

  it('section={} → 删除 providers 段（清空）', () => {
    const existing = JSON.stringify({ mcp: {}, providers: { old: {} } });
    const merged = mergeProviderSection(existing, {});
    const parsed = JSON.parse(merged as string) as Record<string, unknown>;
    expect(parsed.mcp).toEqual({});
    expect(parsed.providers).toBeUndefined();
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
    expect(parsed.providers).toEqual(section);
  });

  it('幂等：同 section 二次 merge 输出字节一致（F3 对比基础）', () => {
    const first = mergeProviderSection(null, section);
    const second = mergeProviderSection(first, section);
    expect(second).toBe(first);
  });
});

describe('writeOpencodeConfig（C6/T7：600 权限 + 幂等写盘 + v2 形态写后断言）', () => {
  it('写入隔离配置域的 <config>/opencode/opencode.json，权限 600，保留既有 key', () => {
    fs.mkdirSync(path.dirname(OPENCODE_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      OPENCODE_CONFIG_PATH,
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: ['a@1'] }),
    );
    const section = buildProviderSection({
      'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
    });
    const result = writeOpencodeConfig(
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: ['a@1'] }),
      section,
      SCOPE,
    );
    expect(result.changed).toBe(true);
    const mode = fs.statSync(OPENCODE_CONFIG_PATH).mode & 0o777;
    expect(mode).toBe(AUTH_FILE_MODE);
    const parsed = JSON.parse(
      fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf8'),
    ) as Record<string, unknown>;
    expect(parsed.plugin).toEqual(['a@1']);
    expect(parsed.providers).toEqual(section);
  });

  it('T16b：落点在隔离配置域内（不写宿主 HOME 的 ~/.config/opencode/opencode.json）', () => {
    writeOpencodeConfig(
      null,
      buildProviderSection({
        'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
      }),
      SCOPE,
    );
    expect(OPENCODE_CONFIG_PATH).toBe(
      path.join(SCOPE.root, 'config', 'opencode', 'opencode.json'),
    );
    expect(
      fs.existsSync(path.join(TMP_HOME, '.config', 'opencode', 'opencode.json')),
    ).toBe(false);
  });

  it('内容未变 → changed=false 且不写盘（mtime 不变）', () => {
    const section = buildProviderSection({
      'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
    });
    writeOpencodeConfig(null, section, SCOPE);
    const mtimeBefore = fs
      .statSync(OPENCODE_CONFIG_PATH)
      .mtimeMs;
    const result = writeOpencodeConfig(
      fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf8'),
      section,
      SCOPE,
    );
    expect(result.changed).toBe(false);
    expect(
      fs.statSync(OPENCODE_CONFIG_PATH).mtimeMs,
    ).toBe(mtimeBefore);
  });

  it('T7：写盘后的文件是 v2 形态（package/settings.baseURL/capabilities 在，v1 键全不在）', () => {
    const section = buildProviderSection({
      'my-local': {
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: {
          'qwen:latest': {
            name: 'Qwen Latest',
            capabilities: {
              limit: { context: 32768, output: 4096 },
              reasoning: true,
              toolCall: true,
              attachment: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              options: { reasoningEffort: 'high' },
            },
          },
        },
      },
    });
    writeOpencodeConfig(null, section, SCOPE);
    const raw = fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = (parsed.providers as Record<string, Record<string, unknown>>)[
      'my-local'
    ];
    expect(provider.package).toBe('aisdk:@ai-sdk/openai-compatible');
    expect(provider.settings).toEqual({ baseURL: 'http://127.0.0.1:11434/v1' });
    const model = (provider.models as Record<string, Record<string, unknown>>)[
      'qwen:latest'
    ];
    expect(model.capabilities).toEqual({
      tools: true,
      input: ['text', 'image'],
      output: ['text'],
    });
    expect(model.limit).toEqual({ context: 32768, output: 4096 });
    const keys = collectKeys(JSON.parse(raw));
    for (const legacyKey of [
      'npm',
      'options',
      'reasoning',
      'tool_call',
      'attachment',
      'modalities',
    ]) {
      expect(keys.has(legacyKey)).toBe(false);
    }
  });

  it('T7：写后回读断言——注入的段不是 v2 形态 → 抛配置错误（不静默放行）', () => {
    const legacySection = {
      'my-local': {
        npm: '@ai-sdk/openai-compatible',
        name: 'my-local',
        options: { baseURL: 'http://127.0.0.1:11434/v1' },
        models: { 'qwen:latest': { reasoning: true } },
      },
    };
    expect(() => writeOpencodeConfig(null, legacySection, SCOPE)).toThrow(
      ProviderConfigError,
    );
  });
});

describe('T16b：凭据载体（v2.0.28 实测——auth.json 不被采用，settings.apiKey 才生效）', () => {
  it('传入 providerKeys → provider 段的 settings 带 apiKey（v2 真正会读的那一处）', () => {
    const section = buildProviderSection(
      { 'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] } },
      [{ providerID: 'my-local', key: 'sk-secret' }],
    );
    const provider = section['my-local'] as { settings: Record<string, unknown> };
    expect(provider.settings).toEqual({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'sk-secret',
    });
  });

  it('不传 providerKeys → settings 只有 baseURL（不写空 apiKey）', () => {
    const section = buildProviderSection({
      'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
    });
    const provider = section['my-local'] as { settings: Record<string, unknown> };
    expect(provider.settings).toEqual({ baseURL: 'http://127.0.0.1:11434/v1' });
  });

  it('providerID 不匹配的凭据不落进任何 provider 段', () => {
    const section = buildProviderSection(
      { 'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] } },
      [{ providerID: 'other', key: 'sk-secret' }],
    );
    const provider = section['my-local'] as { settings: Record<string, unknown> };
    expect(provider.settings.apiKey).toBeUndefined();
  });

  it('写后回读断言：settings.apiKey 存在但不是非空字符串 → 报错点名键路径', () => {
    const raw = JSON.stringify({
      providers: {
        p: {
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: { baseURL: 'http://x', apiKey: '  ' },
          models: {
            m: { capabilities: { tools: true, input: ['text'], output: ['text'] } },
          },
        },
      },
    });
    expect(findProviderConfigIssues(raw).map((issue) => issue.path)).toEqual([
      '$.providers.p.settings.apiKey',
    ]);
    expect(() => assertProviderConfigValid(raw)).toThrow(ProviderConfigError);
  });

  it('写后回读断言：settings.apiKey 是非空字符串 → 不报 issue', () => {
    const raw = JSON.stringify({
      providers: {
        p: {
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: { baseURL: 'http://x', apiKey: 'sk-1' },
          models: {
            m: { capabilities: { tools: true, input: ['text'], output: ['text'] } },
          },
        },
      },
    });
    expect(findProviderConfigIssues(raw)).toEqual([]);
  });
});

describe('T16b：auth.json 是 key 的真值来源（配置段缺 key 时回填）', () => {
  const section = buildProviderSection({
    'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
  });

  it('auth.json 有该 provider 的 key → 写配置时回填进 settings.apiKey', () => {
    writeAuthJson([{ providerID: 'my-local', key: 'sk-from-auth' }], SCOPE);
    writeOpencodeConfig(null, section, SCOPE);
    const parsed = JSON.parse(
      fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf8'),
    ) as Record<string, unknown>;
    const provider = (parsed.providers as Record<string, Record<string, unknown>>)[
      'my-local'
    ];
    expect((provider.settings as Record<string, unknown>).apiKey).toBe('sk-from-auth');
  });

  it('段里已带 key → 不被 auth.json 覆盖（调用方给的值优先）', () => {
    writeAuthJson([{ providerID: 'my-local', key: 'sk-from-auth' }], SCOPE);
    const withKey = buildProviderSection(
      { 'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] } },
      [{ providerID: 'my-local', key: 'sk-from-caller' }],
    );
    writeOpencodeConfig(null, withKey, SCOPE);
    const parsed = JSON.parse(
      fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf8'),
    ) as Record<string, unknown>;
    const provider = (parsed.providers as Record<string, Record<string, unknown>>)[
      'my-local'
    ];
    expect((provider.settings as Record<string, unknown>).apiKey).toBe('sk-from-caller');
  });

  it('auth.json 没有该 provider 的 key → 不写空 apiKey', () => {
    writeAuthJson([{ providerID: 'other', key: 'sk-x' }], SCOPE);
    writeOpencodeConfig(null, section, SCOPE);
    const parsed = JSON.parse(
      fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf8'),
    ) as Record<string, unknown>;
    const provider = (parsed.providers as Record<string, Record<string, unknown>>)[
      'my-local'
    ];
    expect((provider.settings as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('auth.json 损坏 → 当作没有凭据（不抛错，配置照写）', () => {
    fs.mkdirSync(path.dirname(AUTH_JSON_PATH), { recursive: true });
    fs.writeFileSync(AUTH_JSON_PATH, 'not-json{{{');
    expect(() => writeOpencodeConfig(null, section, SCOPE)).not.toThrow();
    const parsed = JSON.parse(
      fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf8'),
    ) as Record<string, unknown>;
    const provider = (parsed.providers as Record<string, Record<string, unknown>>)[
      'my-local'
    ];
    expect((provider.settings as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('readAuthJsonKeys：读出 provider → key 映射', () => {
    writeAuthJson(
      [
        { providerID: 'a', key: 'sk-a' },
        { providerID: 'b', key: 'sk-b' },
      ],
      SCOPE,
    );
    const keys = readAuthJsonKeys(SCOPE);
    expect(keys.get('a')).toBe('sk-a');
    expect(keys.get('b')).toBe('sk-b');
  });
});

describe('T7 写后回读断言（provider 段 v2 形态校验）', () => {
  it('形态正确 → 不抛错', () => {
    const section = buildProviderSection({
      'my-local': { baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen:latest'] },
    });
    const raw = JSON.stringify({ providers: section }, null, 2);
    expect(() => assertProviderConfigValid(raw)).not.toThrow();
    expect(findProviderConfigIssues(raw)).toEqual([]);
  });

  it('缺 package → 报错并点名键路径', () => {
    const raw = JSON.stringify({
      providers: {
        p: {
          name: 'p',
          settings: { baseURL: 'http://x' },
          models: {
            m: { capabilities: { tools: true, input: ['text'], output: ['text'] } },
          },
        },
      },
    });
    const issues = findProviderConfigIssues(raw);
    expect(issues.map((issue) => issue.path)).toEqual([
      '$.providers.p.package',
    ]);
    expect(() => assertProviderConfigValid(raw)).toThrow(ProviderConfigError);
  });

  it('缺 settings.baseURL → 报错并点名键路径', () => {
    const raw = JSON.stringify({
      providers: {
        p: {
          package: 'aisdk:@ai-sdk/openai-compatible',
          models: {
            m: { capabilities: { tools: true, input: ['text'], output: ['text'] } },
          },
        },
      },
    });
    expect(findProviderConfigIssues(raw).map((issue) => issue.path)).toEqual([
      '$.providers.p.settings.baseURL',
    ]);
  });

  it('缺 capabilities → 报错并点名键路径（v1 的 reasoning/tool_call 等键不算数）', () => {
    const raw = JSON.stringify({
      providers: {
        p: {
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: { baseURL: 'http://x' },
          models: { m: { limit: { context: 100, output: 100 } } },
        },
      },
    });
    expect(findProviderConfigIssues(raw).map((issue) => issue.path)).toEqual([
      '$.providers.p.models.m.capabilities',
    ]);
  });

  it('limit 半截（缺 output）→ 报错（v2 要求 context+output 同时存在）', () => {
    const raw = JSON.stringify({
      providers: {
        p: {
          package: 'aisdk:@ai-sdk/openai-compatible',
          settings: { baseURL: 'http://x' },
          models: {
            m: {
              capabilities: { tools: true, input: ['text'], output: ['text'] },
              limit: { context: 100 },
            },
          },
        },
      },
    });
    expect(findProviderConfigIssues(raw).map((issue) => issue.path)).toEqual([
      '$.providers.p.models.m.limit.output',
    ]);
    expect(() => assertProviderConfigValid(raw)).toThrow(/limit\.output/);
  });

  it('残留 v1 段名 provider → 报错（两段并存 = 留一份注定被丢的配置）', () => {
    const raw = JSON.stringify({
      provider: { old: { npm: '@ai-sdk/openai-compatible' } },
    });
    expect(findProviderConfigIssues(raw).map((issue) => issue.path)).toEqual([
      '$.provider',
      '$.providers',
    ]);
  });
});

/** 类型/工具存在性编译断言（防重构漏导出）。 */
export function _typeGuard(result: AuthJsonResult): void {
  void result.authJsonPath;
}

describe('T16b：默认落点常量指向隔离配置域（不再是宿主 HOME）', () => {
  it('DEFAULT_OPENCODE_CONFIG_PATH = <root>/config/opencode/opencode.json', () => {
    expect(DEFAULT_OPENCODE_CONFIG_PATH).toBe(OPENCODE_CONFIG_PATH);
    expect(DEFAULT_OPENCODE_CONFIG_PATH).toBe(
      path.join(SCOPE.root, 'config', 'opencode', 'opencode.json'),
    );
  });

  it('默认常量不再是宿主 HOME 的 ~/.config/opencode/opencode.json（隔离生效）', () => {
    expect(DEFAULT_OPENCODE_CONFIG_PATH).not.toContain(
      path.join('.config', 'opencode', 'opencode.json'),
    );
  });
});
