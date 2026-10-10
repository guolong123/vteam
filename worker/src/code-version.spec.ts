import { tmpdir } from 'os';
import * as path from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';

import {
  CODE_VERSION_ENV_KEY,
  DEV_CODE_VERSION,
  VERSION_FILE_BASENAME,
  defaultVersionFileReader,
  parseStampedVersion,
  resolveCodeVersion,
  type VersionFileReader,
} from './code-version';

/** pack-worker.sh 生成的版本戳文件文本（ESM 写法）。 */
const STAMPED_FILE = [
  '// 本文件由 scripts/pack-worker.sh 生成，请勿手工编辑',
  "export const WORKER_CODE_VERSION = 'a1b2c3d';",
  '',
].join('\n');

/** 内存读取器：map 命中返回文本，未命中模拟文件缺失。 */
function readerOf(files: Record<string, string>): VersionFileReader {
  return (filePath: string) => files[path.basename(filePath)];
}

describe('resolveCodeVersion 优先级：env > dist/version.js > dev', () => {
  it('env 注入优先于文件戳（容器/集群路径：镜像内无版本戳文件，或需覆盖）', () => {
    const resolved = resolveCodeVersion(
      { [CODE_VERSION_ENV_KEY]: 'env-sha-9999' },
      readerOf({ [VERSION_FILE_BASENAME]: STAMPED_FILE }),
    );
    expect(resolved).toBe('env-sha-9999');
  });

  it('env 未设置时读 dist/version.js（发布包路径）', () => {
    const resolved = resolveCodeVersion({}, readerOf({ [VERSION_FILE_BASENAME]: STAMPED_FILE }));
    expect(resolved).toBe('a1b2c3d');
  });

  it('env 与文件戳都缺失时回落 dev', () => {
    const resolved = resolveCodeVersion({}, readerOf({}));
    expect(resolved).toBe(DEV_CODE_VERSION);
  });

  it('env 为空串/纯空白时视为未设置，继续读文件戳（编排层误配不遮蔽文件戳）', () => {
    expect(resolveCodeVersion({ [CODE_VERSION_ENV_KEY]: '' }, readerOf({ [VERSION_FILE_BASENAME]: STAMPED_FILE }))).toBe(
      'a1b2c3d',
    );
    expect(resolveCodeVersion({ [CODE_VERSION_ENV_KEY]: '   ' }, readerOf({ [VERSION_FILE_BASENAME]: STAMPED_FILE }))).toBe(
      'a1b2c3d',
    );
    // env 空白 + 文件也缺失 → dev
    expect(resolveCodeVersion({ [CODE_VERSION_ENV_KEY]: '  ' }, readerOf({}))).toBe(DEV_CODE_VERSION);
  });

  it('文件戳存在但无法解析出版本（内容损坏/格式变更）时回落 dev', () => {
    expect(resolveCodeVersion({}, readerOf({ [VERSION_FILE_BASENAME]: '' }))).toBe(DEV_CODE_VERSION);
    expect(resolveCodeVersion({}, readerOf({ [VERSION_FILE_BASENAME]: '// 已被清空\n' }))).toBe(DEV_CODE_VERSION);
    expect(resolveCodeVersion({}, readerOf({ [VERSION_FILE_BASENAME]: "export const OTHER = 'x';\n" }))).toBe(
      DEV_CODE_VERSION,
    );
    expect(resolveCodeVersion({}, readerOf({ [VERSION_FILE_BASENAME]: "export const WORKER_CODE_VERSION = '';\n" }))).toBe(
      DEV_CODE_VERSION,
    );
  });

  it('默认读 __dirname/version.js（非 git 打包回退 manual-<date> 也能解析）', () => {
    const resolved = resolveCodeVersion({}, readerOf({ [VERSION_FILE_BASENAME]: "export const WORKER_CODE_VERSION = 'manual-20260420';\n" }));
    expect(resolved).toBe('manual-20260420');
  });
});

describe('parseStampedVersion', () => {
  it('解析单引号（pack-worker.sh 实际生成形态）', () => {
    expect(parseStampedVersion(STAMPED_FILE)).toBe('a1b2c3d');
  });

  it('解析双引号与 CommonJS exports 写法（容器内手改/历史包兼容）', () => {
    expect(parseStampedVersion('export const WORKER_CODE_VERSION = "deadbee";')).toBe('deadbee');
    expect(parseStampedVersion('exports.WORKER_CODE_VERSION = "cafebabe";')).toBe('cafebabe');
    expect(parseStampedVersion('const WORKER_CODE_VERSION = "1234567"')).toBe('1234567');
  });

  it('不误伤同名子串以外的赋值，且解析不出时返回 undefined', () => {
    expect(parseStampedVersion('export const SOME_OTHER_WORKER_CODE_VERSION = "x";')).toBeUndefined();
    expect(parseStampedVersion('const WORKER_CODE_VERSION_X = "x";')).toBeUndefined();
    expect(parseStampedVersion('')).toBeUndefined();
  });
});

describe('defaultVersionFileReader（真实文件系统分支）', () => {
  let tmpRoot: string;
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  beforeAll(() => {
    tmpRoot = path.join(tmpdir(), `vteam-version-spec-${process.pid}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('文件存在时返回文本内容', () => {
    const filePath = path.join(tmpRoot, VERSION_FILE_BASENAME);
    writeFileSync(filePath, STAMPED_FILE, 'utf8');
    expect(defaultVersionFileReader(filePath)).toBe(STAMPED_FILE);
  });

  it('文件缺失时返回 undefined 并 warn（不抛错，worker 仍能启动）', () => {
    const missing = path.join(tmpRoot, 'no-such-version.js');
    expect(defaultVersionFileReader(missing)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    const lastWarn = String(warnSpy.mock.calls[warnSpy.mock.calls.length - 1]?.[0] ?? '');
    expect(lastWarn).toContain(missing);
    expect(lastWarn).toContain(DEV_CODE_VERSION);
  });

  it('缺失文件经 resolveCodeVersion 端到端回落 dev', () => {
    const missing = path.join(tmpRoot, 'absent.js');
    expect(resolveCodeVersion({}, () => defaultVersionFileReader(missing))).toBe(DEV_CODE_VERSION);
  });

  it('默认 reader 指向 __dirname/version.js（dev 直跑 tsx 时该文件不存在 → dev）', () => {
    // ts-jest 下 __dirname = worker/src，源码目录无 version.js（仅 dist 才有）
    expect(resolveCodeVersion({}, defaultVersionFileReader)).toBe(DEV_CODE_VERSION);
  });
});