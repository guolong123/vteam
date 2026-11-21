import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  emptyPage,
  normalizePage,
  normalizePageSize,
  pageToSkipTake,
  paginated,
} from './pagination';

describe('common/pagination（列表分页唯一口径）', () => {
  describe('normalizePage', () => {
    it('缺省 → 1', () => {
      expect(normalizePage()).toBe(1);
      expect(normalizePage(undefined)).toBe(1);
    });

    it('合法值原样（小数向下取整）', () => {
      expect(normalizePage(1)).toBe(1);
      expect(normalizePage(7)).toBe(7);
      expect(normalizePage(3.9)).toBe(3);
    });

    it('非法值（0/负数/NaN/Infinity）→ 1', () => {
      expect(normalizePage(0)).toBe(1);
      expect(normalizePage(-5)).toBe(1);
      expect(normalizePage(NaN)).toBe(1);
      expect(normalizePage(Infinity)).toBe(1);
    });

    it('数字字符串按数值解释（query 未转换时的兜底）', () => {
      expect(normalizePage('4' as unknown as number)).toBe(4);
    });
  });

  describe('normalizePageSize', () => {
    it('缺省 → 20', () => {
      expect(normalizePageSize()).toBe(DEFAULT_PAGE_SIZE);
      expect(normalizePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('低于下限收敛到 1', () => {
      expect(normalizePageSize(0)).toBe(1);
      expect(normalizePageSize(-3)).toBe(1);
    });

    it('高于上限收敛到 100', () => {
      expect(normalizePageSize(101)).toBe(MAX_PAGE_SIZE);
      expect(normalizePageSize(10000)).toBe(MAX_PAGE_SIZE);
    });

    it('区间内原样（小数向下取整）', () => {
      expect(normalizePageSize(1)).toBe(1);
      expect(normalizePageSize(100)).toBe(100);
      expect(normalizePageSize(20.8)).toBe(20);
    });

    it('NaN/Infinity → 默认值（不是 1，也不是上限）', () => {
      expect(normalizePageSize(NaN)).toBe(DEFAULT_PAGE_SIZE);
      expect(normalizePageSize(Infinity)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('可覆盖上限（个别端点更严格）', () => {
      expect(normalizePageSize(50, 20)).toBe(20);
      expect(normalizePageSize(10, 20)).toBe(10);
    });
  });

  describe('分页响应构造', () => {
    it('paginated 四字段齐全', () => {
      expect(paginated(['a', 'b'], 42, 2, 2)).toEqual({
        items: ['a', 'b'],
        total: 42,
        page: 2,
        pageSize: 2,
      });
    });

    it('emptyPage 缺省 page/pageSize 与归一口径一致', () => {
      expect(emptyPage()).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      });
    });

    it('emptyPage 透传调用方归一后的分页值', () => {
      expect(emptyPage(3, 50)).toEqual({
        items: [],
        total: 0,
        page: 3,
        pageSize: 50,
      });
    });

    it('pageToSkipTake 与 page/pageSize 对齐', () => {
      expect(pageToSkipTake(1, 20)).toEqual({ skip: 0, take: 20 });
      expect(pageToSkipTake(3, 20)).toEqual({ skip: 40, take: 20 });
    });
  });
});
