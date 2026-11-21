/**
 * opencode 版本解析 + 启动期版本闸门 单测（T1 / 计划 D2）。
 *
 * 覆盖：v2 形（`opencode v2.0.28`）、v1 形（`opencode 1.19.0`）、裸 semver、垃圾输入、
 * 闸门行为（major<2 → 抛可操作错误；major>=2 → 放行；认不出 → 只告警不判死）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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

  it('major < 2 → 错误信息**同时**给出物理机的补救手段（npm i -g @opencode/cli@…）', () => {
    // worker 也跑在物理机（systemd 裸装）——那里没有镜像可重建，只说"重建镜像"会把
    // 运维指到错误的 remediation。
    const info = parseOpencodeVersion('opencode 1.19.0');
    expect(() => assertOpencodeVersionSupported(info)).toThrow(/容器部署/);
    expect(() => assertOpencodeVersionSupported(info)).toThrow(/物理机部署/);
    expect(() => assertOpencodeVersionSupported(info)).toThrow(
      new RegExp(`npm i -g ${REQUIRED_OPENCODE_CLI_SPEC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    // v1 的 npm 包冻结在 1.19.3 ⇒ 必须点明"换包名"这条唯一出路
    expect(() => assertOpencodeVersionSupported(info)).toThrow(/opencode-ai/);
    expect(() => assertOpencodeVersionSupported(info)).toThrow(/@opencode\/cli/);
    // 且必须点明"为什么 v1 一定过不了"——闸门是主版本 ≥ 2
    expect(() => assertOpencodeVersionSupported(info)).toThrow(/主版本 ≥ 2/);
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

  it('无法解析 → 告警文案同样给出两种部署形态的确认/补救手段', () => {
    const warn = jest.fn();
    assertOpencodeVersionSupported(parseOpencodeVersion('garbage'), { warn });
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('容器部署');
    expect(message).toContain('物理机部署');
    expect(message).toContain(REQUIRED_OPENCODE_CLI_SPEC);
    // 不再假设"镜像内"——物理机上没有镜像
    expect(message).not.toContain('镜像内 opencode');
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

/**
 * 防漂移：`REQUIRED_OPENCODE_CLI_SPEC`（代码常量）与 `worker/Dockerfile` 的
 * `ARG OPENCODE_CLI_SPEC` 默认值**必须一致**。
 *
 * 为什么这条必须有：该常量只出现在**启动期版本闸门的错误文案**里（告诉运维"该装哪一版"），
 * 而真正决定镜像里装哪一版的是 Dockerfile 的 ARG。两者不一致时：
 * - 运维照报错提示 `npm i -g <常量>` 装到的版本，与镜像实际不一致；
 * - 或镜像已升级、报错文案还指着老版本 ⇒ 排障方向被带偏。
 * 这类漂移**没有任何运行期症状**，只能靠直接读文件比对。
 */
describe('锁版规格防漂移（代码常量 ↔ Dockerfile ARG）', () => {
  it('REQUIRED_OPENCODE_CLI_SPEC 与 worker/Dockerfile 的 ARG 默认值一致', () => {
    // spec 跑在 worker/src/runtime 下 ⇒ 上溯三级到 worker/，再取 Dockerfile
    const dockerfile = path.resolve(__dirname, '..', '..', 'Dockerfile');
    expect(fs.existsSync(dockerfile)).toBe(true);
    const content = fs.readFileSync(dockerfile, 'utf8');

    const match = /^ARG\s+OPENCODE_CLI_SPEC=(\S+)\s*$/m.exec(content);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(REQUIRED_OPENCODE_CLI_SPEC);
  });

  /**
   * 裸机安装脚本（`web/public/install-worker.sh`）是**镜像路径之外的第二条落地路径**。
   * 它与镜像必须是同一版：控制面按 opencode 版本串**精确过滤** worker，
   * 两边分叉会让调度与排障都出错（"明明装了却派单不到"最典型的成因）。
   */
  it('install-worker.sh 的缺省钉版与 Dockerfile 同版', () => {
    const script = path.resolve(__dirname, '..', '..', '..', 'web', 'public', 'install-worker.sh');
    if (!fs.existsSync(script)) {
      // 只跑 worker 单测的独立检出可能没有 web/ ⇒ 明确跳过而不是假绿
      expect(true).toBe(true);
      return;
    }
    const content = fs.readFileSync(script, 'utf8');
    const match = /^OPENCODE_CLI_DEFAULT_SPEC="(@opencode\/cli@[^"]+)"/m.exec(content);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(REQUIRED_OPENCODE_CLI_SPEC);
  });

  /**
   * ⚠️ **Windows 安装器是一份独立实现**（PowerShell），它有**自己的一份**钉版：
   * `$Script:DefaultOpencodeSpec` 与 `-Opencode` 参数的缺省值。
   *
   * 现实教训：Linux 的 `install-worker.sh` 改了、`.ps1` 忘了改 —— 两平台就落在不同
   * opencode 版本上，而控制面按版本串**精确过滤** worker ⇒ Windows 节点会静默
   * "装了但派不到任务"。本仓库此前**只**校验了 .sh，.ps1 完全没有守卫。
   */
  it('install-worker.ps1（Windows）的缺省钉版与 Dockerfile 同版', () => {
    const script = path.resolve(__dirname, '..', '..', '..', 'web', 'public', 'install-worker.ps1');
    if (!fs.existsSync(script)) {
      expect(true).toBe(true);
      return;
    }
    const content = fs.readFileSync(script, 'utf8');

    // ① 常量（脚本内部解析用）
    const constMatch = /^\$Script:DefaultOpencodeSpec\s*=\s*'(@opencode\/cli@[^']+)'/m.exec(content);
    expect(constMatch).not.toBeNull();
    expect(constMatch![1]).toBe(REQUIRED_OPENCODE_CLI_SPEC);

    // ② 参数缺省值（用户不传 -Opencode 时生效）
    const paramMatch = /\[string\]\$Opencode\s*=\s*'(@opencode\/cli@[^']+)'/m.exec(content);
    expect(paramMatch).not.toBeNull();
    expect(paramMatch![1]).toBe(REQUIRED_OPENCODE_CLI_SPEC);

    // ③ 脚本里不得残留其它版本的 @opencode/cli@x.y.z 引用（注释/报错文案也算）
    const version = REQUIRED_OPENCODE_CLI_SPEC.split('@').pop()!;
    const refs = [...content.matchAll(/@opencode\/cli@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toBe(version);
    }
  });

  it('Dockerfile 里不再残留旧的锁版引用（注释与 --build-arg 示例同步）', () => {
    const dockerfile = path.resolve(__dirname, '..', '..', 'Dockerfile');
    const content = fs.readFileSync(dockerfile, 'utf8');
    const version = REQUIRED_OPENCODE_CLI_SPEC.split('@').pop()!;
    // 只要文件里出现 `@opencode/cli@<semver>`，就必须全是当前锁的版本
    const refs = [...content.matchAll(/@opencode\/cli@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toBe(version);
    }
  });
});
