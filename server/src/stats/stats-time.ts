import { STATS_TZ_OFFSET_MS } from './stats.constants';
import type { StatsGranularity } from './stats.constants';

/**
 * 统计窗口的时间工具（**纯函数，零 IO**，单测直接覆盖）。
 *
 * 全部日期一律按 **Asia/Shanghai 固定 +08:00 偏移**做日切——不用 UTC、不用服务器本地时区。
 * 理由：服务器时区随部署环境漂移（容器常见 TZ=UTC），一旦统计口径跟着漂，
 * 同一个「日」在两个部署上就是两个数字。固定偏移是唯一能让数字跨环境稳定的做法。
 *
 * 「本地日历日」在本文件里指 `YYYY-MM-DD` 字符串；「本地时刻」指该日 00:00:00.000+08:00
 * 对应的绝对时间（`Date`）。两者转换即 `localDayStartUtc` / `localDayOf`。
 */

/** 一天的毫秒数。 */
const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * 绝对时刻 → 该时刻所属的**本地日历日**（YYYY-MM-DD）。
 *
 * 做法：先加偏移把「本地时刻」映射成 UTC 字段，再用 UTC 取值方法读出年月日——
 * 等价于「按 +08:00 看这一天的日期」，且完全不受运行环境 TZ 影响。
 */
export function localDayOf(when: Date): string {
  const shifted = new Date(when.getTime() + STATS_TZ_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** 本地日历日 → 该日 00:00:00.000(+08:00) 的绝对时刻。 */
export function localDayStartUtc(day: string): Date {
  const [y, m, d] = day.split('-').map((x) => Number(x));
  // Date.UTC 得到「把本地日当作 UTC 日」的 00:00，再减去偏移 ⇒ 真正的本地 00:00 绝对时刻。
  return new Date(Date.UTC(y, m - 1, d) - STATS_TZ_OFFSET_MS);
}

/** 本地日历日 + n 天（负数即前移）。 */
export function addDays(day: string, n: number): string {
  return localDayOf(new Date(localDayStartUtc(day).getTime() + n * DAY_MS));
}

/** 两个本地日历日相差的天数（`b - a`）。 */
export function diffDays(a: string, b: string): number {
  return Math.round(
    (localDayStartUtc(b).getTime() - localDayStartUtc(a).getTime()) / DAY_MS,
  );
}

/** 今天的本地日历日。 */
export function todayLocal(now: Date = new Date()): string {
  return localDayOf(now);
}

/**
 * 解析窗口：`to`（缺省今天）+ `days` ⇒ `[from, to]`（**两端都含**）。
 *
 * 「含头含尾」而非「含头不含尾」：运营者说「近 7 天」预期是**今天在内共 7 天**
 * （昨天+前天+…+今天共 7 个日历日），不是「含今天不含 7 天前」。设计文档已定此口径。
 */
export function resolveWindow(
  to: string | undefined,
  days: number,
): { from: string; to: string; days: number } {
  const end = to ?? todayLocal();
  const start = addDays(end, -(days - 1));
  return { from: start, to: end, days };
}

/**
 * 时间桶键与展示标签。
 *
 * - day：键 = 日期本身；标签 `10-30`；
 * - week：键 = 该周**周一**日期（ISO 周，周一为周起）；标签 `10/26`；
 * - month：键 = `YYYY-MM`；标签 `10 月`。
 */
export function bucketKeyOf(day: string, g: StatsGranularity): string {
  if (g === 'day') {
    return day;
  }
  if (g === 'week') {
    return mondayOf(day);
  }
  return day.slice(0, 7);
}

/** 某日所属 ISO 周的周一日期。 */
export function mondayOf(day: string): string {
  const d = new Date(localDayStartUtc(day).getTime() + STATS_TZ_OFFSET_MS);
  const wd = d.getUTCDay(); // 0=周日
  const back = (wd + 6) % 7; // 周日回退 6 天，周一 0 天
  return addDays(day, -back);
}

/** 桶键 → 横轴短标签。 */
export function bucketLabelOf(key: string, g: StatsGranularity): string {
  if (g === 'day') {
    return key.slice(5); // 10-30
  }
  if (g === 'week') {
    return `${key.slice(5, 7)}/${key.slice(8, 10)}`; // 10/26
  }
  return `${Number(key.slice(5, 7))} 月`;
}

/**
 * 枚举窗口内**全部**桶键（含无数据的桶）。
 *
 * 为什么必须枚举而不是「有数据才出桶」：趋势图的横轴必须连续，
 * 缺失的桶要落成 0 而不是被跳过（否则一段停产的空档会在图上被压成「瞬移」，
 * 让运营者误判为「这几天也在产出」）。这是统计图表的常见坑。
 */
export function enumerateBucketKeys(
  from: string,
  to: string,
  g: StatsGranularity,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const total = diffDays(from, to);
  for (let i = 0; i <= total; i++) {
    const key = bucketKeyOf(addDays(from, i), g);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}
