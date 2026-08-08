/**
 * model-credential-injector 单测（C5）：auth.json 格式（C5a 实测 {providerID:{type:'api',key}}）、
 * 600 权限、路径随机化、cleanup 幂等。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AUTH_FILE_MODE,
  AUTH_DIR_PREFIX,
  AuthJsonResult,
  buildAuthJson,
  cleanupAuthJson,
  ModelCredentialEntry,
  writeAuthJson,
} from './model-credential-injector';

/** 用临时目录隔离真实 os.tmpdir（测试不触碰真实 tmp 残留）。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-injector-test-'));

afterAll(() => {
  cleanupAuthJson(TMP);
});

describe('buildAuthJson（C5a 实测格式 {providerID:{type:"api",key}}）', () => {
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

describe('writeAuthJson（600 权限 + 随机路径 + 目录结构）', () => {
  it('写入 <dir>/opencode/auth.json，权限 600，内容正确', () => {
    const result = writeAuthJson(
      [{ providerID: 'deepseek', key: 'sk-123' }],
      { dir: TMP },
    );
    expect(path.basename(result.authJsonPath)).toBe('auth.json');
    expect(path.basename(path.dirname(result.authJsonPath))).toBe('opencode');
    expect(result.dataDir).toBe(TMP);
    expect(fs.existsSync(result.authJsonPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(result.authJsonPath, 'utf8'))).toEqual({
      deepseek: { type: 'api', key: 'sk-123' },
    });
  });

  it('文件权限 = 0o600（仅属主读写，明文 key 唯一防线）', () => {
    const result = writeAuthJson([{ providerID: 'x', key: 'sk' }], { dir: TMP });
    const mode = fs.statSync(result.authJsonPath).mode & 0o777;
    expect(mode).toBe(AUTH_FILE_MODE);
  });

  it('dir 缺省时路径随机化（每次调用独立目录 + keta-auth- 前缀）', () => {
    const a = writeAuthJson([{ providerID: 'x', key: 'sk' }]);
    const b = writeAuthJson([{ providerID: 'x', key: 'sk' }]);
    try {
      expect(a.dataDir).not.toBe(b.dataDir);
      expect(path.basename(a.dataDir)).toMatch(new RegExp(`^${AUTH_DIR_PREFIX}`));
      expect(path.basename(b.dataDir)).toMatch(new RegExp(`^${AUTH_DIR_PREFIX}`));
      expect(fs.existsSync(a.authJsonPath)).toBe(true);
    } finally {
      cleanupAuthJson(a.dataDir);
      cleanupAuthJson(b.dataDir);
    }
  });

  it('同目录重复写覆盖旧内容（新凭据替换旧凭据）', () => {
    const first = writeAuthJson([{ providerID: 'a', key: 'sk-old' }], { dir: TMP });
    const second = writeAuthJson([{ providerID: 'a', key: 'sk-new' }], { dir: TMP });
    expect(first.authJsonPath).toBe(second.authJsonPath);
    expect(JSON.parse(fs.readFileSync(second.authJsonPath, 'utf8'))).toEqual({
      a: { type: 'api', key: 'sk-new' },
    });
  });
});

describe('cleanupAuthJson（幂等删除）', () => {
  it('删除整个凭据数据目录（opencode/auth.json 一并清理）', () => {
    const result = writeAuthJson([{ providerID: 'a', key: 'sk' }], { dir: TMP });
    cleanupAuthJson(result.dataDir);
    expect(fs.existsSync(result.authJsonPath)).toBe(false);
    expect(fs.existsSync(result.dataDir)).toBe(false);
  });

  it('目录不存在时静默忽略（幂等，不抛错）', () => {
    expect(() =>
      cleanupAuthJson(path.join(TMP, 'does-not-exist')),
    ).not.toThrow();
  });

  it('空 dataDir 静默忽略', () => {
    expect(() => cleanupAuthJson('')).not.toThrow();
  });
});

/** 类型/工具存在性编译断言（防重构漏导出）。 */
export function _typeGuard(result: AuthJsonResult): void {
  void result.dataDir;
  void result.authJsonPath;
}
