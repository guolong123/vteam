import { test, expect } from "@playwright/test";
import { formatClockTime, formatDateOnly, formatDateTime } from "./datetime-format";

/**
 * web 时间展示唯一口径（lib-unit，纯逻辑：不渲染、不依赖后端）。
 *
 * 背景：`formatTime`/`formatDate` 曾在 6 个页面各自定义，同一语义有两种实现与两种产物
 * （手工补零 vs `toLocaleTimeString`；`YYYY-MM-DD HH:mm` vs `toLocaleDateString`）。
 * 本套把口径钉死在 `lib/datetime-format.ts`，防止再散回去。
 *
 * 断言一律用本地时区构造（`new Date(y, m, d, h, min)`），避免运行时区影响。
 */

/** 构造本地时区 ISO 串（测试意图：断言的是格式化，不是时区换算）。 */
function localIso(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
}

test.describe("formatDateTime（YYYY-MM-DD HH:mm）", () => {
  test("补零：月/日/时/分皆两位", () => {
    expect(formatDateTime(localIso(2026, 3, 7, 8, 5))).toBe("2026-03-07 08:05");
  });

  test("两位数原样", () => {
    expect(formatDateTime(localIso(2026, 11, 21, 20, 46))).toBe("2026-11-21 20:46");
  });

  test("空值/null/undefined → 缺省占位 —", () => {
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });

  test("不可解析串 → 占位（不抛、不回显原串）", () => {
    expect(formatDateTime("not-a-date")).toBe("—");
  });

  test("fallback 可覆盖（调用方按场景换占位）", () => {
    expect(formatDateTime(null, { fallback: "" })).toBe("");
    expect(formatDateTime("bad", { fallback: "未知" })).toBe("未知");
  });
});

test.describe("formatDateOnly（YYYY-MM-DD）", () => {
  test("补零", () => {
    expect(formatDateOnly(localIso(2026, 1, 2))).toBe("2026-01-02");
  });

  test("非法值 → 占位", () => {
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateOnly("bad")).toBe("—");
  });

  test("不含时间部分", () => {
    expect(formatDateOnly(localIso(2026, 12, 31, 23, 59))).toBe("2026-12-31");
  });
});

test.describe("formatClockTime（HH:mm）", () => {
  test("补零", () => {
    expect(formatClockTime(localIso(2026, 6, 1, 9, 3))).toBe("09:03");
  });

  test("午夜 → 00:00（不是 24:00 / 12:00）", () => {
    expect(formatClockTime(localIso(2026, 6, 1, 0, 0))).toBe("00:00");
  });

  test("聊天场景缺省占位为空串（不塞 —）", () => {
    expect(formatClockTime(null)).toBe("");
    expect(formatClockTime("bad")).toBe("");
  });

  test("fallback 可覆盖", () => {
    expect(formatClockTime(null, { fallback: "--:--" })).toBe("--:--");
  });
});
