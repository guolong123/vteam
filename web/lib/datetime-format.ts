/**
 * 时间展示格式化（web 侧唯一口径）。
 *
 * 为什么抽出来：`formatTime` / `formatDate` 曾在 6 个页面里各自定义，且**同一语义
 * 两种实现、两种产物**：
 * - `HH:mm` 有的走 `getHours()` 手工补零，有的走 `toLocaleTimeString("zh-CN")`
 *   （后者在部分 locale/时区组合下会输出 `08:05` 与 `8:05` 不一致）；
 * - `YYYY-MM-DD HH:mm` 有三份逐字相同的实现，另有一份 `toLocaleDateString("zh-CN")`
 *   （同一页面里「日期」有两种排版，用户能看出来）。
 *
 * 口径（固定，不随浏览器 locale 漂移）：
 * - 无效/空值 → `fallback`（缺省 `'—'`；调用方可传 `''` 表示「不展示占位」）；
 * - `formatDateTime` → `YYYY-MM-DD HH:mm`（本地时区）；
 * - `formatDateOnly` → `YYYY-MM-DD`；
 * - `formatClockTime` → `HH:mm`（聊天气泡时间戳用）。
 *
 * 注意：这里刻意**不用** `toLocaleString`——SSR 与浏览器 locale 不一定一致，
 * 同一条消息在 hydration 前后可能变样。
 */

/** 日期时间格式化的公共选项。 */
export interface FormatTimeOptions {
  /** 无效/空值时的占位（缺省 `'—'`；传 `''` 则完全不显示）。 */
  fallback?: string;
}

/** 两位补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 解析 ISO 串 → Date；无效返回 null（统一入口，避免各处重复 `Number.isNaN`）。 */
function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `YYYY-MM-DD HH:mm`（本地时区）。
 *
 * @param iso - ISO 时间串；null/空/无效 → fallback
 * @param options - 见 {@link FormatTimeOptions}
 */
export function formatDateTime(
  iso: string | null | undefined,
  options: FormatTimeOptions = {},
): string {
  const fallback = options.fallback ?? "—";
  const d = parseDate(iso);
  if (!d) return fallback;
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/**
 * `YYYY-MM-DD`（本地时区）。
 *
 * @param iso - ISO 时间串；null/空/无效 → fallback
 * @param options - 见 {@link FormatTimeOptions}
 */
export function formatDateOnly(
  iso: string | null | undefined,
  options: FormatTimeOptions = {},
): string {
  const fallback = options.fallback ?? "—";
  const d = parseDate(iso);
  if (!d) return fallback;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * `HH:mm`（本地时区）——聊天气泡时间戳。
 *
 * @param iso - ISO 时间串；null/空/无效 → fallback（聊天场景缺省返回空串）
 * @param options - 见 {@link FormatTimeOptions}
 */
export function formatClockTime(
  iso: string | null | undefined,
  options: FormatTimeOptions = {},
): string {
  const fallback = options.fallback ?? "";
  const d = parseDate(iso);
  if (!d) return fallback;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
