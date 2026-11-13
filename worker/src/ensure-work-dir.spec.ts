/**
 * WORK_DIR 启动期预检单测（Windows 原生支持 · M0）。
 *
 * 目的：Windows 上缺省路径/服务账户配错时，报错必须指向 WORK_DIR（而不是注入器内部
 * 路径的 ENOENT/EACCES），否则会和「opencode 没装」的报错串味。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ensureWorkDirReady } from './index';

describe('ensureWorkDirReady', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-preflight-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('目录不存在 → 自动创建、可写，且不留下探针文件', () => {
    const workDir = path.join(tmpDir, 'nested', 'vteam-worker');
    expect(() => ensureWorkDirReady(workDir)).not.toThrow();
    expect(fs.statSync(workDir).isDirectory()).toBe(true);
    expect(fs.readdirSync(workDir)).toEqual([]);
  });

  it('目录不可写 → 抛出带 WORK_DIR 的可操作错误', () => {
    const workDir = path.join(tmpDir, 'readonly');
    fs.mkdirSync(workDir);
    fs.chmodSync(workDir, 0o500);
    try {
      expect(() => ensureWorkDirReady(workDir)).toThrow(/WORK_DIR 不可写/);
    } finally {
      fs.chmodSync(workDir, 0o700);
    }
  });

  it('目标是已存在的文件 → 抛出带 WORK_DIR 的错误', () => {
    const filePath = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    expect(() => ensureWorkDirReady(filePath)).toThrow(/WORK_DIR 不可用/);
  });
});
