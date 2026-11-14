/**
 * workspace-path-shim 单测（Windows 原生支持）。
 *
 * 真机背景：控制面下发 POSIX `/data/vteam-worker/...` 工作区路径，Windows worker 的
 * WORK_DIR 是 `C:\...`；serve 按目录发现 agent（不上溯父目录）⇒ 不翻译就 Agent not found。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  POSIX_WORKSPACE_ROOT,
  materializeProjectConfig,
  toLocalWorkspacePath,
} from './workspace-path-shim';

describe('toLocalWorkspacePath', () => {
  const workDir = 'C:\\ProgramData\\vteam-worker\\work';

  it('POSIX 平台原样返回（行为不变）', () => {
    expect(toLocalWorkspacePath('/data/vteam-worker/teams/tm_1', workDir, 'linux')).toBe(
      '/data/vteam-worker/teams/tm_1',
    );
    expect(toLocalWorkspacePath('/data/vteam-worker', workDir, 'darwin')).toBe(
      '/data/vteam-worker',
    );
  });

  it('win32：根目录映射到 WORK_DIR', () => {
    expect(toLocalWorkspacePath(POSIX_WORKSPACE_ROOT, workDir, 'win32')).toBe(workDir);
  });

  it('win32：子目录映射到 WORK_DIR 下（反斜杠本地路径）', () => {
    const mapped = toLocalWorkspacePath('/data/vteam-worker/teams/tm_1', workDir, 'win32');
    expect(mapped).toBe(path.join(workDir, 'teams/tm_1'));
  });

  it('win32：非该前缀的路径（本地路径）原样返回', () => {
    expect(toLocalWorkspacePath('C:\\other\\dir', workDir, 'win32')).toBe('C:\\other\\dir');
    expect(toLocalWorkspacePath('/tmp/x', workDir, 'win32')).toBe('/tmp/x');
  });

  it('空目录/空 workDir 不炸', () => {
    expect(toLocalWorkspacePath('', workDir, 'win32')).toBe('');
    expect(toLocalWorkspacePath('/data/vteam-worker', '', 'win32')).toBe('/data/vteam-worker');
  });
});

describe('materializeProjectConfig', () => {
  let tmp: string;
  let workDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-shim-'));
    workDir = path.join(tmp, 'work');
    fs.mkdirSync(path.join(workDir, '.opencode', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({ agents: { 'vteam-x': {} } }),
      'utf8',
    );
    fs.writeFileSync(path.join(workDir, '.opencode', 'plugins', 'git.ts'), '// git', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('win32：把 opencode.json 与 .opencode/ 物化到会话子目录（幂等）', () => {
    const target = path.join(workDir, 'teams', 'tm_1');
    materializeProjectConfig(workDir, target, undefined, 'win32');
    expect(fs.existsSync(path.join(target, 'opencode.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.opencode', 'plugins', 'git.ts'))).toBe(true);

    // 幂等：内容一致时不重复写（行为等价；这里只断言结果仍为源内容）
    materializeProjectConfig(workDir, target, undefined, 'win32');
    expect(JSON.parse(fs.readFileSync(path.join(target, 'opencode.json'), 'utf8'))).toEqual({
      agents: { 'vteam-x': {} },
    });
  });

  it('源配置变化后刷新目标目录（升级 MCP URL 场景）', () => {
    const target = path.join(workDir, 'teams', 'tm_2');
    materializeProjectConfig(workDir, target, undefined, 'win32');
    expect(fs.readFileSync(path.join(target, 'opencode.json'), 'utf8')).toContain('vteam-x');

    fs.writeFileSync(
      path.join(workDir, 'opencode.json'),
      JSON.stringify({ agents: { 'vteam-y': {} } }),
      'utf8',
    );
    materializeProjectConfig(workDir, target, undefined, 'win32');
    expect(fs.readFileSync(path.join(target, 'opencode.json'), 'utf8')).toContain('vteam-y');
  });

  it('目标 == WORK_DIR 时 no-op（不自我拷贝）', () => {
    materializeProjectConfig(workDir, workDir, undefined, 'win32');
    expect(fs.existsSync(path.join(workDir, 'opencode.json'))).toBe(true);
  });

  it('POSIX 平台 no-op', () => {
    const target = path.join(tmp, 'posix-target');
    materializeProjectConfig(workDir, target, undefined, 'linux');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('目录不可创建时只告警、不抛错', () => {
    const warn = jest.fn();
    const badTarget = path.join(workDir, 'opencode.json', 'nested');
    fs.writeFileSync(path.join(workDir, 'sibling'), 'x'); // 不影响断言
    expect(() =>
      materializeProjectConfig(workDir, badTarget, { warn }, 'win32'),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
