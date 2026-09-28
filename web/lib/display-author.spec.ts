import { test, expect } from "@playwright/test";
import { isRawSenderId, resolveDisplayAuthor, RAW_SENDER_ID_PATTERN } from "./display-author";

/**
 * display-author · B9 裸 id 兜底纯逻辑门（lib-unit）
 * =============================================
 * chat-ux-hierarchy-and-streaming 复选框 7 的页面侧契约：
 * 解析链路上裸 id（a_/tmm_/ta_）一律不可作为可见作者名，
 * 全部落空时返回 undefined（由展示组件回落角色标签）。
 *
 * 运行：`npx playwright test lib/display-author.spec.ts --project=lib-unit`
 * 失败语义：改动前 session 页面用 `?? msg.senderId` 兜底 → 本模块不存在，在此红。
 */

test("B9 裸 id 判定：三类 id 命中、非 id 串与非字符串不误伤", () => {
  expect(isRawSenderId("a_developer")).toBe(true);
  expect(isRawSenderId("a_0000000001")).toBe(true);
  expect(isRawSenderId("tmm_404")).toBe(true);
  expect(isRawSenderId("ta_99")).toBe(true);
  // 非 id：角色名、别名、空串、非字符串、含大写/连字符的 id 形态
  expect(isRawSenderId("Dev-1")).toBe(false);
  expect(isRawSenderId("开发者")).toBe(false);
  expect(isRawSenderId("")).toBe(false);
  expect(isRawSenderId("a_")).toBe(false);
  expect(isRawSenderId(null)).toBe(false);
  expect(isRawSenderId(undefined)).toBe(false);
  expect(isRawSenderId(42)).toBe(false);
  // 正则与计划 QA 扫描口径同族（全串锚定，避免把 "beta_id" 这类子串当 id）
  expect(RAW_SENDER_ID_PATTERN.test("tmm_5")).toBe(true);
  expect(RAW_SENDER_ID_PATTERN.test("meta_index")).toBe(false);
});

test("B9 解析顺序：首个可用候选胜出，裸 id 候选被跳过而不是透传", () => {
  expect(resolveDisplayAuthor(["Dev-1", "a_developer"])).toBe("Dev-1");
  // 第一候选是裸实例 id → 跳过，继续取第二候选（改动前页面直接取 senderId）
  expect(resolveDisplayAuthor(["ta_99", "Arch-1"])).toBe("Arch-1");
  expect(resolveDisplayAuthor([undefined, null, "", "   ", "Test-1"])).toBe("Test-1");
  expect(resolveDisplayAuthor(["  Dev-1  "])).toBe("Dev-1");
});

test("B9 全部落空：返回 undefined 而不是裸 id 或空串", () => {
  expect(resolveDisplayAuthor([])).toBeUndefined();
  expect(resolveDisplayAuthor([undefined, null])).toBeUndefined();
  expect(resolveDisplayAuthor(["", "   "])).toBeUndefined();
  // 改动前页面兜底链 `?? msg.senderId` 会把这三个值直接放进可见文本
  expect(resolveDisplayAuthor(["a_plan"])).toBeUndefined();
  expect(resolveDisplayAuthor(["tmm_404"])).toBeUndefined();
  expect(resolveDisplayAuthor(["ta_99", "a_ghost01", "tmm_7"])).toBeUndefined();
});
