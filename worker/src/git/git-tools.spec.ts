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
  normalizeRepoUrl,
  loadCredential,
  writeTempKey,
  writeAskpass,
  buildGitEnv,
  cleanupTemp,
} from './git-tools';

// loadCredential 单测需拦截 fs.readFileSync；jest.spyOn 在本环境对 Node 内置 fs 无效
// （__importStar 生成模块副本），故模块级部分 mock：仅 readFileSync 为 jest.fn，其余真实。
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, readFileSync: jest.fn() };
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
      expect(toolBody).toContain('runGit(gitArgs);');
    }
  });

  it('clone/pull/fetch/push execute 走凭证白名单 + try/finally 清理', () => {
    const content = renderGitToolsFile();
    for (const tool of ['clone', 'pull', 'fetch', 'push']) {
      const start = content.indexOf(`export const ${tool} = tool({`);
      const end = content.indexOf('});', start);
      const toolBody = content.slice(start, end);
      expect(toolBody).toContain('loadCredential');
      expect(toolBody).toContain('buildGitEnv(entry)');
      expect(toolBody).toContain('cleanupTemp(p)');
    }
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
});
