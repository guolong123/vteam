import {
  normalizeReportedCodeVersion,
  resolveExpectedCodeVersion,
  WORKER_CODE_VERSION_MAX_LENGTH,
} from './worker-code-version';

/**
 * worker-self-update Todo 2：代码版本通道的归一化契约。
 *
 * 两端都是「可能缺席」的自由文本，故这里钉死的是**诚实缺省**：
 * 上报值缺席/空 → undefined（= 不写列，保留已有事实）；
 * env 期望值缺席/空 → undefined（= 心跳响应整字段省略，不判定不一致）。
 */
describe('normalizeReportedCodeVersion（worker 上报值归一化）', () => {
  it('非空值原样返回', () => {
    expect(normalizeReportedCodeVersion('abc1234')).toBe('abc1234');
    expect(normalizeReportedCodeVersion('manual-20261010')).toBe(
      'manual-20261010',
    );
    expect(normalizeReportedCodeVersion('dev')).toBe('dev');
  });

  it('undefined / null / 空串 / 纯空白 → undefined（= 不写该列）', () => {
    expect(normalizeReportedCodeVersion(undefined)).toBeUndefined();
    expect(normalizeReportedCodeVersion(null)).toBeUndefined();
    expect(normalizeReportedCodeVersion('')).toBeUndefined();
    expect(normalizeReportedCodeVersion('   \t\n ')).toBeUndefined();
  });

  it('两端空白裁剪（值本身不带换行/空格进库）', () => {
    expect(normalizeReportedCodeVersion('  abc1234  ')).toBe('abc1234');
  });

  it('超长值截断到列宽 191（MySQL 严格模式 1406 会让注册/心跳整体失败）', () => {
    const long = 'a'.repeat(500);
    const normalized = normalizeReportedCodeVersion(long);
    expect(normalized).toHaveLength(WORKER_CODE_VERSION_MAX_LENGTH);
    expect(normalized).toBe('a'.repeat(WORKER_CODE_VERSION_MAX_LENGTH));
  });

  it('恰好 191 不截断', () => {
    const exact = 'b'.repeat(WORKER_CODE_VERSION_MAX_LENGTH);
    expect(normalizeReportedCodeVersion(exact)).toBe(exact);
  });
});

describe('resolveExpectedCodeVersion（server env CODE_VERSION）', () => {
  it('env 有值 → 原样返回（deploy-k8s.sh 注入的 git 短 SHA）', () => {
    expect(resolveExpectedCodeVersion({ CODE_VERSION: 'deadbee' })).toBe(
      'deadbee',
    );
  });

  it('env 缺省 → undefined（心跳响应省略 expectedVersion）', () => {
    expect(resolveExpectedCodeVersion({})).toBeUndefined();
  });

  it('env 空串 / 纯空白 → undefined（等价缺省，不下发「期望版本 = 空」）', () => {
    expect(resolveExpectedCodeVersion({ CODE_VERSION: '' })).toBeUndefined();
    expect(resolveExpectedCodeVersion({ CODE_VERSION: '  ' })).toBeUndefined();
  });

  it('每次调用实时读传入 env（非模块加载时快照）', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveExpectedCodeVersion(env)).toBeUndefined();
    env.CODE_VERSION = 'cafe123';
    expect(resolveExpectedCodeVersion(env)).toBe('cafe123');
  });

  it('env 有值时超长同样截断（防运维粘了整条 commit log 进 chart values）', () => {
    const env = { CODE_VERSION: 'x'.repeat(300) };
    expect(resolveExpectedCodeVersion(env)).toHaveLength(
      WORKER_CODE_VERSION_MAX_LENGTH,
    );
  });
});