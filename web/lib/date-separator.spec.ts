import { test, expect } from "@playwright/test";
import {
  localDateKey,
  dateSeparatorFlags,
  formatDateSeparatorLabel,
} from "./date-separator";

/**
 * chat-ux-hierarchy-and-streaming 复选框 6 · B3 跨天日期分隔纯逻辑（lib-unit）
 * =============================================
 * 纯逻辑侧证据：不渲染、不依赖 dev server、不依赖运行时区换算（夹具与断言都按本地日构造）。
 * 渲染侧断言在 e2e/session-unification.spec.ts 的「B3 跨天日期分隔与 B4 system 行降噪」describe。
 * 运行：`npx playwright test lib/date-separator.spec.ts --project=lib-unit`
 *
 * 契约：
 *  - localDateKey：本地日历日键（`YYYY-MM-DD`，月/日补零）；缺失、空串、不可解析 → null，不抛异常。
 *  - dateSeparatorFlags：长度与入参一致；仅当「当前条本地日键」与「上一个已知日键」都存在且不同时为 true；
 *    缺失/非法时间的条自身永远不产生分隔，也不清空已累积的日键（跨缺失行的跨天仍要分隔）。
 *  - formatDateSeparatorLabel：键 → `YYYY/MM/DD` 展示文案。
 */

/** 本地日历时间 → ISO：断言按本地日构造，跨不同时区运行仍指向同一本地日。 */
const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m).toISOString();

const row = (createdAt: string | null | undefined) => {
  const item: { createdAt?: string | null } = {};
  if (createdAt !== undefined) item.createdAt = createdAt;
  return item;
};

test("localDateKey 用本地日历日生成 YYYY-MM-DD 键", () => {
  expect(localDateKey(at(20, 10, 0))).toBe("2026-09-20");
  expect(localDateKey(at(20, 23, 58))).toBe("2026-09-20");
  expect(localDateKey(at(21, 0, 1))).toBe("2026-09-21");
  // 本地日翻转不看 UTC 日：23:58 与次日 00:01 在本地是两天
  expect(localDateKey(at(20, 23, 58))).not.toBe(localDateKey(at(21, 0, 1)));
});

test("localDateKey 对缺失/非法输入返回 null 且不抛异常", () => {
  expect(localDateKey(undefined)).toBeNull();
  expect(localDateKey(null)).toBeNull();
  expect(localDateKey("")).toBeNull();
  expect(localDateKey("not-a-date")).toBeNull();
  expect(localDateKey("2026-13-45")).toBeNull();
  expect(() => localDateKey("NaN")).not.toThrow();
});

test("单日列表零分隔", () => {
  const flags = dateSeparatorFlags([row(at(20, 10, 0)), row(at(20, 10, 1)), row(at(20, 21, 0))]);
  expect(flags).toEqual([false, false, false]);
  expect(dateSeparatorFlags([])).toEqual([]);
  // 全缺失/非法时间的列表同样零分隔
  expect(dateSeparatorFlags([row(undefined), row(""), row("not-a-date")])).toEqual([false, false, false]);
});

test("跨天恰好在交界条上插入一条分隔", () => {
  const flags = dateSeparatorFlags([
    row(at(20, 10, 0)),
    row(at(20, 23, 58)),
    row(at(21, 0, 1)),
    row(at(21, 0, 2)),
  ]);
  expect(flags).toEqual([false, false, true, false]);
});

test("多次跨天逐次插入，不重排、长度恒等于消息数", () => {
  const messages = [
    row(at(20, 10, 0)),
    row(at(21, 9, 0)),
    row(at(22, 9, 0)),
    row(at(22, 10, 0)),
    row(at(23, 9, 0)),
  ];
  const flags = dateSeparatorFlags(messages);
  expect(flags).toEqual([false, true, true, false, true]);
  expect(flags).toHaveLength(messages.length);
});

test("缺失/非法时间自身不分隔，也不抹掉跨天判定", () => {
  // 首条缺失 → 不在列表顶部插分隔
  expect(dateSeparatorFlags([row(undefined), row(at(20, 10, 0)), row(at(20, 10, 1))])).toEqual([
    false,
    false,
    false,
  ]);
  // 中间缺失 → 缺失条本身不分隔，但跨天仍然只在交界处插一条
  expect(dateSeparatorFlags([row(at(20, 23, 0)), row(undefined), row(at(21, 0, 30))])).toEqual([
    false,
    false,
    true,
  ]);
  expect(dateSeparatorFlags([row(at(20, 10, 0)), row("not-a-date"), row(at(21, 0, 30))])).toEqual([
    false,
    false,
    true,
  ]);
  // 同一天夹着缺失条 → 零分隔
  expect(dateSeparatorFlags([row(at(20, 10, 0)), row(""), row(at(20, 11, 0))])).toEqual([
    false,
    false,
    false,
  ]);
});

test("formatDateSeparatorLabel 输出 YYYY/MM/DD", () => {
  expect(formatDateSeparatorLabel("2026-09-20")).toBe("2026/09/20");
  expect(formatDateSeparatorLabel("2026-09-21")).toBe("2026/09/21");
  expect(formatDateSeparatorLabel("2026-10-01")).toBe("2026/10/01");
});
