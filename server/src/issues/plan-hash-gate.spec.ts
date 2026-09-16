import {
  buildStalePlanHashHint,
  isStalePlanHash,
  normalizePlanHash,
  selectFrozenPlanHash,
} from './plan-hash-gate';
import { createLedger, embedLedger } from './review-round-ledger';

/**
 * plan-finalize-actions todo 3：执行认哈希门禁纯函数。
 *
 * - 门禁比对 planVersion.hash（triplet sha1-8，todo 1 裁决，禁止新算法）；
 * - 不匹配 → plan-gated + 精确 hint（同时命名期望/实际短哈希）；
 * - 任一侧缺失 → 门禁未武装（fail-open，保持原放行面，只松不紧）。
 */
describe('plan-hash-gate 纯函数（todo 3）', () => {
  describe('normalizePlanHash', () => {
    it('8 位 hex 原样保留', () => {
      expect(normalizePlanHash('a1b2c3d4')).toBe('a1b2c3d4');
    });

    it('首尾空白裁剪', () => {
      expect(normalizePlanHash('  a1b2c3d4\n')).toBe('a1b2c3d4');
    });

    it.each([[undefined], [null], [''], ['   '], [123]])(
      '空/非字符串输入 %p → null（按未携带处理，不收紧）',
      (input: unknown) => {
        expect(normalizePlanHash(input)).toBeNull();
      },
    );
  });

  describe('isStalePlanHash', () => {
    it('双哈希齐备且不一致 → true（过期拦截）', () => {
      expect(isStalePlanHash('a1b2c3d4', 'deadbeef')).toBe(true);
    });

    it('双哈希一致 → false（匹配放行）', () => {
      expect(isStalePlanHash('a1b2c3d4', 'a1b2c3d4')).toBe(false);
    });

    it.each([
      [null, 'deadbeef'],
      ['a1b2c3d4', null],
      [null, null],
      ['', 'deadbeef'],
      ['a1b2c3d4', ''],
    ])('任一侧缺失（期望=%p，实际=%p）→ false（fail-open，不收紧）', (expected, actual) => {
      expect(isStalePlanHash(expected, actual)).toBe(false);
    });
  });

  describe('buildStalePlanHashHint', () => {
    it('hint 同时命名期望/实际短哈希（逐字锁定，改一字即红）', () => {
      expect(buildStalePlanHashHint('a1b2c3d4', 'deadbeef')).toBe(
        '计划哈希已过期：期望 #a1b2c3d4（冻结正式版），实际 #deadbeef（请求携带）；请基于冻结版重新确认后携带新哈希重派',
      );
    });
  });

  describe('selectFrozenPlanHash', () => {
    const ledgerOf = (round: number, hash: string) =>
      embedLedger(
        '派发评审',
        createLedger({
          round,
          planVersion: { version: `v0.${round}`, lines: 10, hash },
          expected: ['tmm_a'],
          status: 'complete',
          timeoutAt: '2026-09-16T00:40:00Z',
        }),
      );

    it('多轮次账本取最大 round 者 planVersion.hash', () => {
      expect(
        selectFrozenPlanHash([ledgerOf(1, 'aaaaaaaa'), ledgerOf(3, 'cccccccc'), ledgerOf(2, 'bbbbbbbb')]),
      ).toBe('cccccccc');
    });

    it('无账本/空描述 → null（门禁未武装）', () => {
      expect(selectFrozenPlanHash([])).toBeNull();
      expect(selectFrozenPlanHash([null, undefined, '纯文本无机器段'])).toBeNull();
    });

    it('机器段损坏 → 跳过不抛（fail-open）', () => {
      expect(
        selectFrozenPlanHash([
          '<!-- REVIEW-ROUND-JSON -->\n```json\n{broken\n```',
          ledgerOf(1, 'aaaaaaaa'),
        ]),
      ).toBe('aaaaaaaa');
    });

    it('最新轮次 hash 为空（pending-hash 态）→ null（不等旧哈希，不收紧）', () => {
      expect(selectFrozenPlanHash([ledgerOf(2, '')])).toBeNull();
    });
  });
});
