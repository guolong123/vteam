import {
  computeUpdateAvailable,
  isCodeVersionAligned,
  isComparableCodeVersion,
  isNonReleasedCodeVersion,
  isWorkerUpdateState,
  normalizeReportedUpdateState,
  WORKER_UPDATE_STATE_MAX_LENGTH,
  WORKER_UPDATE_STATES,
} from './worker-update-state';

/**
 * worker-self-update Todo 3 的两把尺子与状态机取值（与 Todo 2 的 worker-code-version.spec 同构）。
 *
 * 钉死的三件事：
 *  1. `updateState` 取值集合**逐字固定**——它同时出现在 DTO @IsIn、DB 列值、
 *     Todo 4 worker 执行器与 Todo 5 web UI。加/改一个取值就是改协议，须两端同步。
 *  2. 缺席/脏取值 → undefined（= 不写列），旧 worker 不炸。
 *  3. 版本比对把 `dev`（未知占位）排除在外：`dev === dev` 绝不算「已对齐」，
 *     否则本地开发栈会凭空显示「已是最新」，也会让 pending 指令被假收敛清掉。
 */
describe('WORKER_UPDATE_STATES（自更新状态机取值集合）', () => {
  it('恰好 5 个取值，逐字对齐 plan 的状态表', () => {
    expect(Object.values(WORKER_UPDATE_STATES).sort()).toEqual([
      'downloading',
      'pending',
      'ready-manual',
      'restarting',
      'rolledback',
    ]);
  });

  it('全部取值都落在 workers.update_state 列宽内（不触发 MySQL 1406）', () => {
    for (const state of Object.values(WORKER_UPDATE_STATES)) {
      expect(state.length).toBeLessThanOrEqual(WORKER_UPDATE_STATE_MAX_LENGTH);
    }
  });
});

describe('normalizeReportedUpdateState（上报值归一化）', () => {
  it('枚举内取值 → trim 后原样返回', () => {
    expect(normalizeReportedUpdateState('pending')).toBe('pending');
    expect(normalizeReportedUpdateState('  ready-manual ')).toBe(
      'ready-manual',
    );
    expect(normalizeReportedUpdateState('rolledback')).toBe('rolledback');
  });

  it('undefined / null / 空串 / 纯空白 → undefined（= 不写列）', () => {
    expect(normalizeReportedUpdateState(undefined)).toBeUndefined();
    expect(normalizeReportedUpdateState(null)).toBeUndefined();
    expect(normalizeReportedUpdateState('')).toBeUndefined();
    expect(normalizeReportedUpdateState('   \t\n ')).toBeUndefined();
  });

  it('不在枚举内的取值 → undefined（不猜、不落脏值）', () => {
    expect(normalizeReportedUpdateState('weird')).toBeUndefined();
    expect(normalizeReportedUpdateState('READY-MANUAL')).toBeUndefined();
    // 超长脏值同样在枚举校验处被拒（列宽不会成为失败点）
    expect(normalizeReportedUpdateState('x'.repeat(500))).toBeUndefined();
  });

  it('isWorkerUpdateState 对非字符串输入返回 false', () => {
    expect(isWorkerUpdateState(undefined)).toBe(false);
    expect(isWorkerUpdateState(42)).toBe(false);
    expect(isWorkerUpdateState('pending')).toBe(true);
  });
});

describe('版本比对（占位串不是事实）', () => {
  it('isComparableCodeVersion：非空且非占位串', () => {
    expect(isComparableCodeVersion('deadbee')).toBe(true);
    expect(isComparableCodeVersion('v1.6.26')).toBe(true);
    /**
     * ⚠️ 这条**曾经断言 true**，正是 2026-11-21 事故的根源：
     * Windows 安装器写 `manual-<日期>`，server 写 `local-compose`，
     * 两个都"可比对"却永不相等 ⇒ 升级成功后永久显示「待更新」。
     * 现已归入占位串（见 NON_RELEASED_CODE_VERSION_PATTERNS）。
     */
    expect(isComparableCodeVersion('manual-20261010')).toBe(false);
    expect(isComparableCodeVersion('local-compose')).toBe(false);
    expect(isComparableCodeVersion('dev')).toBe(false);
    expect(isComparableCodeVersion('')).toBe(false);
    expect(isComparableCodeVersion('  ')).toBe(false);
    expect(isComparableCodeVersion(undefined)).toBe(false);
    expect(isComparableCodeVersion(null)).toBe(false);
  });

  it('isCodeVersionAligned：两侧可比对且相等（trim 后）', () => {
    expect(isCodeVersionAligned('deadbee', 'deadbee')).toBe(true);
    expect(isCodeVersionAligned(' deadbee ', 'deadbee')).toBe(true);
    expect(isCodeVersionAligned('deadbee', 'cafe123')).toBe(false);
    expect(isCodeVersionAligned('deadbee', undefined)).toBe(false);
  });

  it('dev 永不判为已对齐（本地栈不产生假收敛）', () => {
    expect(isCodeVersionAligned('dev', 'dev')).toBe(false);
    expect(isCodeVersionAligned('dev', 'deadbee')).toBe(false);
    expect(isCodeVersionAligned('deadbee', 'dev')).toBe(false);
  });

  it('两把尺子同源：updateAvailable / aligned 真值表（含 dev 与缺席各态）', () => {
    const cases: Array<
      [string | null | undefined, string | null | undefined, boolean, boolean]
    > = [
      // [codeVersion, expectedVersion, updateAvailable, aligned]
      ['deadbee', 'cafe123', true, false],
      ['deadbee', 'deadbee', false, true],
      [' deadbee ', 'deadbee', false, true],
      ['deadbee', '   ', false, false],
      ['deadbee', undefined, false, false],
      [undefined, 'cafe123', false, false],
      ['dev', 'cafe123', false, false],
      ['deadbee', 'dev', false, false],
      ['dev', 'dev', false, false],
      [null, null, false, false],
      ['', '', false, false],
    ];
    for (const [code, expected, available, aligned] of cases) {
      expect(computeUpdateAvailable(code, expected)).toBe(available);
      expect(isCodeVersionAligned(code, expected)).toBe(aligned);
    }
  });
});

/**
 * 占位/非发布版本不参与比对（2026-11-21 线上实测：Windows 升级后永久显示「待更新」）。
 *
 * 事故形态：Windows 安装器在 `.env` 里写 `WORKER_CODE_VERSION=manual-<日期>`，
 * 而 compose 的 server `CODE_VERSION=local-compose` ⇒ 两者**永不相等**
 * ⇒ `updateAvailable` 恒 true ⇒ 用户升完 2.3.2 后卡片仍挂「待更新」。
 *
 * 语义要求（两条都必须是 false，不能"猜"）：
 * - 占位串对占位串：既不报可更新（不撒谎），也不报已对齐（同样不撒谎）；
 * - 占位串对真实版本：仍然不报（没有可比基准）。
 */
describe('占位版本串不参与版本比对', () => {
  it('manual-* / local-compose / dev 两两组合 → 都不可比对', () => {
    const placeholders = [
      'manual-20261121',
      'manual-20261114',
      'local-compose',
      'dev',
      'container-unstamped',
    ];
    for (const code of placeholders) {
      for (const expected of placeholders) {
        expect(isComparableCodeVersion(code)).toBe(false);
        expect(isComparableCodeVersion(expected)).toBe(false);
        // 关键：**没有** updateAvailable（否则就是本次事故）
        expect(computeUpdateAvailable(code, expected)).toBe(false);
        expect(isCodeVersionAligned(code, expected)).toBe(false);
      }
    }
  });

  it('占位串 vs 真实发布时间戳 → 不报可更新（没有可比基准）', () => {
    expect(computeUpdateAvailable('manual-20261121', 'v1.6.26')).toBe(false);
    expect(computeUpdateAvailable('local-compose', 'v1.6.26')).toBe(false);
  });

  it('真实发布版本之间仍然正常比对（修复不能把功能一起关掉）', () => {
    expect(computeUpdateAvailable('v1.6.25', 'v1.6.26')).toBe(true);
    expect(computeUpdateAvailable('v1.6.26', 'v1.6.26')).toBe(false);
    expect(isCodeVersionAligned('v1.6.26', 'v1.6.26')).toBe(true);
    expect(isCodeVersionAligned('v1.6.25', 'v1.6.26')).toBe(false);
  });

  it('isNonReleasedCodeVersion 判定与匹配不区分大小写', () => {
    expect(isNonReleasedCodeVersion('DEV')).toBe(true);
    expect(isNonReleasedCodeVersion('Local-Compose')).toBe(true);
    expect(isNonReleasedCodeVersion('Manual-20261121')).toBe(true);
    expect(isNonReleasedCodeVersion('v1.6.26')).toBe(false);
    expect(isNonReleasedCodeVersion('2f3a91c')).toBe(false);
  });
});
