/**
 * model-credential-injector 单测（C5b）：auth.json 格式（{providerID:{type:'api',key}}）、
 * 600 权限、固定写入 $HOME/.local/share/opencode/auth.json（opencode 1.18.16 实测路径）、
 * cleanup 幂等且只删 auth.json 文件不删目录。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AUTH_FILE_MODE,
  AuthJsonResult,
  buildAuthJson,
  cleanupAuthJson,
  ModelCredentialEntry,
  writeAuthJson,
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

/** 类型/工具存在性编译断言（防重构漏导出）。 */
export function _typeGuard(result: AuthJsonResult): void {
  void result.authJsonPath;
}
