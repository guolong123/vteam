import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GIT_TOOLS,
  GIT_TOOL_FILE,
  GIT_TOOLS_REL_DIR,
  installGitTools,
  renderGitToolsFile,
  GitToolDef,
  defaultRepoName,
  resolveCloneTarget,
  isSameRepoCheckout,
  prepareCloneTarget,
  normalizeRepoUrl,
  normalizeSshKey,
  cwdOrigin,
  loadCredential,
  tryLoadCredential,
  writeTempKey,
  writeAskpass,
  buildGitEnv,
  cleanupTemp,
  runGit,
} from './git-tools';

// loadCredential 单测需拦截 fs.readFileSync；jest.spyOn 在本环境对 Node 内置 fs 无效
// （__importStar 生成模块副本），故模块级部分 mock：仅 readFileSync 为 jest.fn，其余真实。
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, readFileSync: jest.fn() };
});

// child_process 默认透传真实实现（normalizeSshKey 的 ssh-keygen 交叉验证依赖真实 spawnSync），
// workdir 用例内按需 mockReturnValue 断言 cwd 透传。
jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, spawnSync: jest.fn((...args: unknown[]) => (actual.spawnSync as (...a: never[]) => unknown)(...(args as never[]))) };
});

const EXPECTED_TOOL_NAMES = [
  'git_clone',
  'git_pull',
  'git_fetch',
  'git_status',
  'git_diff',
  'git_log',
  'git_push',
] as const;

describe('cwdOrigin（pull/fetch/push 缺省 repo_url 的 origin 解析）', () => {
  const spawnSyncMock = child_process.spawnSync as unknown as jest.Mock;

  afterEach(() => {
    spawnSyncMock.mockClear();
  });

  it('传 dir → spawnSync 带 cwd（回归：修复前不传 cwd 恒 null → 误报未授权）', () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: 'git@gitee.com:xishuhq/custom-apps.git\n',
    });

    const url = cwdOrigin('/data/vteam-worker/tasks/t_1/custom-apps');

    expect(url).toBe('git@gitee.com:xishuhq/custom-apps.git');
    const opts = spawnSyncMock.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBe('/data/vteam-worker/tasks/t_1/custom-apps');
  });

  it('不传 dir → 不注入 cwd（保持旧行为，非 git 仓库时 null）', () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '' });

    expect(cwdOrigin()).toBeNull();
    const opts = spawnSyncMock.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBeUndefined();
  });

  it('git 失败（非仓库）→ null；空 stdout → null', () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '' });
    expect(cwdOrigin('/not/a/repo')).toBeNull();

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: '   \n' });
    expect(cwdOrigin('/some/dir')).toBeNull();
  });
});

describe('GIT_TOOLS 工具清单（17 篇 §4.1 七工具）', () => {
  it('含 7 个工具，名称对齐 §4.1', () => {
    expect(GIT_TOOLS).toHaveLength(7);
    expect(GIT_TOOLS.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('命名规则：name = <文件名>_<导出名>（git_<exportName>，文件名为 git）', () => {
    for (const tool of GIT_TOOLS) {
      expect(tool.name).toBe(`git_${tool.exportName}`);
      expect(tool.name.startsWith('git_')).toBe(true);
      expect(tool.exportName).not.toContain('_');
    }
  });

  it('默认 effect：push=ask（写远端），其余 allow', () => {
    const effects = Object.fromEntries(GIT_TOOLS.map((t) => [t.name, t.defaultEffect]));
    expect(effects.git_push).toBe('ask');
    for (const name of ['git_clone', 'git_pull', 'git_fetch', 'git_status', 'git_diff', 'git_log']) {
      expect(effects[name]).toBe('allow');
    }
  });

  it('关键参数对齐 §4.1：clone 必填 repo_url，push 必填 refspec', () => {
    const byName = (n: string): GitToolDef => GIT_TOOLS.find((t) => t.name === n)!;
    const clone = byName('git_clone');
    expect(clone.args.find((a) => a.name === 'repo_url')?.required).toBe(true);
    expect(clone.args.some((a) => a.name === 'ref')).toBe(true);
    expect(clone.args.some((a) => a.name === 'target')).toBe(true);

    const push = byName('git_push');
    expect(push.args.find((a) => a.name === 'refspec')?.required).toBe(true);
    expect(push.args.some((a) => a.name === 'repo_url')).toBe(true);
  });

  it('远端工具描述标注需平台仓库授权，push 标注需 write 授权', () => {
    const byName = (n: string): GitToolDef => GIT_TOOLS.find((t) => t.name === n)!;
    for (const name of ['git_clone', 'git_pull', 'git_fetch']) {
      expect(byName(name).description).toContain('需平台仓库授权');
    }
    expect(byName('git_push').description).toContain('需平台 write 授权');
  });
});

describe('installGitTools / renderGitToolsFile（注入机制，17 篇 §4.2）', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-git-tools-spec-'));

  it('写入 <workDir>/.opencode/tools/git.ts 并返回完整路径', () => {
    const filePath = installGitTools(workDir);
    expect(filePath).toBe(path.join(workDir, GIT_TOOLS_REL_DIR, GIT_TOOL_FILE));
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('生成内容为 opencode 自定义工具具名导出格式', () => {
    const content = renderGitToolsFile();
    expect(content).toContain('import { tool } from "@opencode-ai/plugin";');
    expect(content).toContain('import * as child_process from "node:child_process";');
    for (const tool of GIT_TOOLS) {
      expect(content).toContain(`export const ${tool.exportName} = tool({`);
      expect(content).toContain(`description: ${JSON.stringify(tool.description)},`);
    }
    expect(content).toContain('function runGit(');
    // 回归：remote 工具的 origin 解析必须带 workdir（否则 worker cwd 非仓库 → null → 误报未授权）
    expect(content).toContain('cwdOrigin(workdir)');
    expect(content).not.toContain('cwdOrigin();');
    // workdir 必须先于 repoUrl 绑定（cwdOrigin(workdir) 依赖它）
    for (const name of ['export const push = tool({', 'export const pull = tool({', 'export const fetch = tool({']) {
      const at = content.indexOf(name);
      expect(at).toBeGreaterThan(-1);
      const body = content.slice(at, content.indexOf('});', at));
      expect(body.indexOf('const workdir =')).toBeLessThan(
        body.indexOf('cwdOrigin(workdir)'),
      );
    }
  });

  it('生成内容含全部参数 schema（inputSchema）', () => {
    const content = renderGitToolsFile();
    for (const tool of GIT_TOOLS) {
      for (const arg of tool.args) {
        expect(content).toContain(`${arg.name}: tool.schema.`);
      }
    }
  });

  it('注入到嵌套目录（mkdir recursive），文件内容可再生成（幂等覆盖）', () => {
    installGitTools(workDir);
    const first = fs.readFileSync(path.join(workDir, GIT_TOOLS_REL_DIR, GIT_TOOL_FILE), 'utf8');
    const again = installGitTools(workDir);
    expect(again).toBe(path.join(workDir, GIT_TOOLS_REL_DIR, GIT_TOOL_FILE));
    expect(fs.readFileSync(again, 'utf8')).toBe(first);
  });
});

describe('渲染产物凭证注入升级（todo 4，自包含 git.ts）', () => {
  it('渲染内容含凭证读取/注入/清理逻辑', () => {
    const content = renderGitToolsFile();
    expect(content).toContain('keta-git-creds.json');
    expect(content).toContain('GIT_SSH_COMMAND');
    expect(content).toContain('GIT_ASKPASS');
    expect(content).toContain('permission !== "write"');
    expect(content).toContain('cleanupTemp');
  });

  it('渲染产物内联辅助函数与模块实现同源（toString 注入）', () => {
    const content = renderGitToolsFile();
    expect(content).toContain(normalizeRepoUrl.toString());
    expect(content).toContain(loadCredential.toString());
    expect(content).toContain(tryLoadCredential.toString());
    expect(content).toContain(writeTempKey.toString());
    expect(content).toContain(writeAskpass.toString());
    expect(content).toContain(buildGitEnv.toString());
    expect(content).toContain(cleanupTemp.toString());
  });

  it('渲染产物不引用 CommonJS 编译产物命名（ES module 自包含，防 toString 注入回归）', () => {
    const content = renderGitToolsFile();
    expect(content).not.toMatch(/exports\./);
    expect(content).not.toMatch(/child_process_\d+/);
    expect(content).toContain(`const credsFile = path.join(os.homedir(), '.keta-git-creds.json');`);
    expect(content).toContain('import * as child_process from "node:child_process";');
    expect(content).toContain('child_process.spawnSync');
  });

  it('status/diff/log 本地只读工具 execute 不加载凭证', () => {
    const content = renderGitToolsFile();
    for (const tool of ['status', 'diff', 'log']) {
      const start = content.indexOf(`export const ${tool} = tool({`);
      const end = content.indexOf('});', start);
      const toolBody = content.slice(start, end);
      expect(toolBody).not.toContain('loadCredential');
      expect(toolBody).toContain('return runGit(gitArgs, {}, workdir);');
    }
  });

  it('clone/pull/fetch execute 用 tryLoadCredential + 无凭证直接直连分支；push 仍走 loadCredential', () => {
    const content = renderGitToolsFile();
    for (const tool of ['pull', 'fetch']) {
      const start = content.indexOf(`export const ${tool} = tool({`);
      const end = content.indexOf('\n});', start);
      const toolBody = content.slice(start, end);
      expect(toolBody).toContain('tryLoadCredential');
      expect(toolBody).not.toContain('loadCredential(repoUrl)');
      expect(toolBody).toContain('if (!entry)');
      expect(toolBody).toContain('return runGit(_buildGitArgs(');
      expect(toolBody).toContain('buildGitEnv(entry)');
      expect(toolBody).toContain('cleanupTemp(p)');
    }
    {
      // clone 独立分支：中央库复用 + 绝对路径回吐，双凭证路径均经 cloneArgs（含解析后 target）
      const start = content.indexOf('export const clone = tool({');
      const end = content.indexOf('\n});', start);
      const toolBody = content.slice(start, end);
      expect(toolBody).toContain('tryLoadCredential(repoUrl)');
      expect(toolBody).not.toContain('loadCredential(repoUrl)');
      expect(toolBody).toContain('if (!entry)');
      expect(toolBody).toContain('runGit(cloneArgs, {}, workdir)');
      expect(toolBody).toContain('runGit(cloneArgs, tmp.env, workdir)');
      expect(toolBody).toContain('buildGitEnv(entry)');
      expect(toolBody).toContain('cleanupTemp(p)');
    }
    const pushStart = content.indexOf('export const push = tool({');
    const pushEnd = content.indexOf('\n});', pushStart);
    const pushBody = content.slice(pushStart, pushEnd);
    expect(pushBody).toContain('loadCredential(repoUrl)');
    expect(pushBody).not.toContain('tryLoadCredential');
    expect(pushBody).not.toContain('if (!entry)');
    expect(pushBody).toContain('buildGitEnv(entry)');
    expect(pushBody).toContain('cleanupTemp(p)');
  });

  it('push execute 含 write 授权校验', () => {
    const content = renderGitToolsFile();
    const start = content.indexOf('export const push = tool({');
    const end = content.indexOf('});', start);
    const pushBody = content.slice(start, end);
    expect(pushBody).toContain('permission !== "write"');
    expect(pushBody).toContain('禁止 push');
  });
});

describe('git 凭证辅助函数（渲染产物内联实现，todo 4）', () => {
  it('normalizeRepoUrl：trim + 去尾部 .git（含大写 .GIT）+ 协议小写', () => {
    expect(normalizeRepoUrl('  https://gitee.com/xishuhq/ketaops.git  ')).toBe('https://gitee.com/xishuhq/ketaops');
    expect(normalizeRepoUrl('https://gitee.com/xishuhq/ketaops.GIT')).toBe('https://gitee.com/xishuhq/ketaops');
    expect(normalizeRepoUrl('HTTPS://gitee.com/xishuhq/ketaops.git')).toBe('https://gitee.com/xishuhq/ketaops');
    expect(normalizeRepoUrl('  ssh://git@gitee.com/xishuhq/repo.git')).toBe('ssh://git@gitee.com/xishuhq/repo');
    expect(normalizeRepoUrl('git@gitee.com:xishuhq/ketaops.git')).toBe('git@gitee.com:xishuhq/ketaops');
    expect(normalizeRepoUrl('')).toBe('');
  });

  it('writeAskpass：含单引号 token 转义后 echo 脚本不破', () => {
    const scriptPath = writeAskpass("to'ken");
    const realReadFileSync = jest.requireActual<typeof import('fs')>('fs').readFileSync;
    try {
      const content = realReadFileSync(scriptPath, 'utf8');
      expect(content).toBe(`#!/bin/sh\necho 'to'\\''ken'\n`);
      expect(content).toContain("'to'\\''ken'");
      // 未转义直接拼接会提前闭合 echo 单引号，导致脚本损坏
      expect(content).not.toContain("echo 'to'ken'\n");
    } finally {
      cleanupTemp(scriptPath);
    }
    expect(fs.existsSync(scriptPath)).toBe(false);
  });

  it('writeTempKey：临时 key 权限 600 且可清理', () => {
    const keyPath = writeTempKey('-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----');
    try {
      expect((fs.statSync(keyPath).mode & 0o777)).toBe(0o600);
    } finally {
      cleanupTemp(keyPath);
    }
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('buildGitEnv：ssh_key 走 GIT_SSH_COMMAND 临时 key / https_token 走 GIT_ASKPASS 脚本', () => {
    const ssh = buildGitEnv({ repoUrl: 'git@gitee.com:xishuhq/a.git', authType: 'ssh_key', key: 'FAKEKEY', permission: 'write' });
    try {
      expect(ssh.env.GIT_SSH_COMMAND).toContain('ssh -i ');
      expect(ssh.env.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes');
      expect(ssh.env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=no');
      expect(ssh.paths).toHaveLength(1);
      expect(fs.existsSync(ssh.paths[0])).toBe(true);
    } finally {
      for (const p of ssh.paths) cleanupTemp(p);
    }

    const https = buildGitEnv({ repoUrl: 'https://gitee.com/xishuhq/a.git', authType: 'https_token', key: 'tok en', permission: 'read' });
    try {
      expect(https.env.GIT_ASKPASS).toBeTruthy();
      expect(https.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(https.paths).toHaveLength(1);
      expect(fs.existsSync(https.paths[0])).toBe(true);
    } finally {
      for (const p of https.paths) cleanupTemp(p);
    }
  });

  it('loadCredential：凭证文件缺失/损坏 → 抛「仓库凭证文件不存在或损坏」', () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    try {
      expect(() => loadCredential('https://gitee.com/xishuhq/ketaops.git')).toThrow('仓库凭证文件不存在或损坏');
    } finally {
      (fs.readFileSync as jest.Mock).mockReset();
    }
  });

  it('loadCredential：白名单未命中 → 抛未授权，错误不含明文 key', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-08-12T00:00:00.000Z',
        credentials: [
          { repoUrl: 'https://gitee.com/xishuhq/authorized.git', authType: 'https_token', key: 'SUPER_SECRET_TOKEN', permission: 'read' },
        ],
      }),
    );
    try {
      let message = '';
      try {
        loadCredential('https://gitee.com/xishuhq/unauthorized.git');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('仓库未授权或凭证缺失');
      expect(message).toContain('https://gitee.com/xishuhq/unauthorized');
      expect(message).not.toContain('SUPER_SECRET_TOKEN');
    } finally {
      (fs.readFileSync as jest.Mock).mockReset();
    }
  });

  it('loadCredential：规范化匹配（.git 后缀/大小写/trim）命中白名单并返回条目', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-08-12T00:00:00.000Z',
        credentials: [
          { repoUrl: 'https://gitee.com/xishuhq/authorized.git', authType: 'https_token', key: 'tok', permission: 'write' },
        ],
      }),
    );
    try {
      const entry = loadCredential('  HTTPS://gitee.com/xishuhq/authorized.GIT  ');
      expect(entry.permission).toBe('write');
      expect(entry.authType).toBe('https_token');
    } finally {
      (fs.readFileSync as jest.Mock).mockReset();
    }
  });

  it('tryLoadCredential：凭证文件缺失/损坏 → 返回 null（不抛错，公开仓库直连）', () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    try {
      expect(tryLoadCredential('https://github.com/guolong123/cliyard')).toBeNull();
    } finally {
      (fs.readFileSync as jest.Mock).mockReset();
    }
    (fs.readFileSync as jest.Mock).mockReturnValue('not-json{{{');
    try {
      expect(tryLoadCredential('https://github.com/guolong123/cliyard')).toBeNull();
    } finally {
      (fs.readFileSync as jest.Mock).mockReset();
    }
  });

  it('tryLoadCredential：白名单未命中 → 返回 null（不抛错，clone 直连无 throw）', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-08-12T00:00:00.000Z',
        credentials: [
          { repoUrl: 'https://gitee.com/xishuhq/authorized.git', authType: 'https_token', key: 'tok', permission: 'read' },
        ],
      }),
    );
    try {
      expect(tryLoadCredential('https://github.com/guolong123/cliyard')).toBeNull();
    } finally {
      (fs.readFileSync as jest.Mock).mockReset();
    }
  });

  it('tryLoadCredential：规范化匹配命中 → 返回条目（clone 有凭证走注入 env 流程）', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-08-12T00:00:00.000Z',
        credentials: [
          { repoUrl: 'https://gitee.com/xishuhq/authorized.git', authType: 'https_token', key: 'tok', permission: 'read' },
        ],
      }),
    );
    try {
      const entry = tryLoadCredential('  HTTPS://gitee.com/xishuhq/authorized.GIT  ');
      expect(entry).not.toBeNull();
      expect(entry!.permission).toBe('read');
      const built = buildGitEnv(entry!);
      try {
        expect(built.env.GIT_ASKPASS).toBeTruthy();
      } finally {
        for (const p of built.paths) cleanupTemp(p);
      }
    } finally {
      (fs.readFileSync as jest.Mock).mockReset();
    }
  });

  it('push 无凭证仍抛错（loadCredential 未命中抛未授权，守卫不变）', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ version: 1, updatedAt: '2026-08-12T00:00:00.000Z', credentials: [] }),
    );
    try {
      expect(() => loadCredential('https://github.com/guolong123/cliyard')).toThrow('仓库未授权或凭证缺失');
      expect(tryLoadCredential('https://github.com/guolong123/cliyard')).toBeNull();
    } finally {
      (fs.readFileSync as jest.Mock).mockReset();
    }
    const content = renderGitToolsFile();
    const start = content.indexOf('export const push = tool({');
    const pushBody = content.slice(start, content.indexOf('});', start));
    expect(pushBody).toContain('loadCredential(repoUrl)');
    expect(pushBody).toContain('permission !== "write"');
  });

  it('渲染产物含 tryLoadCredential 内联实现与双分支（有凭证注入 / 无凭证直接 runGit）', () => {
    const content = renderGitToolsFile();
    expect(content).toContain(tryLoadCredential.toString());
    expect(content).toContain('const entry = tryLoadCredential(repoUrl);');
    expect(content).toContain('if (!entry) {');
    expect(content).toContain('return runGit(_buildGitArgs(');
  });
});

describe('normalizeSshKey（OPENSSH 容器 ssh-rsa → PKCS#1 PEM 格式归一）', () => {
  // 测试 key 均为本机 ssh-keygen 临时生成（脱敏，非平台真实私钥）；读文件走真实 fs
  // （顶层 jest.mock('fs') 仅 mock readFileSync）。
  const realRead = (p: string): string => jest.requireActual<typeof import('fs')>('fs').readFileSync(p, 'utf8');

  let sshRsaKey = '';
  let sshEd25519Key = '';
  let sshEncryptedKey = '';
  let sshKeygenAvailable = false;

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-norm-spec-'));
    const gen = (name: string, extra: string[]): string => {
      const p = path.join(tmpDir, name);
      const r = child_process.spawnSync('ssh-keygen', ['-t', ...extra, '-f', p, '-N', '', '-q', '-C', 'keta-test'], { encoding: 'utf8' });
      if (r.status !== 0) return '';
      return realRead(p);
    };
    sshRsaKey = gen('rsa', ['rsa', '-b', '3072']);
    if (sshRsaKey) {
      sshKeygenAvailable = true;
      sshEd25519Key = gen('ed25519', ['ed25519']);
      const encP = path.join(tmpDir, 'enc');
      const enc = child_process.spawnSync('ssh-keygen', ['-t', 'rsa', '-b', '3072', '-f', encP, '-N', 'passphrase', '-q', '-C', 'keta-test'], { encoding: 'utf8' });
      if (enc.status === 0) sshEncryptedKey = realRead(encP);
    }
    jest.requireActual<typeof import('fs')>('fs').rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- OpenSSH 公钥 blob / DER 解析独立实现（与 normalizeSshKey 内部实现不同源，交叉验证） ----
  const sshString = (buf: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length, 0);
    return Buffer.concat([len, buf]);
  };
  const sshU32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
  };
  const mpintEnc = (v: bigint, opts: { signByte?: boolean; extraZero?: number } = {}): Buffer => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const bytes: number[] = [...Buffer.from(hex, 'hex')];
    if (opts.signByte && (bytes[0] & 0x80) !== 0) bytes.unshift(0);
    for (let i = 0; i < (opts.extraZero ?? 0); i++) bytes.unshift(0);
    return sshString(Buffer.from(bytes));
  };
  const pubFingerprint = (blob: Buffer): string => {
    const digest = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
    return `SHA256:${digest}`;
  };
  const opensshPubBlob = (key: string): Buffer => {
    const b64 = key
      .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/g, '')
      .replace(/-----END OPENSSH PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '');
    const buf = Buffer.from(b64, 'base64');
    const MAGIC = Buffer.from('openssh-key-v1\0', 'utf8');
    let off = MAGIC.length;
    const readStr = (): Buffer => {
      const len = buf.readUInt32BE(off);
      off += 4;
      const out = buf.subarray(off, off + len);
      off += len;
      return out;
    };
    readStr(); // ciphername
    readStr(); // kdfname
    readStr(); // kdfoptions
    off += 4; // nkeys
    return readStr(); // public key blob
  };
  const pubMpint = (v: bigint): Buffer => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const bytes: number[] = [...Buffer.from(hex, 'hex')];
    if ((bytes[0] & 0x80) !== 0) bytes.unshift(0); // 正数符号位填充
    return sshString(Buffer.from(bytes));
  };
  const pubBlobFromDer = (n: bigint, e: bigint): Buffer =>
    Buffer.concat([sshString(Buffer.from('ssh-rsa', 'utf8')), pubMpint(e), pubMpint(n)]);
  const parsePkcs1Der = (pem: string): bigint[] => {
    const b64 = pem
      .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
      .replace(/-----END RSA PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '');
    const der = Buffer.from(b64, 'base64');
    if (der[0] !== 0x30) throw new Error('not a DER sequence');
    let lenBytes = 1;
    let seqLen = der[1];
    if ((seqLen & 0x80) !== 0) {
      lenBytes = seqLen & 0x7f;
      seqLen = 0;
      for (let i = 0; i < lenBytes; i++) seqLen = (seqLen << 8) | der[2 + i];
    }
    // content 起点：短格式（长度 1 字节）为 2；长格式为 2 + lenBytes（含 0x82 标记字节）
    const contentStart = (der[1] & 0x80) !== 0 ? 2 + lenBytes : 2;
    let pos = contentStart;
    const ints: bigint[] = [];
    while (pos < contentStart + seqLen) {
      if (der[pos] !== 0x02) throw new Error('not a DER integer');
      let len = der[pos + 1];
      let lenBytes = 1;
      if ((len & 0x80) !== 0) {
        // INTEGER 内容长格式长度（>127 字节，如 3072bit 的 n/e/d/p/q）
        lenBytes = len & 0x7f;
        len = 0;
        for (let i = 0; i < lenBytes; i++) len = (len << 8) | der[pos + 2 + i];
      }
      let v = 0n;
      // 长度字段总字节：短格式 1；长格式 = 1(0x82 marker) + lenBytes
      const lenFieldBytes = (der[pos + 1] & 0x80) !== 0 ? 1 + lenBytes : 1;
      for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(der[pos + 1 + lenFieldBytes + i]);
      pos += 1 + lenFieldBytes + len;
      ints.push(v);
    }
    return ints;
  };
  // 构造无加密 openssh-key-v1 容器（可控 mpint 前导零/符号位，p<q 顺序）。
  // 固定小 RSA 参数：p=53, q=61, n=3233, φ=3120；e=17→d=2753, e=161→d=1841, iqmp=20。
  const buildOpensshRsaV1 = (opts: { e: bigint; eMpintOpts?: { signByte?: boolean; extraZero?: number } }): string => {
    const p = 53n;
    const q = 61n;
    const n = 3233n;
    const d = opts.e === 17n ? 2753n : 1841n;
    const iqmp = 20n;
    const eBytes = mpintEnc(opts.e, opts.eMpintOpts);
    const pubFields = Buffer.concat([sshString(Buffer.from('ssh-rsa', 'utf8')), mpintEnc(opts.e), mpintEnc(n)]);
    const privFields = Buffer.concat([
      sshString(Buffer.from('ssh-rsa', 'utf8')),
      mpintEnc(n),
      eBytes,
      mpintEnc(d),
      mpintEnc(iqmp),
      mpintEnc(p),
      mpintEnc(q),
      sshString(Buffer.from('keta-test', 'utf8')),
    ]);
    const checkint = 0xdeadbeef;
    const privCore = Buffer.concat([sshU32(checkint), sshU32(checkint), privFields]);
    const pad = Buffer.from(Array.from({ length: (8 - (privCore.length % 8)) % 8 }, (_, i) => i + 1));
    const body = Buffer.concat([
      Buffer.from('openssh-key-v1\0', 'utf8'),
      sshString(Buffer.from('none', 'utf8')),
      sshString(Buffer.from('none', 'utf8')),
      sshString(Buffer.alloc(0)),
      sshU32(1),
      sshString(pubFields),
      sshString(Buffer.concat([privCore, pad])),
    ]);
    const b64 = body
      .toString('base64')
      .replace(/(.{64})/g, '$1\n')
      .replace(/\n$/, '');
    return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
  };

  it('ssh-rsa OPENSSH 容器 → PKCS#1 PEM：头正确 + 指纹不变（容器 blob vs DER 重建 vs ssh-keygen 三方交叉）', () => {
    if (!sshKeygenAvailable) return;
    const pem = normalizeSshKey(sshRsaKey);
    expect(pem.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(pem.endsWith('-----END RSA PRIVATE KEY-----\n')).toBe(true);
    expect(pem).not.toContain('BEGIN OPENSSH PRIVATE KEY');

    const fpContainer = pubFingerprint(opensshPubBlob(sshRsaKey));
    const [version, n, e] = parsePkcs1Der(pem);
    expect(version).toBe(0n);
    expect(pubFingerprint(pubBlobFromDer(n, e))).toBe(fpContainer);

    const pemPath = path.join(os.tmpdir(), `keta-norm-fp-${crypto.randomBytes(4).toString('hex')}`);
    try {
      jest.requireActual<typeof import('fs')>('fs').writeFileSync(pemPath, pem, { mode: 0o600 });
      const fp = child_process.spawnSync('ssh-keygen', ['-lf', pemPath], { encoding: 'utf8' });
      expect(fp.status).toBe(0);
      expect(fp.stdout).toContain(fpContainer);
    } finally {
      cleanupTemp(pemPath);
    }
  });

  it('ssh-keygen -y 可加载转换后 PEM 且公钥与容器公钥一致', () => {
    if (!sshKeygenAvailable) return;
    const pem = normalizeSshKey(sshRsaKey);
    const pemPath = path.join(os.tmpdir(), `keta-norm-y-${crypto.randomBytes(4).toString('hex')}`);
    try {
      jest.requireActual<typeof import('fs')>('fs').writeFileSync(pemPath, pem, { mode: 0o600 });
      const y = child_process.spawnSync('ssh-keygen', ['-y', '-f', pemPath], { encoding: 'utf8' });
      expect(y.status).toBe(0);
      // ssh-rsa 公钥行 = "ssh-rsa <base64(pubblob)> comment"；容器 blob base64 应为其中字段
      const pubText = (y.stdout ?? '').trim().split(/\s+/);
      expect(pubText[0]).toBe('ssh-rsa');
      expect(Buffer.from(pubText[1], 'base64').equals(opensshPubBlob(sshRsaKey))).toBe(true);
    } finally {
      cleanupTemp(pemPath);
    }
  });

  it('PEM 体为 64 字符换行（除末行外行长为 64）', () => {
    if (!sshKeygenAvailable) return;
    const pem = normalizeSshKey(sshRsaKey);
    const lines = pem.split('\n').filter((l) => l && !l.startsWith('-----'));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) {
      expect(line.length).toBe(64);
    }
    expect(lines[lines.length - 1].length).toBeLessThanOrEqual(64);
  });

  it('ed25519 OPENSSH 容器 → 原样返回（不转换）', () => {
    if (!sshKeygenAvailable) return;
    expect(sshEd25519Key).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(normalizeSshKey(sshEd25519Key)).toBe(sshEd25519Key);
  });

  it('PEM/其他格式（含 PKCS#8 BEGIN PRIVATE KEY）→ 原样返回', () => {
    const rsaPem = '-----BEGIN RSA PRIVATE KEY-----\nFAKEBASE64\n-----END RSA PRIVATE KEY-----';
    const pkcs8 = '-----BEGIN PRIVATE KEY-----\nFAKEBASE64\n-----END PRIVATE KEY-----';
    const ec = '-----BEGIN EC PRIVATE KEY-----\nFAKEBASE64\n-----END EC PRIVATE KEY-----';
    expect(normalizeSshKey(rsaPem)).toBe(rsaPem);
    expect(normalizeSshKey(pkcs8)).toBe(pkcs8);
    expect(normalizeSshKey(ec)).toBe(ec);
  });

  it('加密的 OPENSSH 私钥 → 明确抛错（不静默降级）', () => {
    if (!sshKeygenAvailable) return;
    expect(sshEncryptedKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(() => normalizeSshKey(sshEncryptedKey)).toThrow('encrypted openssh private key is not supported');
  });

  it('坏 magic / 空体 → 抛错', () => {
    expect(() => normalizeSshKey('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----')).toThrow('bad magic');
    expect(() => normalizeSshKey('-----BEGIN OPENSSH PRIVATE KEY-----\n-----END OPENSSH PRIVATE KEY-----')).toThrow('empty body');
  });

  it('mpint 边界：冗余前导零（e=17 编码为 0x00 0x11）剥离后 DER 字段正确', () => {
    const key = buildOpensshRsaV1({ e: 17n, eMpintOpts: { extraZero: 1 } });
    const [version, n, e, d, p, q, dp, dq, qinv] = parsePkcs1Der(normalizeSshKey(key));
    expect([version, n, e, d, p, q, dp, dq, qinv]).toEqual([0n, 3233n, 17n, 2753n, 53n, 61n, 49n, 53n, 20n]);
  });

  it('mpint 边界：符号位前导零 + 冗余前导零（e=0xA1）剥离后 DER 字段正确', () => {
    const key = buildOpensshRsaV1({ e: 161n, eMpintOpts: { signByte: true, extraZero: 1 } });
    const [version, n, e, d, p, q, dp, dq, qinv] = parsePkcs1Der(normalizeSshKey(key));
    expect([version, n, e, d, p, q, dp, dq, qinv]).toEqual([0n, 3233n, 161n, 1841n, 53n, 61n, 21n, 41n, 20n]);
  });

  it('p<q 顺序（53<61）保持 OpenSSH 参数次序，PKCS#1 字段正确', () => {
    const key = buildOpensshRsaV1({ e: 17n });
    const [version, n, e, d, p, q, dp, dq, qinv] = parsePkcs1Der(normalizeSshKey(key));
    expect(version).toBe(0n);
    expect(p).toBe(53n);
    expect(q).toBe(61n);
    expect(p < q).toBe(true);
    expect(n).toBe(p * q);
  });

  it('writeTempKey：OPENSSH ssh-rsa 写临时文件为 PKCS#1 PEM（600 权限）', () => {
    if (!sshKeygenAvailable) return;
    const keyPath = writeTempKey(sshRsaKey);
    try {
      const content = realRead(keyPath);
      expect(content.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
      expect((fs.statSync(keyPath).mode & 0o777)).toBe(0o600);
    } finally {
      cleanupTemp(keyPath);
    }
  });

  it('writeTempKey：加密 OPENSSH 私钥转换失败抛错（不写坏文件）', () => {
    if (!sshKeygenAvailable) return;
    expect(() => writeTempKey(sshEncryptedKey)).toThrow('encrypted openssh private key is not supported');
  });

  it('渲染产物内联 normalizeSshKey（writeTempKey 依赖其存在，防 ReferenceError）', () => {
    const content = renderGitToolsFile();
    expect(content).toContain(normalizeSshKey.toString());
    expect(content.indexOf(normalizeSshKey.toString())).toBeLessThan(content.indexOf(writeTempKey.toString()));
    expect(writeTempKey.toString()).toContain('normalizeSshKey(');
  });
});

describe('workdir 可选参数（仓库子目录执行）', () => {
  it('7 个工具均含可选 string workdir（描述一致），其他参数/必填性不变', () => {
    expect(GIT_TOOLS).toHaveLength(7);
    for (const tool of GIT_TOOLS) {
      const workdir = tool.args.find((a) => a.name === 'workdir');
      expect(workdir).toBeDefined();
      expect(workdir!.type).toBe('string');
      expect(workdir!.required).toBe(false);
      expect(workdir!.description).toBe('执行目录（仓库绝对路径，缺省为会话目录）');
    }
    const byName = (n: string): GitToolDef => GIT_TOOLS.find((t) => t.name === n)!;
    expect(byName('git_clone').args.find((a) => a.name === 'repo_url')?.required).toBe(true);
    expect(byName('git_push').args.find((a) => a.name === 'refspec')?.required).toBe(true);
    expect(byName('git_push').defaultEffect).toBe('ask');
  });

  it('runGit：传入 cwd 时 spawnSync options 含 cwd；缺省时无 cwd 键', () => {
    const spawnSync = child_process.spawnSync as unknown as jest.Mock;
    const realSpawnSync = (jest.requireActual<typeof import('child_process')>('child_process') as typeof import('child_process')).spawnSync as (...a: never[]) => unknown;
    spawnSync.mockImplementation(((...args: never[]) => realSpawnSync(...args)) as never);
    try {
      spawnSync.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });
      runGit(['status'], {}, '/data/vteam-worker/tasks/t1/cliyard');
      expect(spawnSync).toHaveBeenCalledWith('git', ['status'], expect.objectContaining({ cwd: '/data/vteam-worker/tasks/t1/cliyard' }));

      spawnSync.mockClear();
      spawnSync.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });
      runGit(['status'], {});
      const opts = spawnSync.mock.calls[0][2] as Record<string, unknown>;
      expect(opts).not.toHaveProperty('cwd');

      spawnSync.mockClear();
      spawnSync.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });
      runGit(['status']);
      const optsDefault = spawnSync.mock.calls[0][2] as Record<string, unknown>;
      expect(optsDefault).not.toHaveProperty('cwd');
    } finally {
      spawnSync.mockImplementation(((...args: never[]) => realSpawnSync(...args)) as never);
      spawnSync.mockClear();
    }
  });

  it('渲染产物：远端工具（clone/pull/fetch/push）execute 含 workdir 透传', () => {
    const content = renderGitToolsFile();
    for (const tool of ['clone', 'pull', 'fetch', 'push']) {
      const start = content.indexOf(`export const ${tool} = tool({`);
      const end = content.indexOf('\n});', start);
      const toolBody = content.slice(start, end);
      expect(toolBody).toContain('const workdir = args.workdir ? String(args.workdir) : undefined;');
      expect(toolBody).toContain('workdir');
      expect(toolBody).toContain('workdir: tool.schema.string().optional()');
    }
    expect(content).toContain('const cloneArgs = _buildGitArgs("clone", { ...args, target: absTarget });');
    expect(content).toContain('runGit(cloneArgs, {}, workdir)');
    expect(content).toContain('runGit(cloneArgs, tmp.env, workdir)');
    expect(content).toContain('return runGit(_buildGitArgs("push", args), tmp.env, workdir);');
  });

  it('渲染产物：本地工具（status/diff/log）execute 含 workdir 透传', () => {
    const content = renderGitToolsFile();
    for (const tool of ['status', 'diff', 'log']) {
      const start = content.indexOf(`export const ${tool} = tool({`);
      const end = content.indexOf('\n});', start);
      const toolBody = content.slice(start, end);
      expect(toolBody).toContain('const workdir = args.workdir ? String(args.workdir) : undefined;');
      expect(toolBody).toContain('return runGit(gitArgs, {}, workdir);');
      expect(toolBody).toContain('workdir: tool.schema.string().optional()');
    }
  });

  it('push 守卫 + fallback 语义不变（workdir 仅透传 cwd）', () => {
    const content = renderGitToolsFile();
    const pushStart = content.indexOf('export const push = tool({');
    const pushBody = content.slice(pushStart, content.indexOf('\n});', pushStart));
    expect(pushBody).toContain('loadCredential(repoUrl)');
    expect(pushBody).not.toContain('tryLoadCredential');
    expect(pushBody).toContain('permission !== "write"');
    expect(pushBody).toContain('禁止 push');
    expect(pushBody).toContain('tmp.env, workdir');
    for (const tool of ['clone', 'pull', 'fetch']) {
      const start = content.indexOf(`export const ${tool} = tool({`);
      const toolBody = content.slice(start, content.indexOf('\n});', start));
      expect(toolBody).toContain('tryLoadCredential(repoUrl)');
      expect(toolBody).toContain('if (!entry)');
    }
    expect(content).toContain(runGit.toString());
  });
});

describe('git_clone 中央库默认落点与复用（WORK_DIR/repos）', () => {
  const realFs = jest.requireActual<typeof import('fs')>('fs');
  const realCp = jest.requireActual<typeof import('child_process')>('child_process');
  const passthroughSpawn = (): void => {
    const spawnSync = child_process.spawnSync as unknown as jest.Mock;
    spawnSync.mockImplementation(((...args: never[]) =>
      (realCp.spawnSync as (...a: never[]) => unknown)(...(args as never[]))) as never);
  };
  const realGit = (args: string[], cwd?: string): void => {
    const r = realCp.spawnSync('git', args, { encoding: 'utf8', cwd });
    if (r.status !== 0) {
      throw new Error(`real git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
    }
  };

  it('defaultRepoName：去 .git 后缀，取最后 / 或 : 之后一段（scp 兼容）', () => {
    expect(defaultRepoName('git@gitee.com:xishuhq/ketaops.git')).toBe('ketaops');
    expect(defaultRepoName('https://gitee.com/xishuhq/ketaops.git')).toBe('ketaops');
    expect(defaultRepoName('https://github.com/guolong123/cliyard')).toBe('cliyard');
    expect(defaultRepoName('  https://gitee.com/xishuhq/ketaops.GIT  ')).toBe('ketaops');
    expect(defaultRepoName('ssh://git@gitee.com/xishuhq/repo.git')).toBe('repo');
    expect(defaultRepoName('')).toBe('repo');
  });

  it('resolveCloneTarget：显式 target 优先（绝对直接用，相对按 cwd 解析）；缺省落中央库', () => {
    const prev = process.env.WORK_DIR;
    process.env.WORK_DIR = '/data/vteam-worker';
    try {
      expect(resolveCloneTarget('https://gitee.com/x/ketaops.git')).toBe('/data/vteam-worker/repos/ketaops');
      expect(resolveCloneTarget('git@gitee.com:xishuhq/ketaops.git')).toBe('/data/vteam-worker/repos/ketaops');
      expect(resolveCloneTarget('https://gitee.com/x/ketaops.git', '/tmp/custom/dir')).toBe('/tmp/custom/dir');
      expect(resolveCloneTarget('https://gitee.com/x/ketaops.git', 'rel/dir')).toBe(
        path.resolve(process.cwd(), 'rel/dir'),
      );
    } finally {
      if (prev === undefined) delete process.env.WORK_DIR;
      else process.env.WORK_DIR = prev;
    }
  });

  it('resolveCloneTarget：WORK_DIR 未设置回退 <cwd>/repos', () => {
    const prev = process.env.WORK_DIR;
    delete process.env.WORK_DIR;
    try {
      expect(resolveCloneTarget('https://gitee.com/x/ketaops.git')).toBe(
        path.join(process.cwd(), 'repos', 'ketaops'),
      );
    } finally {
      if (prev !== undefined) process.env.WORK_DIR = prev;
    }
  });

  it('prepareCloneTarget 真仓复用：缺省落中央库（建父目录），同仓二次复用不拉取；异仓/非仓占位抛错提示传 target', () => {
    passthroughSpawn();
    const prev = process.env.WORK_DIR;
    const root = realFs.mkdtempSync(path.join(os.tmpdir(), 'keta-clone-central-'));
    process.env.WORK_DIR = root;
    try {
      const srcA = path.join(root, 'srcA');
      realFs.mkdirSync(srcA, { recursive: true });
      realGit(['init'], srcA);
      realGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], srcA);
      const first = prepareCloneTarget(srcA);
      expect(first.reused).toBe(false);
      expect(first.absTarget).toBe(path.join(root, 'repos', 'srcA'));
      expect(realFs.existsSync(path.join(root, 'repos'))).toBe(true);
      realGit(['clone', srcA, first.absTarget]);
      const second = prepareCloneTarget(srcA);
      expect(second).toEqual({ absTarget: first.absTarget, reused: true });
      expect(isSameRepoCheckout(first.absTarget, srcA)).toBe(true);
      const srcB = path.join(root, 'srcB');
      realFs.mkdirSync(srcB, { recursive: true });
      realGit(['init'], srcB);
      realGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], srcB);
      expect(() => prepareCloneTarget(srcB, first.absTarget)).toThrow(/已被其他仓库占用/);
      expect(() => prepareCloneTarget(srcB, first.absTarget)).toThrow(/target/);
      const plain = path.join(root, 'plain');
      realFs.mkdirSync(plain, { recursive: true });
      realFs.writeFileSync(path.join(plain, 'f.txt'), 'x');
      expect(() => prepareCloneTarget(srcB, plain)).toThrow(/已被其他仓库占用/);
    } finally {
      if (prev === undefined) delete process.env.WORK_DIR;
      else process.env.WORK_DIR = prev;
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('渲染产物 clone 分支：中央库复用 + 绝对路径回吐 + 异仓占位报错，不自动拉取', () => {
    const content = renderGitToolsFile();
    const start = content.indexOf('export const clone = tool({');
    const end = content.indexOf('\n});', start);
    const toolBody = content.slice(start, end);
    expect(toolBody).toContain('prepareCloneTarget(repoUrl, args.target ? String(args.target) : undefined)');
    expect(toolBody).toContain('已存在相同仓库，直接复用');
    expect(toolBody).toContain('未执行拉取');
    expect(toolBody).toContain('仓库目录：');
    expect(prepareCloneTarget.toString()).toContain('已被其他仓库占用');
    expect(toolBody).not.toContain('"pull"');
    expect(toolBody).not.toContain('"fetch"');
    expect(content).toContain(defaultRepoName.toString());
    expect(content).toContain(resolveCloneTarget.toString());
    expect(content).toContain(isSameRepoCheckout.toString());
    expect(content).toContain(prepareCloneTarget.toString());
    expect(content).toContain('process.env.WORK_DIR');
  });
});
