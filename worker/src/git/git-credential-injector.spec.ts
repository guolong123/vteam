/**
 * git-credential-injector 单测（todo 3）：凭证文件格式（{version, updatedAt, credentials}）、
 * repoUrl 升序排序幂等、600 权限、write/read 往返、不存在/解析失败 → null、cleanup 幂等。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildGitCredsFile,
  cleanupGitCredsFile,
  GIT_CREDS_FILE,
  GIT_CREDS_FILE_MODE,
  GitCredentialEntry,
  GitCredsResult,
  isValidGitCredEntry,
  readGitCredsFile,
  writeGitCredsFile,
} from './git-credential-injector';

// os.homedir 在 Node 中是只读 getter，jest.spyOn 无法替换 → 模块级部分 mock
// （默认代理真实实现，beforeAll 再 mockReturnValue 指向临时 HOME）。
jest.mock('os', () => {
  const actual = jest.requireActual('os') as typeof os;
  return { ...actual, homedir: jest.fn(actual.homedir) };
});

/** 用临时目录 mock os.homedir()（测试不触碰真实 $HOME）。 */
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-git-creds-test-'));
const CREDS_PATH = path.join(TMP_HOME, '.keta-git-creds.json');
const FIXED_TS = '2026-08-12T08:30:00.000Z';

const SSH_ENTRY: GitCredentialEntry = {
  repoUrl: 'git@github.com:xishuhq/aiagents.git',
  authType: 'ssh_key',
  key: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc',
  fingerprint: 'sha256:abcd1234',
};

const HTTPS_ENTRY: GitCredentialEntry = {
  repoUrl: 'https://github.com/xishuhq/tools.git',
  authType: 'https_token',
  key: 'ghp_secret',
  fingerprint: 'ghp_s****ret',
};

beforeAll(() => {
  (os.homedir as jest.Mock).mockReturnValue(TMP_HOME);
});

afterEach(() => {
  cleanupGitCredsFile(CREDS_PATH);
});

afterAll(() => {
  (os.homedir as jest.Mock).mockRestore();
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('buildGitCredsFile（{version:1, updatedAt, credentials} 稳定输出）', () => {
  it('标准格式：version=1 + updatedAt + credentials 数组', () => {
    const parsed = JSON.parse(buildGitCredsFile([SSH_ENTRY], FIXED_TS)) as {
      version: number;
      updatedAt: string;
      credentials: GitCredentialEntry[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.updatedAt).toBe(FIXED_TS);
    expect(parsed.credentials).toEqual([SSH_ENTRY]);
  });

  it('乱序输入 → 按 repoUrl 升序排序输出（幂等对比稳定）', () => {
    const a = buildGitCredsFile([HTTPS_ENTRY, SSH_ENTRY], FIXED_TS);
    const b = buildGitCredsFile([SSH_ENTRY, HTTPS_ENTRY], FIXED_TS);
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as { credentials: GitCredentialEntry[] };
    expect(parsed.credentials.map((c) => c.repoUrl)).toEqual([
      'git@github.com:xishuhq/aiagents.git',
      'https://github.com/xishuhq/tools.git',
    ]);
  });

  it('空/非法条目静默跳过（空 repoUrl/key/authType 不产生非法 JSON）', () => {
    const json = buildGitCredsFile(
      [
        { repoUrl: '  ', authType: 'ssh_key', key: 'sk', fingerprint: '' },
        { repoUrl: 'https://github.com/x/bad.git', authType: 'https_token', key: '', fingerprint: '' },
        { repoUrl: 'https://github.com/x/noauth.git', key: 'sk', fingerprint: '' } as GitCredentialEntry,
        SSH_ENTRY,
      ],
      FIXED_TS,
    );
    const parsed = JSON.parse(json) as { credentials: GitCredentialEntry[] };
    expect(parsed.credentials).toEqual([SSH_ENTRY]);
  });

  it('空列表 → 空 credentials 数组（清下发语义）', () => {
    const parsed = JSON.parse(buildGitCredsFile([], FIXED_TS)) as {
      credentials: GitCredentialEntry[];
    };
    expect(parsed.credentials).toEqual([]);
  });

  it('isValidGitCredEntry：空/非法条目判 false，合法条目判 true', () => {
    expect(isValidGitCredEntry(SSH_ENTRY)).toBe(true);
    expect(isValidGitCredEntry({ ...SSH_ENTRY, repoUrl: '' })).toBe(false);
    expect(isValidGitCredEntry({ ...SSH_ENTRY, key: '' })).toBe(false);
    expect(isValidGitCredEntry(undefined)).toBe(false);
  });
});

describe('writeGitCredsFile（600 权限 + $HOME/.keta-git-creds.json 路径）', () => {
  it('写入 $HOME/.keta-git-creds.json，权限 600，内容正确', () => {
    const result = writeGitCredsFile([SSH_ENTRY, HTTPS_ENTRY]);
    expect(result.path).toBe(CREDS_PATH);
    expect(fs.existsSync(result.path)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf8')) as {
      credentials: GitCredentialEntry[];
    };
    expect(parsed.credentials.map((c) => c.repoUrl)).toEqual([
      'git@github.com:xishuhq/aiagents.git',
      'https://github.com/xishuhq/tools.git',
    ]);
  });

  it('文件权限 = 0o600（仅属主读写，明文 key 唯一防线）', () => {
    const result = writeGitCredsFile([SSH_ENTRY]);
    const mode = fs.statSync(result.path).mode & 0o777;
    expect(mode).toBe(GIT_CREDS_FILE_MODE);
  });

  it('写前防御性 mkdir -p homedir（目录缺失也能写）', () => {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
    const result = writeGitCredsFile([SSH_ENTRY]);
    expect(result.path).toBe(CREDS_PATH);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('write/read 往返：内容一致且结构完整', () => {
    writeGitCredsFile([SSH_ENTRY]);
    const file = readGitCredsFile(CREDS_PATH);
    expect(file).not.toBeNull();
    expect(file?.version).toBe(1);
    expect(file?.credentials).toEqual([SSH_ENTRY]);
    expect(typeof file?.updatedAt).toBe('string');
  });
});

describe('readGitCredsFile（不存在/解析失败 → null）', () => {
  it('文件不存在 → null', () => {
    expect(readGitCredsFile(path.join(TMP_HOME, 'no-such-file.json'))).toBeNull();
  });

  it('非法 JSON → null（解析失败不抛错）', () => {
    fs.writeFileSync(path.join(TMP_HOME, 'bad.json'), 'not-json{');
    expect(readGitCredsFile(path.join(TMP_HOME, 'bad.json'))).toBeNull();
  });

  it('缺省参数默认读 GIT_CREDS_FILE（模块级常量，非动态 homedir 路径）', () => {
    writeGitCredsFile([SSH_ENTRY]);
    // 写盘动态求值落在 mock 后的 homedir（TMP_HOME）→ 显式传参可读
    expect(readGitCredsFile(CREDS_PATH)).not.toBeNull();
    // 缺省参数与显式传 GIT_CREDS_FILE 读取结果一致，证明默认参数是该模块级常量
    // （ts-jest __importStar 使 spyOn 对内置 fs 无效，故用行为断言替代，与 git-tools.spec.ts 同策略）。
    expect(readGitCredsFile()).toEqual(readGitCredsFile(GIT_CREDS_FILE));
  });
});

describe('cleanupGitCredsFile（幂等删除）', () => {
  it('删除凭证文件（存在时）', () => {
    writeGitCredsFile([SSH_ENTRY]);
    expect(fs.existsSync(CREDS_PATH)).toBe(true);
    cleanupGitCredsFile(CREDS_PATH);
    expect(fs.existsSync(CREDS_PATH)).toBe(false);
  });

  it('文件不存在时静默忽略（幂等，不抛错）', () => {
    expect(() => cleanupGitCredsFile(CREDS_PATH)).not.toThrow();
  });

  it('空路径静默忽略', () => {
    expect(() => cleanupGitCredsFile('')).not.toThrow();
  });
});

/** 类型/工具存在性编译断言（防重构漏导出）。 */
export function _typeGuard(result: GitCredsResult): void {
  void result.path;
}
