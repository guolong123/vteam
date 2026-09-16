/**
 * no-tighten 机器检查（plan-finalize-actions todo 5，loosen-only 审计）。
 *
 * 红线规则：
 * 1. 清单完整性：GATE_SPEC_FILES 枚举的 16 个门禁单测文件必须全部存在，
 *    删/改名任一文件即红（防审计范围被悄悄缩小）。
 * 2. 放行侧锁定：任一 allow→deny 翻转即红。只断言放行侧（fail-open 缺省、
 *    豁免、完整三元组必过），绝不断言拒绝侧收紧——本检查只松不紧。
 * 3. 本文件只增断言不改生产语义；收紧需求一律记独立提案，不在此实现。
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseReviewTriplet } from '../chat/review-dispatch-triplet';
import {
  buildStalePlanHashHint,
  isStalePlanHash,
  normalizePlanHash,
  selectFrozenPlanHash,
} from '../issues/plan-hash-gate';
import { GATE_SPEC_FILES } from './gate-spec-registry';

/** 仓库根：server/src/gates → 上三级。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('no-tighten machine check（todo 5 loosen-only 审计）', () => {
  describe('清单完整性：16 个门禁单测文件全部存在', () => {
    it('清单共 16 项（删项即红）', () => {
      expect(GATE_SPEC_FILES.length).toBe(16);
    });
    for (const entry of GATE_SPEC_FILES) {
      it(`存在：${entry.file}`, () => {
        expect(fs.existsSync(path.join(REPO_ROOT, entry.file))).toBe(true);
      });
    }
  });

  describe('执行门禁哈希层：缺省即未武装（fail-open，放行侧锁定）', () => {
    it.each(['', '   ', '\n\t '])(
      'normalizePlanHash(%j) → null（空即未携带，不收紧）',
      (input) => {
        expect(normalizePlanHash(input)).toBeNull();
      },
    );
    it.each([null, undefined, 42, {}, []])(
      'normalizePlanHash(%j) → null（非字符串即未携带，不收紧）',
      (input) => {
        expect(normalizePlanHash(input)).toBeNull();
      },
    );
    it.each([
      [null, 'abcd1234'],
      ['abcd1234', null],
      [null, null],
      [undefined, undefined],
      ['', 'abcd1234'],
    ])('isStalePlanHash(%j, %j) → false（任一缺失即未武装，放行）', (a, b) => {
      expect(isStalePlanHash(a, b)).toBe(false);
    });
    it('双哈希一致 → false（匹配放行，不误拦）', () => {
      expect(isStalePlanHash('abcd1234', 'abcd1234')).toBe(false);
    });
    it('selectFrozenPlanHash([]/损坏账本) → null（未武装，放行）', () => {
      expect(selectFrozenPlanHash([])).toBeNull();
      expect(selectFrozenPlanHash([null, undefined, 'not-json{{{'])).toBeNull();
    });
    it('hint 同时命名期望/实际短哈希（todo 3 验收口径，不丢信息）', () => {
      const hint = buildStalePlanHashHint('expected1', 'actual22');
      expect(hint).toContain('expected1');
      expect(hint).toContain('actual22');
    });
  });

  describe('三元组门：完整三元组必过（allow 侧锁定，只拦触发不拦发布由 choke 点保证）', () => {
    const full =
      'R2 · v0.3#abcd1234 · expected: tmm_aaa,tmm_bbb 架构评审结论 APPROVE';
    it('完整三元组 → ok（放行侧翻转即红）', () => {
      const result = parseReviewTriplet(full);
      expect(result.ok).toBe(true);
      expect(result.triplet?.round).toBe(2);
      expect(result.triplet?.planVersion).toBe('v0.3');
      expect(result.triplet?.planHash).toBe('abcd1234');
      expect(result.triplet?.expected).toEqual(['tmm_aaa', 'tmm_bbb']);
    });
    it.each([
      ['缺 round', 'v0.3#abcd1234 · expected: tmm_aaa'],
      ['缺 version', 'R2 · #abcd1234 · expected: tmm_aaa'],
      ['缺 hash', 'R2 · v0.3 · expected: tmm_aaa'],
      ['缺 expected', 'R2 · v0.3#abcd1234'],
      ['空串', ''],
    ])(
      '%s → !ok（拒绝侧口径不变，不扩大拦截面：missing 非空）',
      (_label, text) => {
        const result = parseReviewTriplet(text);
        expect(result.ok).toBe(false);
        expect(result.missing?.length).toBeGreaterThan(0);
      },
    );
    it('null 输入 → !ok（不抛错，口径不变）', () => {
      expect(parseReviewTriplet(null).ok).toBe(false);
    });
  });
});
