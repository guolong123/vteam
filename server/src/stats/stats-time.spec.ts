import {
  addDays,
  bucketKeyOf,
  bucketLabelOf,
  diffDays,
  enumerateBucketKeys,
  localDayOf,
  localDayStartUtc,
  mondayOf,
  resolveWindow,
  todayLocal,
} from './stats-time';
import { STATS_TZ_OFFSET_MS } from './stats.constants';

/**
 * stats-time 纯函数测试（口径基座）。
 *
 * 这一层错了，上面的所有统计都会错，而且错得很隐蔽（数字看起来「合理」但对不上）。
 * 重点覆盖：+08:00 日切、周一起周、含头含尾窗口、桶枚举连续性。
 */
describe('stats-time（时区与窗口口径）', () => {
  describe('localDayOf / localDayStartUtc（+08:00 日切）', () => {
    it('UTC 16:00 = 次日 00:00(+08:00) → 应归到**次日**', () => {
      // 2026-10-29T16:00:00Z = 2026-10-30T00:00:00+08:00
      const when = new Date('2026-10-29T16:00:00.000Z');
      expect(localDayOf(when)).toBe('2026-10-30');
    });

    it('UTC 15:59:59 = 当日 23:59:59(+08:00) → 仍归当日', () => {
      const when = new Date('2026-10-29T15:59:59.000Z');
      expect(localDayOf(when)).toBe('2026-10-29');
    });

    it('localDayStartUtc 是往返一致：day → 时刻 → day', () => {
      for (const day of [
        '2026-01-01',
        '2026-02-28',
        '2026-10-30',
        '2026-12-31',
      ]) {
        expect(localDayOf(localDayStartUtc(day))).toBe(day);
      }
    });

    it('localDayStartUtc 结果确实是该日 00:00:00.000(+08:00)（UTC 前一天 16:00）', () => {
      const start = localDayStartUtc('2026-10-30');
      expect(start.toISOString()).toBe('2026-10-29T16:00:00.000Z');
    });

    it('不依赖运行环境 TZ：无论本机时区如何，同一时刻归到同一日', () => {
      // 用一个「若按 UTC 会被归到前一天」的时刻，验证固定偏移生效
      const when = new Date('2026-10-29T17:30:00.000Z');
      expect(localDayOf(when)).toBe('2026-10-30');
      expect(STATS_TZ_OFFSET_MS).toBe(8 * 3600 * 1000);
    });
  });

  describe('addDays / diffDays', () => {
    it('跨月边界正确', () => {
      expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
      expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    });

    it('跨年边界正确', () => {
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
      expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    });

    it('闰年 2 月正确（2028 是闰年）', () => {
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
      expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
    });

    it('diffDays 对称', () => {
      expect(diffDays('2026-10-01', '2026-10-30')).toBe(29);
      expect(diffDays('2026-10-30', '2026-10-01')).toBe(-29);
    });
  });

  describe('resolveWindow（含头含尾）', () => {
    it('近 7 天 = 今天在内共 7 个日历日', () => {
      const w = resolveWindow('2026-10-30', 7);
      expect(w.from).toBe('2026-10-24');
      expect(w.to).toBe('2026-10-30');
      expect(w.days).toBe(7);
      // 含头含尾 ⇒ diffDays(from,to) = days - 1
      expect(diffDays(w.from, w.to)).toBe(w.days - 1);
    });

    it('近 30 天边界正确', () => {
      const w = resolveWindow('2026-10-30', 30);
      expect(w.from).toBe('2026-10-01');
      expect(w.to).toBe('2026-10-30');
    });

    it('单天窗口 from == to', () => {
      const w = resolveWindow('2026-10-30', 1);
      expect(w.from).toBe('2026-10-30');
      expect(w.to).toBe('2026-10-30');
    });

    it('to 缺省 = 今天（本地日）', () => {
      const w = resolveWindow(undefined, 7);
      expect(w.to).toBe(todayLocal());
    });
  });

  describe('mondayOf / bucketKeyOf（ISO 周，周一起）', () => {
    it('2026-10-30 是周五 → 周一为 2026-10-26', () => {
      expect(mondayOf('2026-10-30')).toBe('2026-10-26');
    });

    it('周一自身 → 返回自己', () => {
      expect(mondayOf('2026-10-26')).toBe('2026-10-26');
    });

    it('周日 → 回退到上一个周一（不是当天）', () => {
      // 2026-11-01 是周日，其所属 ISO 周从 2026-10-26 起
      expect(mondayOf('2026-11-01')).toBe('2026-10-26');
    });

    it('bucketKeyOf：day 原样、week 取周一、month 取 YYYY-MM', () => {
      expect(bucketKeyOf('2026-10-30', 'day')).toBe('2026-10-30');
      expect(bucketKeyOf('2026-10-30', 'week')).toBe('2026-10-26');
      expect(bucketKeyOf('2026-10-30', 'month')).toBe('2026-10');
    });
  });

  describe('bucketLabelOf（横轴短标签）', () => {
    it('day → MM-DD', () => {
      expect(bucketLabelOf('2026-10-30', 'day')).toBe('10-30');
    });

    it('week → MM/DD（周一日期）', () => {
      expect(bucketLabelOf('2026-10-26', 'week')).toBe('10/26');
    });

    it('month → 数字月（不补零）', () => {
      expect(bucketLabelOf('2026-10', 'month')).toBe('10 月');
      expect(bucketLabelOf('2026-03', 'month')).toBe('3 月');
    });
  });

  describe('enumerateBucketKeys（桶枚举：横轴必须连续）', () => {
    it('30 天日粒度 → 30 个桶', () => {
      const keys = enumerateBucketKeys('2026-10-01', '2026-10-30', 'day');
      expect(keys).toHaveLength(30);
      expect(keys[0]).toBe('2026-10-01');
      expect(keys[keys.length - 1]).toBe('2026-10-30');
    });

    it('30 天周粒度 → 按周一起点的桶（首桶可能不满 7 天）', () => {
      const keys = enumerateBucketKeys('2026-10-01', '2026-10-30', 'week');
      // 2026-10-01 是周四，其 ISO 周起点 2026-09-28
      expect(keys[0]).toBe('2026-09-28');
      // 最后一个桶含 2026-10-30（周五），周起点 2026-10-26
      expect(keys[keys.length - 1]).toBe('2026-10-26');
      expect(keys.length).toBeGreaterThanOrEqual(4);
    });

    it('跨月窗口的月粒度 → 覆盖两个月', () => {
      const keys = enumerateBucketKeys('2026-09-15', '2026-10-30', 'month');
      expect(keys).toEqual(['2026-09', '2026-10']);
    });

    it('单天窗口 → 1 个桶', () => {
      expect(enumerateBucketKeys('2026-10-30', '2026-10-30', 'day')).toEqual([
        '2026-10-30',
      ]);
    });

    it('桶键无重复（Set 语义）', () => {
      const keys = enumerateBucketKeys('2026-09-02', '2026-10-30', 'week');
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
