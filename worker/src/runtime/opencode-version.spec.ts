/**
 * opencode 版本解析 + 启动期版本闸门 单测（T1 / 计划 D2）。
 *
 * 覆盖：v2 形（`opencode v2.0.28`）、v1 形（`opencode 1.19.0`）、裸 semver、垃圾输入、
 * 闸门行为（major<2 → 抛可操作错误；major>=2 → 放行；认不出 → 只告警不判死）。
 */

import {
  assertOpencodeVersionSupported,
  formatOpencodeVersion,
  MIN_OPENCODE_MAJOR,
  normalizeOpencodeVersion,
  parseOpencodeVersion,
  REQUIRED_OPENCODE_CLI_SPEC,
} from './opencode-version';

describe('parseOpencodeVersion（T1：v1/v2 两种版本串形态）', () => {
  it('v2 形 `opencode v2.0.28` → major=2 minor=0 patch=28', () => {
    const info = parseOpencodeVersion('opencode v2.0.28');
    expect(info.major).toBe(2);
    expect(info.minor).toBe(0);
    expect(info.patch).toBe(28);
    expect(info.raw).toBe('opencode v2.0.28');
  });

  it('v1 形 `opencode 1.19.0` → major=1 minor=19 patch=0', () => {
    const info = parseOpencodeVersion('opencode 1.19.0');
    expect(info.major).toBe(1);
    expect(info.minor).toBe(19);
    expect(info.patch).toBe(0);
  });

  it('裸 semver `2.0.28` → major=2 minor=0 patch=28（worker 内部上报值形态）', () => {
    const info = parseOpencodeVersion('2.0.28');
    expect(info.major).toBe(2);
    expect(info.minor).toBe(0);
    expect(info.patch).toBe(28);
  });

  it('垃圾输入 / 空串 → 三个数字全为 null 且**不抛错**', () => {
    for (const raw of ['garbage', '', '   ', 'opencode']) {
      const info = parseOpencodeVersion(raw);
      expect(info.major).toBeNull();
      expect(info.minor).toBeNull();
      expect(info.patch).toBeNull();
    }
    expect(() => parseOpencodeVersion('garbage')).not.toThrow();
  });

  it('后缀噪声仍可解析（`1.19.0-fake` → 1.19.0），取首个匹配', () => {
    const info = parseOpencodeVersion('1.19.0-fake');
    expect(info.major).toBe(1);
    expect(info.minor).toBe(19);
    expect(info.patch).toBe(0);
  });
});

describe('formatOpencodeVersion / normalizeOpencodeVersion（T1：上报值规范化）', () => {
  it('formatOpencodeVersion：可解析 → 规范化 semver；不可解析 → unknown', () => {
    expect(formatOpencodeVersion(parseOpencodeVersion('opencode v2.0.28'))).toBe('2.0.28');
    expect(formatOpencodeVersion(parseOpencodeVersion('opencode 1.19.0'))).toBe('1.19.0');
    expect(formatOpencodeVersion(parseOpencodeVersion('garbage'))).toBe('unknown');
  });

  it('normalizeOpencodeVersion：v2 全文 → semver 串；已是 semver → 不变', () => {
    expect(normalizeOpencodeVersion('opencode v2.0.28')).toBe('2.0.28');
    expect(normalizeOpencodeVersion('2.0.28')).toBe('2.0.28');
    expect(normalizeOpencodeVersion('1.18.15')).toBe('1.18.15');
  });

  it('normalizeOpencodeVersion：无法解析 → 原样透传（保留 unknown 等既有语义）', () => {
    expect(normalizeOpencodeVersion('unknown')).toBe('unknown');
    expect(normalizeOpencodeVersion('fallback')).toBe('fallback');
    expect(normalizeOpencodeVersion('')).toBe('');
  });
});

describe('assertOpencodeVersionSupported（T1：启动期版本闸门）', () => {
  it('major < 2 → 抛错，错误信息含可操作指引（重建镜像 + 锁版规格）', () => {
    const info = parseOpencodeVersion('opencode 1.19.0');
    expect(() => assertOpencodeVersionSupported(info)).toThrow(/需要 opencode >= 2/);
    expect(() => assertOpencodeVersionSupported(info)).toThrow(/当前 opencode 1\.19\.0/);
    expect(() => assertOpencodeVersionSupported(info)).toThrow(
      new RegExp(`OPENCODE_CLI_SPEC=${REQUIRED_OPENCODE_CLI_SPEC}`),
    );
    expect(() => assertOpencodeVersionSupported(info)).toThrow(/--build-arg/);
  });

  it('major >= 2 → 放行（不抛错、不告警）', () => {
    const warn = jest.fn();
    expect(() =>
      assertOpencodeVersionSupported(parseOpencodeVersion('opencode v2.0.28'), { warn }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(MIN_OPENCODE_MAJOR).toBe(2);
  });

  it('无法解析（garbage / unknown）→ **不判死**，只告警后继续', () => {
    const warn = jest.fn();
    expect(() => assertOpencodeVersionSupported(parseOpencodeVersion('garbage'), { warn })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('无法判定 opencode 版本'));
  });
});

describe('assertOpencodeVersionSupported（T18：单模闸门，不再有 v1 模式）', () => {
  it('T18：v1 模式参数已移除——闸门无条件要求主版本 ≥ 2', () => {
    const info = parseOpencodeVersion('opencode 1.19.0');
    expect(() =>
      assertOpencodeVersionSupported(info, { logger: { warn: jest.fn() } }),
    ).toThrow(/需要 opencode >= 2/);
  });

  it('major = 2 → 放行', () => {
    const warn = jest.fn();
    expect(() =>
      assertOpencodeVersionSupported(parseOpencodeVersion('opencode v2.0.28'), {
        logger: { warn },
      }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('认不出版本 → **只告警不判死**（D2 既有对策不因单模化而丢失）', () => {
    const warn = jest.fn();
    expect(() =>
      assertOpencodeVersionSupported(parseOpencodeVersion('garbage'), {
        logger: { warn },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('无法判定 opencode 版本'));
  });

  it('缺省参数 = 单模（不传 options 时行为与既有调用点一致）', () => {
    expect(() =>
      assertOpencodeVersionSupported(parseOpencodeVersion('opencode 1.19.0')),
    ).toThrow(/需要 opencode >= 2/);
    expect(() =>
      assertOpencodeVersionSupported(parseOpencodeVersion('opencode v2.0.28')),
    ).not.toThrow();
  });
});
