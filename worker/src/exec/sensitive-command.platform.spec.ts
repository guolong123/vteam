/**
 * sensitive-command 的平台 shell 选择单测（Windows 原生支持 · M0）。
 *
 * 真实命令执行由 sensitive-command.spec.ts 覆盖（POSIX）；这里只断言 win32 的
 * shell 选择是否正确——原实现硬编码 `/bin/sh`，Windows 上必然 ENOENT。
 */

import { resolveSensitiveShell } from './sensitive-command';

describe('resolveSensitiveShell', () => {
  it('POSIX → /bin/sh -c（保持既有行为）', () => {
    expect(resolveSensitiveShell('linux', {})).toEqual({ file: '/bin/sh', argsPrefix: ['-c'] });
    expect(resolveSensitiveShell('darwin', {})).toEqual({ file: '/bin/sh', argsPrefix: ['-c'] });
  });

  it('win32 → ComSpec /d /s /c', () => {
    expect(
      resolveSensitiveShell('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }),
    ).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      argsPrefix: ['/d', '/s', '/c'],
    });
  });

  it('win32 且 ComSpec 缺失 → 回退裸 cmd.exe', () => {
    expect(resolveSensitiveShell('win32', {})).toEqual({ file: 'cmd.exe', argsPrefix: ['/d', '/s', '/c'] });
  });
});
