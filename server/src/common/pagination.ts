/**
 * 分页归一化（列表端点唯一口径）与分页响应构造。
 *
 * 为什么抽出来：`normalizePage`/`normalizePageSize` 曾在 13 个 service/controller 里
 * 逐字复制（共 26 份），分页默认值与上限散落在各处——改一处漏一处就会让同一套
 * `page/pageSize` 契约在不同端点表现不一致（例如某端点允许 pageSize=500 打穿数据库）。
 *
 * 口径（与设计文档 09 篇 §2.2 一致）：
 * - `page`：从 1 起，缺省 1；非数字/NaN/小于 1 → 1；小数向下取整。
 * - `pageSize`：缺省 20，收敛到 `[1, 100]`；非数字/NaN → 20。
 *
 * 注意：本模块**只做归一化**，不做校验——非法值已在 DTO 层由 class-validator 拦成 400；
 * 这里的兜底针对的是「service 被内部调用/MCP 入参未过 DTO」的场景。
 */

/** 列表默认每页条数。 */
export const DEFAULT_PAGE_SIZE = 20;

/** 列表每页条数上限（防止无 teamId 等宽查询把库打穿）。 */
export const MAX_PAGE_SIZE = 100;

/** 页码归一：从 1 起，非法值回 1。 */
export function normalizePage(page?: number): number {
  const p = Number(page ?? 1);
  return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
}

/**
 * 每页条数归一：缺省 20，收敛到 `[1, MAX_PAGE_SIZE]`。
 *
 * @param pageSize - 原始值（可能来自 query 字符串转换后的 NaN）
 * @param max - 上限覆盖（默认 `MAX_PAGE_SIZE`；个别端点有更严格上限时传入）
 */
export function normalizePageSize(
  pageSize?: number,
  max: number = MAX_PAGE_SIZE,
): number {
  const ps = Number(pageSize ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(ps)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.floor(ps), 1), max);
}

/** 列表分页响应（全平台统一形状；`total` 恒为归一前的命中总数）。 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 构造分页响应。
 *
 * @param items - 当前页数据
 * @param total - 命中总数（不是当前页长度）
 * @param page - 归一后的页码（调用方应传 `normalizePage(...)` 的结果）
 * @param pageSize - 归一后的每页条数
 */
export function paginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  return { items, total, page, pageSize };
}

/** 空分页结果的快捷构造（短路分支用，避免每处手写四字段字面量）。 */
export function emptyPage<T>(
  page: number = 1,
  pageSize: number = DEFAULT_PAGE_SIZE,
): PaginatedResult<T> {
  return { items: [], total: 0, page, pageSize };
}

/** Prisma `skip`/`take` 参数（`skip` 只在有实际分页需求时算，避免 0 参与运算）。 */
export function pageToSkipTake(
  page: number,
  pageSize: number,
): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
