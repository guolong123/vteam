import { test, expect } from "@playwright/test";
import {
  MESSAGE_GROUP_MAX_GAP_MS,
  isGroupedWithPrevious,
} from "./message-grouping";

/**
 * chat-ux-hierarchy-and-streaming 复选框 5 · B2 连续同发送者分组谓词（lib-unit）
 * =============================================
 * 纯逻辑侧边界证据：不渲染、不依赖 dev server。渲染侧断言在
 * e2e/session-unification.spec.ts 的「B2 连续同发送者消息复用身份栏」describe。
 * 运行：`npx playwright test lib/message-grouping.spec.ts --project=lib-unit`
 */

const T = "2026-09-20T10:00:00.000Z";

function msg(
  senderType: string,
  senderId: string | null | undefined,
  createdAt: string | null | undefined,
) {
  const m: Record<string, unknown> = { senderType };
  if (senderId !== undefined) m.senderId = senderId;
  if (createdAt !== undefined) m.createdAt = createdAt;
  return m;
}

const agent = (senderId: string | null | undefined, createdAt: string | null | undefined) =>
  msg("agent", senderId, createdAt);

test("分组边界常量为 5 分钟毫秒数", () => {
  expect(MESSAGE_GROUP_MAX_GAP_MS).toBe(5 * 60 * 1000);
});

test("首条与非 agent 邻居不分组", () => {
  expect(isGroupedWithPrevious(undefined, agent("a_1", T))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", T), msg("user", "u_1", T))).toBe(false);
  expect(isGroupedWithPrevious(msg("user", "u_1", T), agent("a_1", T))).toBe(false);
  expect(isGroupedWithPrevious(msg("system", null, T), agent("a_1", T))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", T), msg("system", null, T))).toBe(false);
  expect(isGroupedWithPrevious(msg("external", "ch_1", T), agent("a_1", T))).toBe(false);
});

test("同 agent 连续三条：第 2/3 条分组", () => {
  const first = agent("a_1", T);
  const second = agent("a_1", "2026-09-20T10:01:00.000Z");
  const third = agent("a_1", "2026-09-20T10:02:00.000Z");
  expect(isGroupedWithPrevious(first, second)).toBe(true);
  expect(isGroupedWithPrevious(second, third)).toBe(true);
  expect(isGroupedWithPrevious(first, third)).toBe(true);
  expect(isGroupedWithPrevious(third, first)).toBe(true);
});

test("不同 sender 或空/缺失 senderId 不分组", () => {
  const prev = agent("a_1", T);
  expect(isGroupedWithPrevious(prev, agent("a_2", "2026-09-20T10:01:00.000Z"))).toBe(false);
  expect(isGroupedWithPrevious(agent("", T), agent("a_1", "2026-09-20T10:01:00.000Z"))).toBe(false);
  expect(isGroupedWithPrevious(agent(null, T), agent("a_1", "2026-09-20T10:01:00.000Z"))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", T), agent("", "2026-09-20T10:01:00.000Z"))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", T), agent(null, "2026-09-20T10:01:00.000Z"))).toBe(false);
});

test("间隔恰好 5 分钟分组，5 分钟 + 1 毫秒不分组", () => {
  expect(isGroupedWithPrevious(agent("a_1", T), agent("a_1", "2026-09-20T10:05:00.000Z"))).toBe(true);
  expect(isGroupedWithPrevious(agent("a_1", T), agent("a_1", "2026-09-20T10:05:00.001Z"))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", T), agent("a_1", "2026-09-20T10:04:59.999Z"))).toBe(true);
});

test("本地日历日不同（跨日）不分组，即使间隔只有 3 分钟", () => {
  const beforeMidnight = new Date(2026, 8, 20, 23, 58, 0, 0).toISOString();
  const afterMidnight = new Date(2026, 8, 21, 0, 1, 0, 0).toISOString();
  expect(isGroupedWithPrevious(agent("a_1", beforeMidnight), agent("a_1", afterMidnight))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", afterMidnight), agent("a_1", afterMidnight))).toBe(true);
  expect(
    isGroupedWithPrevious(
      agent("a_1", new Date(2026, 8, 21, 0, 1, 0, 0).toISOString()),
      agent("a_1", new Date(2026, 8, 21, 0, 5, 0, 0).toISOString()),
    ),
  ).toBe(true);
});

test("createdAt 缺失或不可解析时不分组", () => {
  expect(isGroupedWithPrevious(agent("a_1", T), agent("a_1", undefined))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", undefined), agent("a_1", T))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", T), agent("a_1", "not-a-date"))).toBe(false);
  expect(isGroupedWithPrevious(agent("a_1", ""), agent("a_1", T))).toBe(false);
});
