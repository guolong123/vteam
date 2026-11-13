/**
 * runtime/cli-command 单测（Windows 原生支持 · M0）。
 *
 * 平台分支全部通过 `platform` 注入覆盖（在 macOS 上也能验证 win32 的命令行构造），
 * 不依赖真实 Windows；真实 spawn 语义由 GitHub Actions windows-latest 的 smoke 覆盖。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildWindowsCommandLine,
  isWindowsAbsolutePath,
  resetCliResolutionCache,
  resolveCliCommand,
  spawnCliSync,
} from './cli-command';

describe('resolveCliCommand · POSIX', () => {
  it('原样返回（不引入任何行为变化）', () => {
    const resolved = resolveCliCommand({
      command: 'opencode',
      args: ['serve', '--port', '4199'],
      platform: 'linux',
    });
    expect(resolved).toEqual({
      file: 'opencode',
      args: ['serve', '--port', '4199'],
      viaShell: false,
      resolvedPath: 'opencode',
    });
    expect(resolved.windowsVerbatimArguments).toBeUndefined();
  });

  it('macOS 同样原样返回，且不会尝试 where 解析', () => {
    const whereRunner = jest.fn(() => ['/usr/local/bin/opencode']);
    const resolved = resolveCliCommand({
      command: 'opencode',
      args: ['--version'],
      platform: 'darwin',
      whereRunner,
    });
    expect(resolved.file).toBe('opencode');
    expect(resolved.args).toEqual(['--version']);
    expect(whereRunner).not.toHaveBeenCalled();
  });
});

describe('resolveCliCommand · win32 裸名解析', () => {
  beforeEach(() => {
    resetCliResolutionCache();
  });

  it('where 命中 .cmd → 经 cmd.exe /d /s /c 包装（windowsVerbatimArguments）', () => {
    const resolved = resolveCliCommand({
      command: 'opencode',
      args: ['--version'],
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      whereRunner: () => ['C:\\npm\\prefix\\opencode', 'C:\\npm\\prefix\\opencode.cmd'],
    });
    expect(resolved.viaShell).toBe(true);
    expect(resolved.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(resolved.resolvedPath).toBe('C:\\npm\\prefix\\opencode.cmd');
    // 路径无空格 → 文件本身不加引号；/s 配套的外层引号由 cli-command 统一加
    expect(resolved.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\npm\\prefix\\opencode.cmd --version"',
    ]);
    expect(resolved.windowsVerbatimArguments).toBe(true);
  });

  it('where 命中 .exe → 直接 spawn（不走 shell）', () => {
    const resolved = resolveCliCommand({
      command: 'opencode',
      args: ['serve', '--port', '4199'],
      platform: 'win32',
      whereRunner: () => [
        'C:\\Program Files\\@opencode\\cli\\bin\\opencode.exe',
        'C:\\npm\\prefix\\opencode.cmd',
      ],
    });
    expect(resolved.viaShell).toBe(false);
    expect(resolved.file).toBe('C:\\Program Files\\@opencode\\cli\\bin\\opencode.exe');
    expect(resolved.args).toEqual(['serve', '--port', '4199']);
    expect(resolved.windowsVerbatimArguments).toBeUndefined();
  });

  it('where 全部未命中 → 仍经 cmd 包装裸名（cmd 自己按 PATHEXT 找 .cmd）', () => {
    const resolved = resolveCliCommand({
      command: 'opencode',
      args: ['serve'],
      platform: 'win32',
      whereRunner: () => [],
    });
    expect(resolved.viaShell).toBe(true);
    expect(resolved.args[3]).toBe('"opencode serve"');
  });

  it('where 只命中无扩展名 shim → 视为未命中（不 spawn sh 脚本）', () => {
    const resolved = resolveCliCommand({
      command: 'opencode',
      args: ['--version'],
      platform: 'win32',
      whereRunner: () => ['C:\\npm\\prefix\\opencode'],
    });
    expect(resolved.resolvedPath).toBe('opencode');
    expect(resolved.viaShell).toBe(true);
  });

  it('解析结果缓存：同一命令 + 同一 PATH 只调一次 where', () => {
    const whereRunner = jest.fn(() => ['C:\\npm\\prefix\\opencode.cmd']);
    const spec = {
      command: 'opencode',
      args: ['--version'],
      platform: 'win32' as const,
      env: { PATH: 'C:\\Windows\\system32;C:\\npm\\prefix' },
      whereRunner,
    };
    resolveCliCommand(spec);
    resolveCliCommand(spec);
    expect(whereRunner).toHaveBeenCalledTimes(1);
    resetCliResolutionCache();
    resolveCliCommand(spec);
    expect(whereRunner).toHaveBeenCalledTimes(2);
  });

  it('lookup:false 时跳过 where（走 cmd 兜底）', () => {
    const whereRunner = jest.fn(() => ['C:\\npm\\prefix\\opencode.exe']);
    const resolved = resolveCliCommand({
      command: 'opencode',
      args: ['--version'],
      platform: 'win32',
      lookup: false,
      whereRunner,
    });
    expect(whereRunner).not.toHaveBeenCalled();
    expect(resolved.viaShell).toBe(true);
  });
});

describe('resolveCliCommand · win32 显式路径', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetCliResolutionCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-command-spec-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('.exe 绝对路径 → 直接 spawn', () => {
    const exe = path.join(tmpDir, 'opencode.exe');
    fs.writeFileSync(exe, 'stub');
    const resolved = resolveCliCommand({ command: exe, args: ['--version'], platform: 'win32' });
    expect(resolved.viaShell).toBe(false);
    expect(resolved.file).toBe(exe);
  });

  it('.cmd 绝对路径（含空格）→ cmd 包装且路径加引号', () => {
    const dir = path.join(tmpDir, 'dir with space');
    fs.mkdirSync(dir);
    const cmd = path.join(dir, 'opencode.cmd');
    fs.writeFileSync(cmd, '@echo off');
    const resolved = resolveCliCommand({ command: cmd, args: ['serve', '--port', '4199'], platform: 'win32' });
    expect(resolved.viaShell).toBe(true);
    // 路径含空格 → 文件加引号；外面再套一层 /s 需要的外层引号（cmd /s 会剥掉首尾引号）
    expect(resolved.args[3]).toBe(`""${cmd}" serve --port 4199"`);
  });

  it('显式路径不存在 → 可操作报错（而不是运行时 ENOENT）', () => {
    expect(() =>
      resolveCliCommand({ command: path.join(tmpDir, 'missing.exe'), args: [], platform: 'win32' }),
    ).toThrow(/可执行文件不存在/);
  });

  it('显式无扩展名 shim → 明确报错（不允许再变成 ENOENT）', () => {
    const shim = path.join(tmpDir, 'opencode');
    fs.writeFileSync(shim, '#!/bin/sh');
    expect(() => resolveCliCommand({ command: shim, args: [], platform: 'win32' })).toThrow(
      /无扩展名的 shim/,
    );
  });
});

describe('buildWindowsCommandLine', () => {
  it('普通参数不加引号', () => {
    expect(buildWindowsCommandLine('opencode', ['serve', '--port', '4199'])).toBe(
      'opencode serve --port 4199',
    );
  });

  it('含空格的路径/参数加引号', () => {
    expect(buildWindowsCommandLine('C:\\Program Files\\x\\opencode.exe', ['--version'])).toBe(
      '"C:\\Program Files\\x\\opencode.exe" --version',
    );
  });

  it('cmd 元字符参数加引号', () => {
    expect(buildWindowsCommandLine('x', ['a&b', 'c|d', 'e<f'])).toBe('x "a&b" "c|d" "e<f"');
  });

  it('空参数 → ""', () => {
    expect(buildWindowsCommandLine('x', [''])).toBe('x ""');
  });

  it('参数含双引号 → 直接抛错（不做会静默错的转义）', () => {
    expect(() => buildWindowsCommandLine('x', ['a"b'])).toThrow(/含双引号/);
  });
});

describe('spawnCliSync', () => {
  it('POSIX 下能把解析结果交给 spawnSync 并拿到 stdout', () => {
    const result = spawnCliSync('node', ['-e', 'process.stdout.write("ok")'], {
      platform: 'linux',
      timeoutMs: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('命令不存在 → 走 error 字段而不是抛异常', () => {
    const result = spawnCliSync('definitely-not-a-real-command-xyz', ['--version'], {
      platform: 'linux',
      timeoutMs: 5000,
    });
    expect(result.error).toBeDefined();
    expect(result.status).toBeNull();
  });

  it('win32 解析失败（显式路径不存在）→ error 字段，不抛异常', () => {
    const result = spawnCliSync('C:\\does\\not\\exist\\opencode.exe', ['--version'], {
      platform: 'win32',
    });
    expect(result.error).toBeDefined();
    expect(result.status).toBeNull();
  });
});

describe('isWindowsAbsolutePath', () => {
  it.each([
    ['C:\\a\\b', true],
    ['C:/a/b', true],
    ['\\\\server\\share', true],
    ['/usr/bin/opencode', false],
    ['opencode', false],
    ['C:', false],
  ])('%s → %s', (input, expected) => {
    expect(isWindowsAbsolutePath(input)).toBe(expected);
  });
});
