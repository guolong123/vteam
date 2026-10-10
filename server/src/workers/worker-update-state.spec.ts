import {
  computeUpdateAvailable,
  isCodeVersionAligned,
  isComparableCodeVersion,
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

describe('版本比对（dev 是未知占位，不是事实）', () => {
  it('isComparableCodeVersion：非空且非 dev', () => {
    expect(isComparableCodeVersion('deadbee')).toBe(true);
    expect(isComparableCodeVersion('manual-20261010')).toBe(true);
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
